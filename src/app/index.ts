import { logger } from "../log.js";
import { FRAME_5M_MS } from "../market/frame.js";
import { PS_CHAINLINK_TWAP_60 } from "../market/price/price_source.js";
import { getTradingClient } from "../rest/client-env.js";
import { TIMER_FAST, TIMER_NORM } from "../timer.js";
import { CoinFrameEventTimerWatcher } from "./core/events/CoinFrameEventTimerWatcher.js";
import { ExecScheduler } from "./core/ExecScheduler.js";
import { ExecManager } from "./core/ExecManager.js";
import { PriceWatcherFactory } from "../market/price/PriceWatcherFactory.js";
import { CoinTrendLineStrategyV1 } from "./core/events/strategy/CoinTrendLineStrategyV1.js";
import { CoinTrendLineStrategyV2 } from "./core/events/strategy/CoinTrendLineStrategyV2.js";
import { globalDie } from "../die.js";
import { CoinCrossingPauseStrategy } from "./core/events/strategy/CoinCrossingPauseStrategy.js";

logger.info("If you see this in the file, logging works fine:)");

const client = await getTradingClient();
const coin_watcher = await PriceWatcherFactory.getCoinWatcher('btc', PS_CHAINLINK_TWAP_60).warmUp(TIMER_FAST);

const master_scheduler = new ExecScheduler([
    async () => {
        const watcher = await CoinFrameEventTimerWatcher.create('btc', '5m', TIMER_FAST, coin_watcher);

        const strategyUpV1 = await CoinTrendLineStrategyV1.create(watcher.getEventId(), 'btc', 'up', true);
        const strategyDownV1 = await CoinTrendLineStrategyV1.create(watcher.getEventId(), 'btc', 'down', true);

        const strategyUpV2 = await CoinTrendLineStrategyV2.create(watcher.getEventId(), 'btc', 'up', true);
        const strategyDownV2 = await CoinTrendLineStrategyV2.create(watcher.getEventId(), 'btc', 'down', true);
        return new ExecManager(client,
            [
                watcher
            ],
            [
                strategyUpV1,
                strategyDownV1,
                strategyUpV2,
                strategyDownV2
            ],
            true)
    }
]);

const BTC_MAX_CROSS_COUNT = 1;
const BTC_DEVIATION_SIZE = 3.9;

const shadow_scheduler = new ExecScheduler([
    async () => {
        const watcher = await CoinFrameEventTimerWatcher.create('btc', '5m', TIMER_FAST, coin_watcher);
        const cross_strategy = await CoinCrossingPauseStrategy.create(watcher.getEventId(), 'btc', master_scheduler,  BTC_MAX_CROSS_COUNT, BTC_DEVIATION_SIZE);

        return new ExecManager(client,
        [
            watcher
        ],
        [
            cross_strategy
        ])
    }
]);

await Promise.all([master_scheduler.start(FRAME_5M_MS, TIMER_NORM), shadow_scheduler.start(FRAME_5M_MS, TIMER_NORM)]);

await globalDie();