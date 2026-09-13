import { ReplayExecutionConfig, ReplayMetrics, runReplay } from '../../../backtest/replay.js';
import { DogeBaselineReplayStrategy } from '../../../backtest/strategy/DogeBaselineReplayStrategy.js';
import { HistoryFrameV3 } from '../../../history/history_frame.js';
import {
    DOGE_BASELINE_CONFIG_FINALIST_COUNT,
    DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTORS,
    DOGE_BASELINE_EMERGENCY_EXIT_WINDOWS_MS,
    DOGE_BASELINE_MINIMUM_EDGE_VALUES,
    DOGE_BASELINE_MODES,
    createDogeBaselineEntrySettings,
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

const DOGE_BASELINE_ENTRY_MODE_SETS: readonly (readonly DogeBaselineModeName[])[] = Object.freeze([
    Object.freeze(['early-60'] as const),
    Object.freeze(['late-120'] as const),
    Object.freeze(['early-60', 'late-120'] as const),
]);

function getEntryId(entry: Readonly<DogeBaselineEntrySettings>): string {
    return DOGE_BASELINE_MODES
        .filter(mode => entry.modes[mode.name].enabled)
        .map(mode => `${mode.name}-${entry.modes[mode.name].minimumEdge.toFixed(2)}`)
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
): DogeBaselineConfigMatrixRow {
    return {
        id: getConfigId(config),
        config,
        metrics: runReplay(
            frames,
            new DogeBaselineReplayStrategy(model, toDogeBaselineRuntimeConfig(config)),
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

function createEntryConfigs(model: Readonly<DogeBaselineModel>, baseline: Readonly<DogeBaselineStrategyConfig>): DogeBaselineStrategyConfig[] {
    const naturalExit = { ...baseline.exit, enabled: false };
    return DOGE_BASELINE_ENTRY_MODE_SETS.flatMap(enabledModes => {
        if (enabledModes.length === 1) return DOGE_BASELINE_MINIMUM_EDGE_VALUES.map(minimumEdge =>
            createDogeBaselineStrategyConfig(model, {
                entry: createDogeBaselineEntrySettings(enabledModes, { [enabledModes[0]!]: minimumEdge }),
                exit: naturalExit,
            }),
        );
        return DOGE_BASELINE_MINIMUM_EDGE_VALUES.flatMap(earlyEdge =>
            DOGE_BASELINE_MINIMUM_EDGE_VALUES.map(lateEdge => createDogeBaselineStrategyConfig(model, {
                entry: createDogeBaselineEntrySettings(enabledModes, {
                    'early-60': earlyEdge,
                    'late-120': lateEdge,
                }),
                exit: naturalExit,
            })),
        );
    });
}

function createExitConfigs(
    model: Readonly<DogeBaselineModel>,
    finalist: Readonly<DogeBaselineConfigMatrixRow>,
): DogeBaselineStrategyConfig[] {
    return DOGE_BASELINE_EMERGENCY_EXIT_WINDOWS_MS.flatMap(windowMs =>
        DOGE_BASELINE_EMERGENCY_EXIT_DEVIATION_FACTORS.map(deviationFactor => createDogeBaselineStrategyConfig(model, {
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
): DogeBaselineConfigMatrix {
    if (frames.length === 0) throw new Error('doge_baseline_empty_config_research_set');
    const baseline = replayConfigRow(frames, model, executionConfig, createDogeBaselineStrategyConfig(model, {
        entry: baselineConfig.entry,
        exit: baselineConfig.exit,
    }));
    const entryRows = createEntryConfigs(model, baselineConfig)
        .map(config => replayConfigRow(frames, model, executionConfig, config));
    const finalists = entryRows.filter(row => isEligible(row, baseline)).sort(compareRows)
        .slice(0, DOGE_BASELINE_CONFIG_FINALIST_COUNT);
    const exitRows = finalists.flatMap(finalist => createExitConfigs(model, finalist)
        .map(config => replayConfigRow(frames, model, executionConfig, config)));
    const rows = [...entryRows, ...exitRows];
    const selected = [...rows.filter(row => isEligible(row, baseline)), baseline].sort(compareRows)[0]!;
    return { baseline, entryRows, finalists, rows, selected };
}
