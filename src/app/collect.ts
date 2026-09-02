import 'dotenv/config';
import { getSupportedCoins, isCoin } from '../market/coins.js';
import { getSupportedFrames, isEventFrame } from '../market/frame.js';
import {
    PS_CHAINLINK_TWAP_60,
    getSupportedPriceSources,
    isPriceSource,
} from '../market/price/price_source.js';
import { PriceWatcherFactory } from '../market/price/PriceWatcherFactory.js';
import { TIMER_FAST } from '../timer.js';
import { logger, logger_shutdown } from '../log.js';
import { error_str, killSignalsHook, safeToNum } from '../utils.js';
import { HistoryCollector } from './core/history/HistoryCollector.js';
import { HistoryFrameWriter } from './core/history/HistoryFrameWriter.js';

function readArgument(name: string): string | undefined {
    const prefix = `--${name}=`;
    const inline = process.argv.find(argument => argument.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function readInteger(name: string, fallback: number, minimum: number): number {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = safeToNum(raw, Number.NaN);
    if (!Number.isInteger(value) || value < minimum) {
        throw new Error(`${name} must be an integer >= ${minimum}, got ${raw}`);
    }
    return value;
}

function readArgumentInteger(name: string, fallback: number, minimum: number): number {
    const raw = readArgument(name);
    if (raw === undefined) return fallback;
    const value = safeToNum(raw, Number.NaN);
    if (!Number.isInteger(value) || value < minimum) {
        throw new Error(`--${name} must be an integer >= ${minimum}, got ${raw}`);
    }
    return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    if (raw === '1' || raw.toLowerCase() === 'true') return true;
    if (raw === '0' || raw.toLowerCase() === 'false') return false;
    throw new Error(`${name} must be true/false or 1/0, got ${raw}`);
}

async function main(): Promise<void> {
    if (process.argv.includes('--help')) {
        console.log([
            'Usage: npm run collect -- --coin btc --frame 5m --source chainlink-twap-60 [--count 1]',
            '',
            'The collector is read-only and waits for the next complete frame boundary.',
            'Configuration: HISTORY_DIR, HISTORY_SNAPSHOT_MS, HISTORY_BOOK_DEPTH,',
            'HISTORY_GZIP, HISTORY_MAX_FRAMES.',
            `Supported coins: ${getSupportedCoins().join(', ')}`,
            `Supported frames: ${getSupportedFrames().join(', ')}`,
            `Supported sources: ${getSupportedPriceSources().join(', ')}`,
        ].join('\n'));
        return;
    }

    const coinRaw = (readArgument('coin') ?? 'btc').toLowerCase();
    const frameRaw = (readArgument('frame') ?? '5m').toLowerCase();
    const sourceRaw = (readArgument('source') ?? PS_CHAINLINK_TWAP_60).toLowerCase();
    if (!isCoin(coinRaw)) {
        throw new Error(`Unsupported coin: ${coinRaw}. Supported: ${getSupportedCoins().join(', ')}`);
    }
    if (!isEventFrame(frameRaw)) {
        throw new Error(`Unsupported frame: ${frameRaw}. Supported: ${getSupportedFrames().join(', ')}`);
    }
    if (!isPriceSource(sourceRaw)) {
        throw new Error(`Unsupported source: ${sourceRaw}. Supported: ${getSupportedPriceSources().join(', ')}`);
    }

    const coin = coinRaw;
    const frame = frameRaw;
    const source = sourceRaw;
    const snapshotIntervalMs = readInteger('HISTORY_SNAPSHOT_MS', 100, 25);
    const bookDepth = readInteger('HISTORY_BOOK_DEPTH', 10, 1);
    if (bookDepth > 100) throw new Error(`HISTORY_BOOK_DEPTH must be <= 100, got ${bookDepth}`);
    const maxFrames = readInteger('HISTORY_MAX_FRAMES', 0, 0);
    const directory = process.env.HISTORY_DIR || 'history/frames';
    const gzipEnabled = readBoolean('HISTORY_GZIP', true);
    const frameCount = readArgumentInteger('count', 0, 0);

    const coinWatcher = await PriceWatcherFactory
        .getCoinWatcher(coin, source)
        .warmUp(TIMER_FAST);
    const writer = new HistoryFrameWriter({ directory, gzip: gzipEnabled, maxFrames });
    const collector = new HistoryCollector(
        { coin, frame, snapshotIntervalMs, bookDepth, frameCount },
        coinWatcher,
        writer,
    );
    const unsubscribe = killSignalsHook(async () => {
        logger.info('[HistoryCollector] Shutdown signal received');
        collector.stop();
    });

    logger.info(
        `[HistoryCollector] Config coin=${coin} frame=${frame} source=${source} interval=${snapshotIntervalMs}ms ` +
        `depth=${bookDepth} gzip=${gzipEnabled} maxFrames=${maxFrames} count=${frameCount} directory=${directory}`,
    );
    try {
        await collector.run();
    } finally {
        unsubscribe();
        coinWatcher.disconnect();
        await logger_shutdown();
    }
}

main().catch(async error => {
    logger.error(`[HistoryCollector] Fatal error: ${error_str(error)}`);
    await logger_shutdown();
    process.exitCode = 1;
});
