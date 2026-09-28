import { ReplayExecutionConfig, ReplayMetrics, runReplay } from '../../../backtest/replay.js';
import { DogeBaselineReplayStrategy } from '../../../backtest/strategy/DogeBaselineReplayStrategy.js';
import { HistoryFrameV3 } from '../../../history/history_frame.js';
import {
    DOGE_BASELINE_CONFIG_FINALIST_COUNT,
    DOGE_BASELINE_DEFAULT_TRADE_VALUE,
    DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTORS,
    DOGE_BASELINE_EMERGENCY_EXIT_WINDOWS_MS,
    DOGE_BASELINE_LOCAL_CONFIDENCE_DELTA,
    DOGE_BASELINE_LOCAL_EDGE_DELTA,
    DOGE_BASELINE_MINIMUM_ABSOLUTE_DEVIATION_BPS_VALUES,
    DOGE_BASELINE_MINIMUM_CONFIDENCE_VALUES,
    DOGE_BASELINE_MINIMUM_EDGE_VALUES,
    DOGE_BASELINE_MODES,
    createDogeBaselineEntrySettings,
    formatDogeBaselineDeviationBps,
    getDogeBaselineMinimumReplayTradeCount,
    type DogeBaselineEntrySettings,
    type DogeBaselineModeName,
} from './DogeBaselineConfig.js';
import { DogeBaselineModel } from './DogeBaselineModel.js';
import {
    DogeBaselineStrategyConfig,
    createDogeBaselineStrategyConfig,
    toDogeBaselineRuntimeConfig,
} from './artifacts.js';

export interface DogeBaselineConfigMatrixRow {
    id: string;
    config: DogeBaselineStrategyConfig;
    metrics: ReplayMetrics;
}

export interface DogeBaselineConfigMatrix {
    baseline: DogeBaselineConfigMatrixRow;
    entryRows: DogeBaselineConfigMatrixRow[];
    finalists: DogeBaselineConfigMatrixRow[];
    rows: DogeBaselineConfigMatrixRow[];
    selected: DogeBaselineConfigMatrixRow;
}

function getEntryId(entry: Readonly<DogeBaselineEntrySettings>): string {
    return DOGE_BASELINE_MODES
        .filter(mode => entry.modes[mode.name].enabled)
        .map(mode => {
            const settings = entry.modes[mode.name];
            return `${mode.name}-edge${settings.minimumEdge.toFixed(2)}` +
                `-confidence${settings.minimumConfidence.toFixed(2)}` +
                `-deviation${formatDogeBaselineDeviationBps(settings.minimumAbsoluteDeviationBps)}bps`;
        })
        .join('_');
}

function getConfigId(config: Readonly<DogeBaselineStrategyConfig>): string {
    const entry = getEntryId(config.entry);
    if (!config.exit.enabled) return `${entry}-natural`;
    return `${entry}-exit-${config.exit.windowMs / 1_000}s-` +
        `${(config.exit.deviationFactor * 100).toFixed(2)}pct`;
}

function replayConfigRow(
    frames: readonly HistoryFrameV3[],
    model: Readonly<DogeBaselineModel>,
    executionConfig: ReplayExecutionConfig,
    config: DogeBaselineStrategyConfig,
    tradeValue: number,
): DogeBaselineConfigMatrixRow {
    return {
        id: getConfigId(config),
        config,
        metrics: runReplay(
            frames,
            new DogeBaselineReplayStrategy(model, { ...toDogeBaselineRuntimeConfig(config), tradeValue }),
            executionConfig,
        ).metrics,
    };
}

function getCosts(row: Readonly<DogeBaselineConfigMatrixRow>): number {
    return row.metrics.fees + row.metrics.spread_cost + row.metrics.slippage_cost;
}

function compareRows(left: Readonly<DogeBaselineConfigMatrixRow>, right: Readonly<DogeBaselineConfigMatrixRow>): number {
    if (left.metrics.net_pnl !== right.metrics.net_pnl) return right.metrics.net_pnl - left.metrics.net_pnl;
    if (getCosts(left) !== getCosts(right)) return getCosts(left) - getCosts(right);
    return left.metrics.trade_count - right.metrics.trade_count;
}

function createModeEntryConfigs(
    model: Readonly<DogeBaselineModel>,
    baseline: Readonly<DogeBaselineStrategyConfig>,
    mode: DogeBaselineModeName,
): DogeBaselineStrategyConfig[] {
    const naturalExit = { ...baseline.exit, enabled: false };
    return DOGE_BASELINE_MINIMUM_EDGE_VALUES.flatMap(minimumEdge =>
        DOGE_BASELINE_MINIMUM_CONFIDENCE_VALUES.flatMap(minimumConfidence =>
            DOGE_BASELINE_MINIMUM_ABSOLUTE_DEVIATION_BPS_VALUES.map(minimumAbsoluteDeviationBps =>
                createDogeBaselineStrategyConfig(model, {
                    tradingEnabled: baseline.tradingEnabled,
                    regime: baseline.regime,
                    entry: createDogeBaselineEntrySettings(
                        [mode],
                        { [mode]: { minimumEdge, minimumConfidence, minimumAbsoluteDeviationBps } },
                    ),
                    exit: naturalExit,
                }),
            ),
        ),
    );
}

function createCombinedEntryConfig(
    model: Readonly<DogeBaselineModel>,
    baseline: Readonly<DogeBaselineStrategyConfig>,
    early: Readonly<DogeBaselineConfigMatrixRow>,
    late: Readonly<DogeBaselineConfigMatrixRow>,
): DogeBaselineStrategyConfig {
    const earlySettings = early.config.entry.modes['early-60'];
    const lateSettings = late.config.entry.modes['late-120'];
    return createDogeBaselineStrategyConfig(model, {
        tradingEnabled: baseline.tradingEnabled,
        regime: baseline.regime,
        entry: createDogeBaselineEntrySettings(
            DOGE_BASELINE_MODES.map(mode => mode.name),
            {
                'early-60': {
                    minimumEdge: earlySettings.minimumEdge,
                    minimumConfidence: earlySettings.minimumConfidence,
                    minimumAbsoluteDeviationBps: earlySettings.minimumAbsoluteDeviationBps,
                },
                'late-120': {
                    minimumEdge: lateSettings.minimumEdge,
                    minimumConfidence: lateSettings.minimumConfidence,
                    minimumAbsoluteDeviationBps: lateSettings.minimumAbsoluteDeviationBps,
                },
            },
        ),
        exit: { ...baseline.exit, enabled: false },
    });
}

function getLocalValues(value: number, delta: number, minimum: number, maximum: number): number[] {
    return [...new Set([
        Math.max(minimum, value - delta),
        value,
        Math.min(maximum, value + delta),
    ])];
}

function createLocalEntryConfigs(
    model: Readonly<DogeBaselineModel>,
    baseline: Readonly<DogeBaselineStrategyConfig>,
    winner: Readonly<DogeBaselineConfigMatrixRow>,
    mode: DogeBaselineModeName,
): DogeBaselineStrategyConfig[] {
    const settings = winner.config.entry.modes[mode];
    return getLocalValues(settings.minimumEdge, DOGE_BASELINE_LOCAL_EDGE_DELTA, 0.02, 0.10).flatMap(minimumEdge =>
        getLocalValues(settings.minimumConfidence, DOGE_BASELINE_LOCAL_CONFIDENCE_DELTA, 0.5, 0.65)
            .map(minimumConfidence => createDogeBaselineStrategyConfig(model, {
                tradingEnabled: baseline.tradingEnabled,
                regime: baseline.regime,
                entry: createDogeBaselineEntrySettings([mode], {
                    [mode]: {
                        minimumEdge,
                        minimumConfidence,
                        minimumAbsoluteDeviationBps: settings.minimumAbsoluteDeviationBps,
                    },
                }),
                exit: { ...baseline.exit, enabled: false },
            })),
    );
}

function isEligibleForTuning(
    row: Readonly<DogeBaselineConfigMatrixRow>,
    baseline: Readonly<DogeBaselineConfigMatrixRow>,
    frameCount: number,
): boolean {
    return isEligible(row, baseline) && row.metrics.trade_count >= getDogeBaselineMinimumReplayTradeCount(frameCount);
}

function getTuningFinalists(
    rows: readonly DogeBaselineConfigMatrixRow[],
    baseline: Readonly<DogeBaselineConfigMatrixRow>,
    frameCount: number,
): DogeBaselineConfigMatrixRow[] {
    return rows.filter(row => isEligibleForTuning(row, baseline, frameCount))
        .sort(compareRows)
        .slice(0, DOGE_BASELINE_CONFIG_FINALIST_COUNT);
}

function createEntryRows(
    frames: readonly HistoryFrameV3[],
    model: Readonly<DogeBaselineModel>,
    executionConfig: ReplayExecutionConfig,
    baseline: Readonly<DogeBaselineStrategyConfig>,
    baselineRow: Readonly<DogeBaselineConfigMatrixRow>,
    tradeValue: number,
): DogeBaselineConfigMatrixRow[] {
    const frameCount = frames.length;
    const coarseEarlyRows = createModeEntryConfigs(model, baseline, 'early-60')
        .map(config => replayConfigRow(frames, model, executionConfig, config, tradeValue));
    const coarseLateRows = createModeEntryConfigs(model, baseline, 'late-120')
        .map(config => replayConfigRow(frames, model, executionConfig, config, tradeValue));
    const coarseEarlyWinner = getTuningFinalists(coarseEarlyRows, baselineRow, frameCount)[0];
    const coarseLateWinner = getTuningFinalists(coarseLateRows, baselineRow, frameCount)[0];
    const localEarlyRows = coarseEarlyWinner === undefined ? [] : createLocalEntryConfigs(
        model, baseline, coarseEarlyWinner, 'early-60',
    ).map(config => replayConfigRow(frames, model, executionConfig, config, tradeValue));
    const localLateRows = coarseLateWinner === undefined ? [] : createLocalEntryConfigs(
        model, baseline, coarseLateWinner, 'late-120',
    ).map(config => replayConfigRow(frames, model, executionConfig, config, tradeValue));
    const earlyRows = [...coarseEarlyRows, ...localEarlyRows];
    const lateRows = [...coarseLateRows, ...localLateRows];
    const earlyFinalists = getTuningFinalists(earlyRows, baselineRow, frameCount);
    const lateFinalists = getTuningFinalists(lateRows, baselineRow, frameCount);
    const combinedRows = earlyFinalists.flatMap(early => lateFinalists.map(late =>
        replayConfigRow(frames, model, executionConfig, createCombinedEntryConfig(model, baseline, early, late), tradeValue),
    ));
    return [...earlyRows, ...lateRows, ...combinedRows];
}

function createExitConfigs(
    model: Readonly<DogeBaselineModel>,
    finalist: Readonly<DogeBaselineConfigMatrixRow>,
): DogeBaselineStrategyConfig[] {
    return DOGE_BASELINE_EMERGENCY_EXIT_WINDOWS_MS.flatMap(windowMs =>
        DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTORS.map(deviationFactor => createDogeBaselineStrategyConfig(model, {
            tradingEnabled: finalist.config.tradingEnabled,
            regime: finalist.config.regime,
            entry: finalist.config.entry,
            exit: {
                enabled: true,
                windowMs,
                deviationFactor,
                confirmationMs: finalist.config.exit.confirmationMs,
                retryMs: finalist.config.exit.retryMs,
            },
        })),
    );
}

function isEligible(row: Readonly<DogeBaselineConfigMatrixRow>, baseline: Readonly<DogeBaselineConfigMatrixRow>): boolean {
    return row.metrics.max_drawdown <= baseline.metrics.max_drawdown;
}

export function researchDogeBaselineConfigMatrix(
    frames: readonly HistoryFrameV3[],
    model: Readonly<DogeBaselineModel>,
    executionConfig: ReplayExecutionConfig,
    baselineConfig: Readonly<DogeBaselineStrategyConfig>,
    tradeValue: number = DOGE_BASELINE_DEFAULT_TRADE_VALUE,
): DogeBaselineConfigMatrix {
    if (frames.length === 0) throw new Error('doge_baseline_empty_config_research_set');
    const baseline = replayConfigRow(frames, model, executionConfig, createDogeBaselineStrategyConfig(model, {
        tradingEnabled: baselineConfig.tradingEnabled,
        regime: baselineConfig.regime,
        entry: baselineConfig.entry,
        exit: baselineConfig.exit,
    }), tradeValue);
    const entryRows = createEntryRows(frames, model, executionConfig, baselineConfig, baseline, tradeValue);
    const finalists = getTuningFinalists(entryRows, baseline, frames.length);
    const exitRows = finalists.flatMap(finalist => createExitConfigs(model, finalist)
        .map(config => replayConfigRow(frames, model, executionConfig, config, tradeValue)));
    const rows = [...entryRows, ...exitRows];
    const selected = [...rows.filter(row => isEligibleForTuning(row, baseline, frames.length)), baseline]
        .sort(compareRows)[0]!;
    return { baseline, entryRows, finalists, rows, selected };
}
