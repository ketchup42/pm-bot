import { MarketSide } from '../../../../market/side.js';
import { safeToNum } from '../../../../utils.js';
import {
    DOGE_BASELINE_DEFAULT_TRADE_VALUE,
    DOGE_BASELINE_MODES,
    DOGE_BASELINE_STRATEGY,
    createDogeBaselineEntrySettings,
    type DogeBaselineEntrySettings,
    type DogeBaselineEntryModeSettings,
    type DogeBaselineModeName,
} from '../../events/strategy/doge-baseline/DogeBaselineConfig.js';
import {
    DogeBaselineModel,
    DogeBaselinePricePoint,
    getDogeBaselineFrameStartDeviationBps,
    makeDogeBaselineFeaturesFromPrices,
    predictDogeBaseline,
} from '../../events/strategy/doge-baseline/DogeBaselineModel.js';
import {
    calculateDogeBaselineEntryLimit,
    canRetryDogeBaselineEmergencyExit,
    type DogeBaselineEmergencyExitConfig,
    evaluateDogeBaselineEmergencyExit,
    getDogeBaselineEmergencyExitConfig,
    selectDogeBaselineExecutableEntryWithReason,
    selectDogeBaselineEntry,
    type DogeBaselineEntryRejectionReason,
} from '../../events/strategy/doge-baseline/DogeBaselineDecision.js';
import {
    ReplayDecision,
    ReplayExecutionConfig,
    ReplayFill,
    ReplayResult,
    ReplayStrategy,
    ReplayStrategyContext,
    runReplay,
} from '../replay.js';
import { HistoryFrameV3 } from '../../history/history_frame.js';
import type { DogeBaselineRuntimeConfig } from '../../events/strategy/doge-baseline/artifacts.js';

interface DogeBaselineReplayState {
    prices: DogeBaselinePricePoint[];
    evaluatedModes: Set<DogeBaselineModeName>;
    entered: boolean;
    exited: boolean;
    side: MarketSide | undefined;
    adverseSince: number | undefined;
    nextEmergencyExitAttemptTimestamp: number | undefined;
}

export interface DogeBaselineReplayStrategyConfig extends Partial<DogeBaselineRuntimeConfig> {
    minimumOrderValue?: number;
    tradeValue?: number;
    executableEntry?: boolean;
}

export interface DogeBaselineReplayResults {
    combined: ReplayResult;
    modes: Record<DogeBaselineModeName, ReplayResult>;
    entryDecisions: DogeBaselineEntryDecisionMetricsByMode;
}

export interface DogeBaselineEntryDecisionMetrics {
    evaluated: number;
    accepted: number;
    rejectedByReason: Partial<Record<DogeBaselineEntryRejectionReason, number>>;
}

export type DogeBaselineEntryDecisionMetricsByMode = Record<DogeBaselineModeName, DogeBaselineEntryDecisionMetrics>;

export function runDogeBaselineReplay(
    frames: readonly HistoryFrameV3[],
    model: Readonly<DogeBaselineModel>,
    config: ReplayExecutionConfig,
    strategyConfig: Readonly<DogeBaselineReplayStrategyConfig> = {},
): DogeBaselineReplayResults {
    const entry = strategyConfig.entry ?? createDogeBaselineEntrySettings();
    const strategies = Object.fromEntries(DOGE_BASELINE_MODES.map(mode => [
        mode.name,
        new DogeBaselineReplayStrategy(model, {
            ...strategyConfig,
            entry: createDogeBaselineSingleModeEntrySettings(entry, mode.name),
        }),
    ])) as Record<DogeBaselineModeName, DogeBaselineReplayStrategy>;
    const modes = Object.fromEntries(DOGE_BASELINE_MODES.map(mode => [
        mode.name,
        runReplay(frames, strategies[mode.name], config),
    ])) as Record<DogeBaselineModeName, ReplayResult>;
    const combinedStrategy = new DogeBaselineReplayStrategy(model, strategyConfig);
    return {
        combined: runReplay(frames, combinedStrategy, config),
        modes,
        entryDecisions: Object.fromEntries(DOGE_BASELINE_MODES.map(mode => [
            mode.name,
            strategies[mode.name].getEntryDecisionMetrics()[mode.name],
        ])) as DogeBaselineEntryDecisionMetricsByMode,
    };
}

export class DogeBaselineReplayStrategy implements ReplayStrategy {
    public readonly name: string;
    private readonly states = new Map<number, DogeBaselineReplayState>();
    private readonly entryConfig: Readonly<DogeBaselineEntrySettings>;
    private readonly emergencyExitEnabled: boolean;
    private readonly emergencyExitConfig: Readonly<DogeBaselineEmergencyExitConfig>;
    private readonly minimumOrderValue: number | undefined;
    private readonly tradeValue: number;
    private readonly executableEntry: boolean;
    private readonly entryDecisionMetrics: DogeBaselineEntryDecisionMetricsByMode = Object.fromEntries(
        DOGE_BASELINE_MODES.map(mode => [mode.name, {
            evaluated: 0,
            accepted: 0,
            rejectedByReason: {},
        }]),
    ) as DogeBaselineEntryDecisionMetricsByMode;

    public constructor(
        private readonly model: Readonly<DogeBaselineModel>,
        config: Readonly<DogeBaselineReplayStrategyConfig> = {},
    ) {
        this.entryConfig = config.entry ?? createDogeBaselineEntrySettings();
        this.emergencyExitEnabled = config.emergencyExitEnabled ?? true;
        this.emergencyExitConfig = config.emergencyExitConfig ?? getDogeBaselineEmergencyExitConfig();
        this.minimumOrderValue = config.minimumOrderValue;
        this.tradeValue = config.tradeValue ?? DOGE_BASELINE_DEFAULT_TRADE_VALUE;
        this.executableEntry = config.executableEntry ?? true;
        const enabledModes = DOGE_BASELINE_MODES.filter(mode => this.entryConfig.modes[mode.name].enabled).map(mode => mode.name);
        this.name = enabledModes.length === DOGE_BASELINE_MODES.length
            ? DOGE_BASELINE_STRATEGY
            : `${DOGE_BASELINE_STRATEGY}-${enabledModes.join('-')}`;
    }

    public decide(context: Readonly<ReplayStrategyContext>): ReplayDecision {
        const state = this.getState(context.frame.start_time);
        const pricePoint = context.snapshot.indicator_prices[context.frame.coin];
        if (pricePoint && state.prices.at(-1)?.timestamp !== pricePoint.timestamp) state.prices.push(pricePoint);

        const emergencyExit = this.emergencyExit(context, state);
        if (emergencyExit) return emergencyExit;
        if (state.entered || state.exited) return this.hold('position_already_decided');

        const elapsedMs = context.snapshot.timestamp - context.frame.start_time * 1_000;
        for (const mode of DOGE_BASELINE_MODES) {
            const modeConfig = this.entryConfig.modes[mode.name];
            if (!modeConfig.enabled) continue;
            if (elapsedMs < mode.offsetMs || state.evaluatedModes.has(mode.name)) continue;
            state.evaluatedModes.add(mode.name);
            const features = makeDogeBaselineFeaturesFromPrices(
                context.frame.coin_frame_start_price,
                context.frame.start_time * 1_000,
                state.prices,
                mode.offsetMs,
                mode.lookbacksMs,
            );
            if (!features) continue;
            const upProbability = predictDogeBaseline(this.model.modes[mode.name], features);
            const deviationBps = getDogeBaselineFrameStartDeviationBps(features);
            const decision = this.entry(context, mode.name, upProbability, deviationBps, modeConfig);
            if (decision) {
                return decision;
            }
        }
        return this.hold('no_profitable_signal');
    }

    public onFill(fill: Readonly<ReplayFill>): void {
        if (fill.status === 'rejected') return;
        const state = this.getState(fill.frame_start);
        if (fill.action === 'buy') {
            state.entered = true;
            state.side = fill.side;
        } else if (fill.status === 'filled') state.exited = true;
    }

    public getEntryDecisionMetrics(): DogeBaselineEntryDecisionMetricsByMode {
        return Object.fromEntries(DOGE_BASELINE_MODES.map(mode => {
            const metrics = this.entryDecisionMetrics[mode.name];
            return [mode.name, {
                ...metrics,
                rejectedByReason: { ...metrics.rejectedByReason },
            }];
        })) as DogeBaselineEntryDecisionMetricsByMode;
    }

    private entry(
        context: Readonly<ReplayStrategyContext>,
        mode: DogeBaselineModeName,
        upProbability: number,
        deviationBps: number,
        modeConfig: Readonly<DogeBaselineEntryModeSettings>,
    ): ReplayDecision | undefined {
        const prices = {
            upAsk: safeToNum(context.snapshot.up.asks[0]?.price, Number.NaN),
            downAsk: safeToNum(context.snapshot.down.asks[0]?.price, Number.NaN),
            feesEnabled: context.frame.market_data.fees_enabled,
            takerBaseFee: context.frame.market_data.taker_base_fee,
        };
        if (this.executableEntry) {
            const metrics = this.entryDecisionMetrics[mode];
            metrics.evaluated++;
            const selection = selectDogeBaselineExecutableEntryWithReason(upProbability, deviationBps, prices, {
                upAsks: context.snapshot.up.asks,
                downAsks: context.snapshot.down.asks,
                tickSize: context.frame.market_data.tick_size,
                minimumOrderValue: this.minimumOrderValue ?? 0,
            }, modeConfig, this.tradeValue, context.cash);
            if (selection.candidate === undefined) {
                const rejected = metrics.rejectedByReason;
                rejected[selection.reason] = (rejected[selection.reason] ?? 0) + 1;
                return undefined;
            }
            metrics.accepted++;
            const { candidate } = selection;
            return {
                action: 'buy',
                reason_code: `${mode}_entry`,
                order: {
                    action: 'buy', side: candidate.side,
                    quantity: candidate.requestedQuantity, limit_price: candidate.limitPrice,
                },
            };
        }
        const candidate = selectDogeBaselineEntry(upProbability, deviationBps, prices, modeConfig);
        if (!candidate) return undefined;
        const limitPrice = calculateDogeBaselineEntryLimit(candidate.ask, context.frame.market_data.tick_size);
        const quantity = this.tradeValue / limitPrice;
        return {
            action: 'buy',
            reason_code: `${mode}_entry`,
            order: {
                action: 'buy',
                side: candidate.side,
                quantity,
                limit_price: limitPrice,
            },
        };
    }

    private emergencyExit(
        context: Readonly<ReplayStrategyContext>,
        state: DogeBaselineReplayState,
    ): ReplayDecision | undefined {
        if (!this.emergencyExitEnabled || !state.entered || state.exited || state.side === undefined ||
            context.frame.coin_frame_start_price === undefined || context.snapshot.coin_price === undefined) return undefined;
        const quantity = state.side === 'up' ? context.up_quantity : context.down_quantity;
        if (quantity <= 0) return undefined;
        const signal = evaluateDogeBaselineEmergencyExit({
            side: state.side,
            frameStartPrice: context.frame.coin_frame_start_price,
            currentPrice: context.snapshot.coin_price,
            timestamp: context.snapshot.timestamp,
            frameEndTimestamp: context.frame.end_time * 1_000,
            adverseSince: state.adverseSince,
        }, this.emergencyExitConfig);
        state.adverseSince = signal.adverseSince;
        if (!signal.triggered) return undefined;
        if (!canRetryDogeBaselineEmergencyExit(context.snapshot.timestamp, state.nextEmergencyExitAttemptTimestamp)) {
            return undefined;
        }
        state.nextEmergencyExitAttemptTimestamp = context.snapshot.timestamp + this.emergencyExitConfig.retryMs;
        return {
            action: 'sell',
            reason_code: 'adverse_coin_direction_exit',
            order: { action: 'sell', side: state.side, quantity, limit_price: context.frame.market_data.tick_size },
        };
    }

    private getState(frameStart: number): DogeBaselineReplayState {
        const existing = this.states.get(frameStart);
        if (existing) return existing;
        const state: DogeBaselineReplayState = {
            prices: [], evaluatedModes: new Set(), entered: false, exited: false,
            side: undefined, adverseSince: undefined, nextEmergencyExitAttemptTimestamp: undefined,
        };
        this.states.set(frameStart, state);
        return state;
    }

    private hold(reasonCode: string): ReplayDecision {
        return { action: 'hold', reason_code: reasonCode, order: undefined };
    }
}

function createDogeBaselineSingleModeEntrySettings(
    entry: Readonly<DogeBaselineEntrySettings>,
    enabledMode: DogeBaselineModeName,
): DogeBaselineEntrySettings {
    return {
        modes: Object.fromEntries(DOGE_BASELINE_MODES.map(mode => [mode.name, {
            ...entry.modes[mode.name],
            enabled: mode.name === enabledMode,
        }])) as Record<DogeBaselineModeName, DogeBaselineEntryModeSettings>,
    };
}
