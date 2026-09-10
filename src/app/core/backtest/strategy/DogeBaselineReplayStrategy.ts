import { MarketSide } from '../../../../market/side.js';
import { safeToNum } from '../../../../utils.js';
import {
    DOGE_BASELINE_MAX_ORDER_VALUE,
    DOGE_BASELINE_MODES,
    DOGE_BASELINE_STRATEGY,
    DogeBaselineModeName,
} from '../../events/strategy/doge-baseline/DogeBaselineConfig.js';
import {
    DogeBaselineModel,
    DogeBaselinePricePoint,
    makeDogeBaselineFeaturesFromPrices,
    predictDogeBaseline,
} from '../../events/strategy/doge-baseline/DogeBaselineModel.js';
import {
    calculateDogeBaselineEntryLimit,
    evaluateDogeBaselineEmergencyExit,
    selectDogeBaselineEntry,
} from '../../events/strategy/doge-baseline/DogeBaselineDecision.js';
import { ReplayDecision, ReplayFill, ReplayStrategy, ReplayStrategyContext } from '../replay.js';

interface DogeBaselineReplayState {
    prices: DogeBaselinePricePoint[];
    evaluatedModes: Set<DogeBaselineModeName>;
    entered: boolean;
    exited: boolean;
    side: MarketSide | undefined;
    adverseSince: number | undefined;
}

export class DogeBaselineReplayStrategy implements ReplayStrategy {
    public readonly name: string;
    private readonly states = new Map<number, DogeBaselineReplayState>();
    public constructor(
        private readonly model: Readonly<DogeBaselineModel>,
        private readonly enabledModes: readonly DogeBaselineModeName[] = DOGE_BASELINE_MODES.map(mode => mode.name),
    ) {
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
            if (!this.enabledModes.includes(mode.name)) continue;
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
            const decision = this.entry(context, mode.name, upProbability);
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

    private entry(
        context: Readonly<ReplayStrategyContext>,
        mode: DogeBaselineModeName,
        upProbability: number,
    ): ReplayDecision | undefined {
        const candidate = selectDogeBaselineEntry(upProbability, {
            upAsk: safeToNum(context.snapshot.up.asks[0]?.price, Number.NaN),
            downAsk: safeToNum(context.snapshot.down.asks[0]?.price, Number.NaN),
            feesEnabled: context.frame.market_data.fees_enabled,
            takerBaseFee: context.frame.market_data.taker_base_fee,
        });
        if (!candidate) return undefined;
        const limitPrice = calculateDogeBaselineEntryLimit(
            candidate.ask,
            context.frame.market_data.tick_size,
        );
        const quantity = DOGE_BASELINE_MAX_ORDER_VALUE / limitPrice;
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
        if (!state.entered || state.exited || state.side === undefined ||
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
        });
        state.adverseSince = signal.adverseSince;
        if (!signal.triggered) return undefined;
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
            side: undefined, adverseSince: undefined,
        };
        this.states.set(frameStart, state);
        return state;
    }

    private hold(reasonCode: string): ReplayDecision {
        return { action: 'hold', reason_code: reasonCode, order: undefined };
    }
}
