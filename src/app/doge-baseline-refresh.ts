import 'dotenv/config';
import { logger, logger_shutdown } from '../log.js';
import { getFrameDurationMs, isEventFrame, waitFrameStartMsUntil } from '../market/frame.js';
import { error_str, killSignalsHook, safeToNum } from '../utils.js';
import { readArgument } from './backtest_args.js';
import { DEFAULT_HISTORY_DIRECTORY } from './defaults.js';
import { trainDogeBaseline } from './core/events/strategy/doge-baseline/DogeBaselineResearch.js';
import { DogeBaselineRefreshLock } from './core/events/strategy/doge-baseline/DogeBaselineRefreshLock.js';
import { settleHistoryDirectory } from './core/history/HistorySettlementService.js';

function readPositiveInteger(name: string): number {
    const raw = readArgument(name);
    const value = safeToNum(raw, Number.NaN);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer`);
    return value;
}

async function main(): Promise<void> {
    const frameRaw = readArgument('frame');
    if (!frameRaw || !isEventFrame(frameRaw)) throw new Error('--frame must be a supported frame');
    const refreshFrames = readPositiveInteger('count');
    const trainFrames = readPositiveInteger('train-count');
    const history = readArgument('history') ?? DEFAULT_HISTORY_DIRECTORY;
    const lock = await DogeBaselineRefreshLock.acquire();
    logger.info('[DogeBaselineRefresh] Refresh lock acquired');
    let stopped = false;
    const unsubscribe = killSignalsHook(() => {
        stopped = true;
        logger.info('[DogeBaselineRefresh] Shutdown signal received');
    });

    try {
        while (!stopped) {
            const settlement = await settleHistoryDirectory({ directory: history, shouldStop: () => stopped });
            logger.info(
                `[DogeBaselineRefresh] Settlement checked=${settlement.checked} updated=${settlement.updated} ` +
                `unresolved=${settlement.unresolved} disappeared=${settlement.disappeared} failed=${settlement.failed}`,
            );
            if (stopped) break;
            try {
                const result = await trainDogeBaseline(history, trainFrames, () => stopped);
                const accuracy = Object.entries(result.metrics)
                    .map(([mode, metrics]) => `${mode}=${metrics.accuracy.toFixed(4)}`)
                    .join(' ');
                logger.info(
                    `[DogeBaselineRefresh] Model updated from ${result.model.actualFrames} frames accuracy ${accuracy}`,
                );
            } catch (error) {
                if (stopped) break;
                logger.error(`[DogeBaselineRefresh] Training failed, previous model retained: ${error_str(error)}`);
            }
            for (let index = 0; index < refreshFrames && !stopped; index++) {
                await waitFrameStartMsUntil(getFrameDurationMs(frameRaw), () => stopped);
                if (!stopped) await new Promise(resolve => setTimeout(resolve, 1));
            }
        }
    } finally {
        unsubscribe();
        await lock.release();
        logger.info('[DogeBaselineRefresh] Refresh lock released');
    }
}

async function run(): Promise<void> {
    try {
        await main();
    } catch (error) {
        logger.error(`[DogeBaselineRefresh] Fatal error: ${error_str(error)}`);
        process.exitCode = 1;
    } finally {
        await logger_shutdown();
    }
}

void run();
