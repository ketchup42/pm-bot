import { readArgument, readPositiveIntegerArgument, readReplayExecutionConfig } from './cli_args.js';
import { DEFAULT_HISTORY_DIRECTORY } from './defaults.js';
import { readDogeBaselineTrainReplaySplit } from './core/events/strategy/doge-baseline/DogeBaselineResearch.js';
import { readDogeBaselineModel } from './core/events/strategy/doge-baseline/DogeBaselineModel.js';
import { readDogeBaselineStrategyConfigOrDefault, writeDogeBaselineStrategyConfig } from './core/events/strategy/doge-baseline/artifacts.js';
import { researchDogeBaselineConfigMatrix } from './core/events/strategy/doge-baseline/research_matrix.js';
import { DogeBaselineRefreshLock } from './core/events/strategy/doge-baseline/DogeBaselineRefreshLock.js';
import {
    DOGE_BASELINE_DEFAULT_BALANCE,
    getDogeBaselineEntrySummary,
    DOGE_BASELINE_DEFAULT_REPLAY_LATENCY_MS,
} from './core/events/strategy/doge-baseline/DogeBaselineConfig.js';
import { logger } from '../log.js';

export async function runDogeBaselineConfigResearch(): Promise<void> {
    const count = readPositiveIntegerArgument('count');
    const history = readArgument('history') ?? DEFAULT_HISTORY_DIRECTORY;
    const lock = await DogeBaselineRefreshLock.acquire();
    try {
        const model = await readDogeBaselineModel();
        const baselineConfig = await readDogeBaselineStrategyConfigOrDefault(model);
        const { trainingFrames } = await readDogeBaselineTrainReplaySplit(
            history, { trainingCount: count, replayCount: 0 },
        );
        const matrix = researchDogeBaselineConfigMatrix(
            trainingFrames, model, readReplayExecutionConfig(
                DOGE_BASELINE_DEFAULT_BALANCE,
                DOGE_BASELINE_DEFAULT_REPLAY_LATENCY_MS,
            ), baselineConfig,
        );
        await writeDogeBaselineStrategyConfig(matrix.selected.config, model);
        const exit = matrix.selected.config.exit;
        logger.info(
            `[DogeBaselineConfigResearch] Updated modes=${getDogeBaselineEntrySummary(matrix.selected.config.entry)} ` +
            `exit=${exit.enabled ? `${exit.windowMs / 1_000}s/${(exit.deviationFactor * 100).toFixed(2)}%` : 'natural'}`,
        );
    } finally {
        await lock.release();
    }
}
