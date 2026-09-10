import 'dotenv/config';
import { readArgument } from './backtest_args.js';
import { DEFAULT_HISTORY_DIRECTORY } from './defaults.js';
import { getDogeBaselineModelPath } from './core/events/strategy/doge-baseline/DogeBaselineModel.js';
import { trainDogeBaseline } from './core/events/strategy/doge-baseline/DogeBaselineResearch.js';
import { DogeBaselineRefreshLock } from './core/events/strategy/doge-baseline/DogeBaselineRefreshLock.js';
import { safeToNum } from '../utils.js';

function readRequiredCount(): number {
    const raw = readArgument('count');
    const count = safeToNum(raw, Number.NaN);
    if (!Number.isInteger(count) || count <= 0) throw new Error('--count must be a positive integer');
    return count;
}

async function main(): Promise<void> {
    const count = readRequiredCount();
    const history = readArgument('history') ?? DEFAULT_HISTORY_DIRECTORY;
    const lock = await DogeBaselineRefreshLock.acquire();
    try {
        const result = await trainDogeBaseline(history, count);
        console.log(JSON.stringify({
            model: getDogeBaselineModelPath(),
            trained_frames: result.model.actualFrames,
            available_frames: result.availableFrames,
            first_frame_start: result.model.firstFrameStart,
            last_frame_start: result.model.lastFrameStart,
            training_metrics: result.metrics,
        }, undefined, 2));
    } finally {
        await lock.release();
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
