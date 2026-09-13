import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getHistoryFramePaths, readHistoryFrame } from './core/history/HistoryFrameReader.js';
import { ReplayMatrixSourceFile, runReplayMatrix, writeReplayMatrixReport } from './core/backtest/replay_matrix.js';
import { REPLAY_STRATEGY_PRESETS } from './core/backtest/replay_presets.js';
import { readArgument, readReplayExecutionConfig } from './cli_args.js';
import { DEFAULT_BACKTEST_MATRIX_OUTPUT_DIRECTORY, DEFAULT_HISTORY_DIRECTORY } from './defaults.js';
import { logger, logger_shutdown } from '../log.js';
import { error_str } from '../utils.js';

async function main(): Promise<void> {
    const input = readArgument('history') ?? DEFAULT_HISTORY_DIRECTORY;
    const output = readArgument('output') ?? DEFAULT_BACKTEST_MATRIX_OUTPUT_DIRECTORY;
    const config = readReplayExecutionConfig();
    const frames = [];
    const sourceFiles: ReplayMatrixSourceFile[] = [];
    for (const filePath of await getHistoryFramePaths(input)) {
        const payload = await fs.readFile(filePath);
        frames.push(await readHistoryFrame(filePath));
        sourceFiles.push({
            file: path.basename(filePath),
            sha256: createHash('sha256').update(payload).digest('hex'),
        });
    }
    const result = runReplayMatrix(frames, REPLAY_STRATEGY_PRESETS, config);
    await writeReplayMatrixReport(result, output, sourceFiles);
    logger.info(`[BacktestMatrix] Result:\n${JSON.stringify({
        presets: Object.keys(result.results),
        included_frames: result.frames.length,
        excluded_frames: result.excluded_frames.length,
        output,
    }, undefined, 2)}`);
}

async function run(): Promise<void> {
    try {
        await main();
    } catch (error) {
        logger.error(`[BacktestMatrix] Fatal error: ${error_str(error)}`);
        process.exitCode = 1;
    } finally {
        await logger_shutdown();
    }
}

void run();
