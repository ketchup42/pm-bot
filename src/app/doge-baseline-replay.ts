import 'dotenv/config';
import { readArgument, readReplayExecutionConfig } from './backtest_args.js';
import { DEFAULT_DOGE_BASELINE_REPLAY_OUTPUT_DIRECTORY, DEFAULT_HISTORY_DIRECTORY } from './defaults.js';
import { runReplay, writeReplayReport } from './core/backtest/replay.js';
import { DogeBaselineReplayStrategy } from './core/backtest/strategy/DogeBaselineReplayStrategy.js';
import { readHistoryFrames } from './core/history/HistoryFrameReader.js';
import { readDogeBaselineModel } from './core/events/strategy/doge-baseline/DogeBaselineModel.js';
import { DOGE_BASELINE_COIN, DOGE_BASELINE_FRAME, DOGE_BASELINE_MODES, DOGE_BASELINE_SOURCE } from './core/events/strategy/doge-baseline/DogeBaselineConfig.js';
import { fileWrite } from '../utils.js';
import { HistoryFrameV3 } from './core/history/history_frame.js';

async function main(): Promise<void> {
    const history = readArgument('history') ?? DEFAULT_HISTORY_DIRECTORY;
    const output = readArgument('output') ?? DEFAULT_DOGE_BASELINE_REPLAY_OUTPUT_DIRECTORY;
    const frames: HistoryFrameV3[] = [];
    for await (const frame of readHistoryFrames(history)) {
        if (frame.coin === DOGE_BASELINE_COIN && frame.frame === DOGE_BASELINE_FRAME &&
            frame.source === DOGE_BASELINE_SOURCE && frame.data_quality.complete) frames.push(frame);
    }
    const model = await readDogeBaselineModel();
    const config = readReplayExecutionConfig();
    const combined = runReplay(frames, new DogeBaselineReplayStrategy(model), config);
    const results = [
        { mode: 'combined', result: combined },
        ...DOGE_BASELINE_MODES.map(mode => ({
            mode: mode.name,
            result: runReplay(frames, new DogeBaselineReplayStrategy(model, [mode.name]), config),
        })),
    ];
    await Promise.all(results.map(value => writeReplayReport(value.result, `${output}/${value.mode}`)));
    const rows = results.map(value =>
        `| ${value.mode.padEnd(9)} | ${String(value.result.metrics.trade_count).padStart(6)} | ` +
        `${value.result.metrics.net_pnl.toFixed(6).padStart(11)} | ${value.result.metrics.profit_factor?.toFixed(4).padStart(8) ?? '       -'} | ` +
        `${value.result.metrics.max_drawdown.toFixed(6).padStart(12)} |`,
    );
    await fileWrite(`${output}/summary.md`, [
        '# DOGE baseline replay', '',
        '| Mode      | Trades |     Net PnL | Profit factor | Max drawdown |',
        '| --------- | -----: | ----------: | ------------: | -----------: |',
        ...rows, '',
    ].join('\n'));
    console.log(JSON.stringify(Object.fromEntries(results.map(value => [value.mode, value.result.metrics])), undefined, 2));
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
