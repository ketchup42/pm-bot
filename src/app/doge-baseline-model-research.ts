import { readArgument, readPositiveIntegerArgument } from './cli_args.js';
import { DEFAULT_HISTORY_DIRECTORY } from './defaults.js';
import { trainDogeBaseline } from './core/events/strategy/doge-baseline/DogeBaselineResearch.js';
import { DogeBaselineRefreshLock } from './core/events/strategy/doge-baseline/DogeBaselineRefreshLock.js';
import {
    createDogeBaselineStrategyConfig,
    readDogeBaselineStrategyConfig,
    rebindDogeBaselineStrategyConfig,
    writeDogeBaselineArtifacts,
} from './core/events/strategy/doge-baseline/artifacts.js';
import { readDogeBaselineModel } from './core/events/strategy/doge-baseline/DogeBaselineModel.js';
import { logger } from '../log.js';
import { isFileMissingError } from '../file_lock.js';

export async function runDogeBaselineModelResearch(): Promise<void> {
    const count = readPositiveIntegerArgument('count');
    const history = readArgument('history') ?? DEFAULT_HISTORY_DIRECTORY;
    const lock = await DogeBaselineRefreshLock.acquire();
    try {
        let previousConfig;
        try {
            const previousModel = await readDogeBaselineModel();
            previousConfig = await readDogeBaselineStrategyConfig(previousModel);
        } catch (error) {
            if (!isFileMissingError(error)) throw error;
        }
        const result = await trainDogeBaseline(history, count);
        const config = previousConfig === undefined
            ? createDogeBaselineStrategyConfig(result.model)
            : rebindDogeBaselineStrategyConfig(result.model, previousConfig);
        await writeDogeBaselineArtifacts(result.model, config);
        logger.info(`[DogeBaselineModelResearch] Result:\n${JSON.stringify({
            trained_frames: result.model.actualFrames,
            first_frame_start: result.model.firstFrameStart,
            last_frame_start: result.model.lastFrameStart,
            training_metrics: result.metrics,
        }, undefined, 2)}`);
    } finally {
        await lock.release();
    }
}
