import 'dotenv/config';
import { globalDie } from '../die.js';
import { logger } from '../log.js';
import { FRAME_CONFIGS } from '../market/frame.js';
import { PriceWatcherFactory } from '../market/price/PriceWatcherFactory.js';
import { getTradingClient } from '../rest/client-env.js';
import { TIMER_FAST, TIMER_NORM } from '../timer.js';
import { readArgument } from './backtest_args.js';
import { ExecManager } from './core/ExecManager.js';
import { ExecScheduler } from './core/ExecScheduler.js';
import { CoinFrameEventTimerWatcher } from './core/events/CoinFrameEventTimerWatcher.js';
import { CoinCrossingPauseStrategy } from './core/events/strategy/CoinCrossingPauseStrategy.js';
import { CoinDogeBaselineStrategy } from './core/events/strategy/doge-baseline/CoinDogeBaselineStrategy.js';
import {
    DOGE_BASELINE_COIN,
    DOGE_BASELINE_CROSSING_DEVIATION_FACTOR,
    DOGE_BASELINE_FRAME,
    DOGE_BASELINE_DEFAULT_DEBUG,
    DOGE_BASELINE_MAX_CROSSINGS,
    DOGE_BASELINE_SOURCE,
} from './core/events/strategy/doge-baseline/DogeBaselineConfig.js';

function readDebugMode(): boolean {
    const raw = (readArgument('debug') ?? String(DOGE_BASELINE_DEFAULT_DEBUG)).toLowerCase();
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new Error(`--debug must be true/false or 1/0, got ${raw}`);
}

const isDebug = readDebugMode();
logger.info(
    `[DogeBaseline] Starting coin=${DOGE_BASELINE_COIN} frame=${DOGE_BASELINE_FRAME} ` +
    `source=${DOGE_BASELINE_SOURCE} virtual=${isDebug}`,
);
logger.info('[DogeBaseline] Initializing trading client');
const client = await getTradingClient();
logger.info('[DogeBaseline] Trading client ready');

logger.info(`[DogeBaseline] Waiting for the first ${DOGE_BASELINE_COIN} price from ${DOGE_BASELINE_SOURCE}`);
const coinWatcher = await PriceWatcherFactory
    .getCoinWatcher(DOGE_BASELINE_COIN, DOGE_BASELINE_SOURCE)
    .warmUp(TIMER_FAST);
logger.info(`[DogeBaseline] First ${DOGE_BASELINE_COIN} price received: ${coinWatcher.getCoinPrice()}`);

const masterScheduler = new ExecScheduler([
    async () => {
        const watcher = await CoinFrameEventTimerWatcher.create(DOGE_BASELINE_COIN, DOGE_BASELINE_FRAME, TIMER_FAST, coinWatcher);
        logger.info(`[DogeBaseline] Starting trading frame ${watcher.getEventId()}`);
        const strategy = await CoinDogeBaselineStrategy.create(watcher.getEventId(), isDebug, masterScheduler);
        return new ExecManager(client, [watcher], [strategy], isDebug);
    },
]);

const shadowScheduler = new ExecScheduler([
    async () => {
        const watcher = await CoinFrameEventTimerWatcher.create(DOGE_BASELINE_COIN, DOGE_BASELINE_FRAME, TIMER_FAST, coinWatcher);
        logger.info(`[DogeBaseline] Starting volatility guard for ${watcher.getEventId()}`);
        const strategy = await CoinCrossingPauseStrategy.createRelative(
            watcher.getEventId(),
            DOGE_BASELINE_COIN,
            masterScheduler,
            DOGE_BASELINE_MAX_CROSSINGS,
            DOGE_BASELINE_CROSSING_DEVIATION_FACTOR,
            DOGE_BASELINE_SOURCE,
        );
        return new ExecManager(client, [watcher], [strategy]);
    },
]);

const frameDurationMs = FRAME_CONFIGS[DOGE_BASELINE_FRAME].durationMs;
logger.info(`[DogeBaseline] Ready; waiting for the next ${DOGE_BASELINE_FRAME} frame boundary`);
await Promise.all([
    masterScheduler.start(frameDurationMs, TIMER_NORM),
    shadowScheduler.start(frameDurationMs, TIMER_NORM),
]);
await globalDie();
