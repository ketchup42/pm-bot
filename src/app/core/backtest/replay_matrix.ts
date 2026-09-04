import { csvValue, fileWrite, stringValue } from '../../../utils.js';
import { HistoryFrameV2 } from '../history/history_frame.js';
import { ReplayExecutionConfig, ReplayResult, runReplay, writeReplayReport } from './replay.js';
import { ReplayStrategyPreset } from './replay_presets.js';

export interface ReplayMatrixExcludedFrame {
    slug: string;
    start_time: number;
    reason: 'incomplete' | 'unconfirmed_settlement';
}

export interface ReplayMatrixResult {
    config: ReplayExecutionConfig;
    frames: readonly HistoryFrameV2[];
    excluded_frames: readonly ReplayMatrixExcludedFrame[];
    results: Readonly<Record<string, ReplayResult>>;
}

export interface ReplayMatrixSourceFile {
    file: string;
    sha256: string;
}

export function runReplayMatrix(
    inputFrames: readonly HistoryFrameV2[],
    presets: readonly ReplayStrategyPreset[],
    config: ReplayExecutionConfig,
): ReplayMatrixResult {
    const frames: HistoryFrameV2[] = [];
    const excludedFrames: ReplayMatrixExcludedFrame[] = [];
    for (const frame of inputFrames) {
        if (!frame.data_quality.complete) {
            excludedFrames.push({ slug: frame.slug, start_time: frame.start_time, reason: 'incomplete' });
            continue;
        }
        if (frame.settlement.confirmed_outcome === undefined) {
            excludedFrames.push({ slug: frame.slug, start_time: frame.start_time, reason: 'unconfirmed_settlement' });
            continue;
        }
        frames.push(frame);
    }
    if (frames.length === 0) throw new Error('no_complete_confirmed_history_frames');
    const results: Record<string, ReplayResult> = {};
    for (const preset of presets) {
        if (results[preset.id] !== undefined) throw new Error(`duplicate_replay_preset: ${preset.id}`);
        results[preset.id] = runReplay(frames, preset.create(), config);
    }
    return { config: { ...config }, frames, excluded_frames: excludedFrames, results };
}

function makeSummaryRows(result: ReplayMatrixResult): unknown[][] {
    const metrics = Object.values(result.results).map(value => value.metrics);
    return [
        ['preset', 'frames', 'net_pnl', 'gross_pnl_before_fees', 'pnl_before_execution_costs', 'fees',
            'spread_cost', 'slippage_cost', 'max_drawdown', 'profit_factor', 'trade_count', 'position_frames',
            'filled_orders', 'partial_orders', 'rejected_orders'],
        ...metrics.map(value => [
            value.strategy, value.frames, value.net_pnl, value.gross_pnl, value.pre_execution_cost_pnl,
            value.fees, value.spread_cost, value.slippage_cost, value.max_drawdown, value.profit_factor,
            value.trade_count, value.position_frames,
            value.filled_orders, value.partial_orders, value.rejected_orders,
        ]),
    ];
}

export async function writeReplayMatrixReport(
    result: ReplayMatrixResult,
    directory: string,
    sourceFiles: readonly ReplayMatrixSourceFile[] = [],
): Promise<void> {
    const summaryRows = makeSummaryRows(result);
    const [header, ...dataRows] = summaryRows;
    const markdownRows = [
        `| ${header!.map(stringValue).join(' | ')} |`,
        `| ${header!.map(() => '---').join(' | ')} |`,
        ...dataRows.map(row => `| ${row.map(stringValue).join(' | ')} |`),
    ].join('\n');
    const manifest = {
        config: result.config,
        included_frames: result.frames.map(frame => ({
            slug: frame.slug,
            start_time: frame.start_time,
            event_id: frame.market_data.eventId,
            confirmed_outcome: frame.settlement.confirmed_outcome,
        })),
        excluded_frames: result.excluded_frames,
        input_files: sourceFiles,
        presets: Object.keys(result.results),
    };
    await Promise.all([
        ...Object.entries(result.results).map(([preset, replay]) => writeReplayReport(replay, `${directory}/${preset}`)),
        fileWrite(`${directory}/manifest.json`, `${JSON.stringify(manifest, undefined, 2)}\n`),
        fileWrite(`${directory}/summary.csv`, `${summaryRows.map(row => row.map(csvValue).join(',')).join('\n')}\n`),
        fileWrite(`${directory}/summary.md`, `# Backtest matrix\n\n${markdownRows}\n`),
    ]);
}
