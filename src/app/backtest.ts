import { readHistoryFrames } from './core/history/HistoryFrameReader.js';
import {
    runReplay,
    writeReplayReport,
} from './core/backtest/replay.js';
import { getReplayStrategyPreset, REPLAY_STRATEGY_PRESETS } from './core/backtest/replay_presets.js';
import { readArgument, readReplayExecutionConfig } from './cli_args.js';
import {
    DEFAULT_BACKTEST_OUTPUT_DIRECTORY,
    DEFAULT_HISTORY_DIRECTORY,
    DEFAULT_REPLAY_STRATEGY,
} from './defaults.js';
import { logger, logger_shutdown } from '../log.js';
import { error_str } from '../utils.js';

async function main(): Promise<void> {
    const input = readArgument('history') ?? DEFAULT_HISTORY_DIRECTORY;
    const output = readArgument('output') ?? DEFAULT_BACKTEST_OUTPUT_DIRECTORY;
    const strategyName = readArgument('strategy') ?? DEFAULT_REPLAY_STRATEGY;
    const config = readReplayExecutionConfig();
    const preset = getReplayStrategyPreset(strategyName);
    if (!preset) throw new Error(`strategy must be one of: ${REPLAY_STRATEGY_PRESETS.map(value => value.id).join(', ')}`);
    const frames = [];
    for await (const frame of readHistoryFrames(input)) frames.push(frame);
    const result = runReplay(frames, preset.create(), config);
    await writeReplayReport(result, output);
    logger.info(`[Backtest] Result:\n${JSON.stringify(result.metrics, undefined, 2)}`);
}

async function run(): Promise<void> {
    try {
        await main();
    } catch (error) {
        logger.error(`[Backtest] Fatal error: ${error_str(error)}`);
        process.exitCode = 1;
    } finally {
        await logger_shutdown();
    }
}

void run();
