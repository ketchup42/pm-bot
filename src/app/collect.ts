import { getSupportedCoins, isCoin } from '../market/coins.js';
import { getSupportedFrames, isEventFrame } from '../market/frame.js';
import {
    getPriceSourceConfig,
    getSupportedPriceSources,
    isPriceSource,
} from '../market/price/price_source.js';
import { PriceWatcherFactory } from '../market/price/PriceWatcherFactory.js';
import { CoinPriceWatcher } from '../market/price/CoinPriceWatcher.js';
import { TIMER_FAST } from '../timer.js';
import { logger, writeOutput } from '../log.js';
import {
    DEFAULT_HISTORY_BOOK_DEPTH,
    DEFAULT_HISTORY_COIN,
    DEFAULT_HISTORY_DIRECTORY,
    DEFAULT_HISTORY_FRAME,
    DEFAULT_HISTORY_FRAME_COUNT,
    DEFAULT_HISTORY_DIAGNOSTIC_FRAMES,
    DEFAULT_HISTORY_GZIP,
    DEFAULT_HISTORY_SNAPSHOT_INTERVAL_MS,
    DEFAULT_HISTORY_SOURCE,
    HISTORY_COIN_ALL,
} from './defaults.js';
import { delay, killSignalsHook, safeToNum } from '../utils.js';
import { HistoryCollector } from './core/history/HistoryCollector.js';
import { HistoryFrameWriter } from './core/history/HistoryFrameWriter.js';
import { readArgument } from './cli_args.js';

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

async function waitForFirstWatcherPrice(watcher: CoinPriceWatcher, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (watcher.getCoinPrice() === undefined && Date.now() < deadline) await delay(TIMER_FAST);
    if (watcher.getCoinPrice() === undefined) {
        throw new Error(`History warm-up timeout: coin=${watcher.getCoin()} source=${watcher.getSource()} timeout=${timeoutMs}ms`);
    }
}

export async function runCollect(): Promise<void> {
    if (process.argv.includes('--help')) {
        writeOutput([
            'Usage: pm-bot collect --coin all --frame 5m --source chainlink-twap-60 [--count 1] [--cycle]',
            '',
            'The collector is read-only and waits for the next complete frame boundary.',
            'Without --cycle, --count limits collected frames. With --cycle, it limits retained complete frames per coin.',
            'Configuration: HISTORY_DIR, HISTORY_SNAPSHOT_MS, HISTORY_BOOK_DEPTH,',
            'HISTORY_GZIP, HISTORY_DIAGNOSTIC_FRAMES.',
            `Supported coins: ${getSupportedCoins().join(', ')}`,
            `Supported frames: ${getSupportedFrames().join(', ')}`,
            `Supported sources: ${getSupportedPriceSources().join(', ')}`,
        ].join('\n'));
        return;
    }

    const coinRaw = (readArgument('coin') ?? DEFAULT_HISTORY_COIN).toLowerCase();
    const frameRaw = (readArgument('frame') ?? DEFAULT_HISTORY_FRAME).toLowerCase();
    const sourceRaw = (readArgument('source') ?? DEFAULT_HISTORY_SOURCE).toLowerCase();
    if (coinRaw !== HISTORY_COIN_ALL && !isCoin(coinRaw)) {
        throw new Error(`Unsupported coin: ${coinRaw}. Supported: ${getSupportedCoins().join(', ')}`);
    }
    if (!isEventFrame(frameRaw)) {
        throw new Error(`Unsupported frame: ${frameRaw}. Supported: ${getSupportedFrames().join(', ')}`);
    }
    if (!isPriceSource(sourceRaw)) {
        throw new Error(`Unsupported source: ${sourceRaw}. Supported: ${getSupportedPriceSources().join(', ')}`);
    }

    const coins = coinRaw === HISTORY_COIN_ALL ? getSupportedCoins() : [coinRaw];
    const frame = frameRaw;
    const source = sourceRaw;
    const snapshotIntervalMs = readInteger('HISTORY_SNAPSHOT_MS', DEFAULT_HISTORY_SNAPSHOT_INTERVAL_MS, 25);
    const bookDepth = readInteger('HISTORY_BOOK_DEPTH', DEFAULT_HISTORY_BOOK_DEPTH, 1);
    if (bookDepth > 100) throw new Error(`HISTORY_BOOK_DEPTH must be <= 100, got ${bookDepth}`);
    const diagnosticRetentionFrames = readInteger(
        'HISTORY_DIAGNOSTIC_FRAMES', DEFAULT_HISTORY_DIAGNOSTIC_FRAMES, 0,
    );
    const directory = process.env.HISTORY_DIR || DEFAULT_HISTORY_DIRECTORY;
    const gzipEnabled = readBoolean('HISTORY_GZIP', DEFAULT_HISTORY_GZIP);
    const frameCount = readArgumentInteger('count', DEFAULT_HISTORY_FRAME_COUNT, 0);
    const cycle = process.argv.includes('--cycle');
    if (cycle && frameCount === 0) throw new Error('--cycle requires --count greater than 0');

    const priceWatchers = PriceWatcherFactory.createSharedCoinWatchers(source);
    const watchers = [...priceWatchers.values()];
    try {
        const warmUpTimeoutMs = getPriceSourceConfig(source).framePriceCaptureTimeoutMs;
        await Promise.all(watchers.map(watcher => waitForFirstWatcherPrice(watcher, warmUpTimeoutMs)));
        const collectorFrameCount = cycle ? 0 : frameCount;
        const writer = new HistoryFrameWriter({
            directory,
            gzip: gzipEnabled,
            maxFrames: 0,
            maxFramesPerCoin: cycle ? frameCount : 0,
            diagnosticRetentionFrames: cycle ? diagnosticRetentionFrames : 0,
            ...(cycle ? { retainedCoins: coins } : {}),
        });
        const collectors = coins.map(coin => new HistoryCollector(
            { coin, frame, snapshotIntervalMs, bookDepth, frameCount: collectorFrameCount },
            priceWatchers.get(coin)!, priceWatchers, writer,
        ));
        const unsubscribe = killSignalsHook(async () => {
            logger.info('[HistoryCollector] Shutdown signal received');
            collectors.forEach(collector => collector.stop());
        }, {
            onRepeatedSignal: () => process.exit(130),
        });

        logger.info(
            `[HistoryCollector] Config coins=${coins.join(',')} frame=${frame} source=${source} interval=${snapshotIntervalMs}ms ` +
            `depth=${bookDepth} gzip=${gzipEnabled} completeFrames=${cycle ? frameCount : 'none'} ` +
            `diagnosticFrames=${cycle ? diagnosticRetentionFrames : 'none'} count=${frameCount} cycle=${cycle} directory=${directory}`,
        );
        try {
            await Promise.all(collectors.map(collector => collector.run()));
        } finally {
            unsubscribe();
        }
    } finally {
        watchers.forEach(watcher => watcher.disconnect());
    }
}
