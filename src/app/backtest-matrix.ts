import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getHistoryFrameIndex } from './core/history/HistoryFrameReader.js';
import { ReplayMatrixRunner, ReplayMatrixSourceFile, writeReplayMatrixReport } from './core/backtest/replay_matrix.js';
import { REPLAY_STRATEGY_PRESETS } from './core/backtest/replay_presets.js';
import { readArgument, readReplayExecutionConfig } from './cli_args.js';
import { DEFAULT_BACKTEST_MATRIX_OUTPUT_DIRECTORY, DEFAULT_HISTORY_DIRECTORY } from './defaults.js';
import { logger } from '../log.js';

export async function runBacktestMatrix(): Promise<void> {
    const input = readArgument('history') ?? DEFAULT_HISTORY_DIRECTORY;
    const output = readArgument('output') ?? DEFAULT_BACKTEST_MATRIX_OUTPUT_DIRECTORY;
    const config = readReplayExecutionConfig();
    const sourceFiles: ReplayMatrixSourceFile[] = [];
    const runner = new ReplayMatrixRunner(REPLAY_STRATEGY_PRESETS, config);
    const index = await getHistoryFrameIndex(input);
    for (let position = 0; position < index.length; position++) {
        const entry = index.at(position)!;
        const payload = await fs.readFile(entry.path);
        const frame = await index.read(position);
        if (frame === undefined) continue;
        runner.consume(frame);
        sourceFiles.push({
            file: path.basename(entry.path),
            sha256: createHash('sha256').update(payload).digest('hex'),
        });
    }
    const result = runner.finish();
    await writeReplayMatrixReport(result, output, sourceFiles);
    logger.info(`[BacktestMatrix] Result:\n${JSON.stringify({
        presets: Object.keys(result.results),
        included_frames: result.frames.length,
        excluded_frames: result.excluded_frames.length,
        output,
    }, undefined, 2)}`);
}
