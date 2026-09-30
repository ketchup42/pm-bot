# Minimal live integration

This reference shows how the live scheduler is assembled in TypeScript. It needs
valid local credentials because `getTradingClient()` can submit orders. For
collection, replay, and normal server operation, begin with the safer workflows in
the [README](../README.md) and [Deployment](deployment.md) instead.

> Treat this as an integration example, not a recommended first live strategy.
> Validate a strategy on settled history and run it in debug mode before allowing
> it to submit orders.

```ts
import { getTradingClient } from '../rest/client-env.js';
import { FRAME_5M_MS } from '../market/frame.js';
import { PS_CHAINLINK_TWAP_60 } from '../market/price/price_source.js';
import { PriceWatcherFactory } from '../market/price/PriceWatcherFactory.js';
import { TIMER_FAST, TIMER_NORM } from '../timer.js';
import { CoinFrameEventTimerWatcher } from './core/events/CoinFrameEventTimerWatcher.js';
import { ExecManager } from './core/ExecManager.js';
import { ExecScheduler } from './core/ExecScheduler.js';
import { LogCoinStrategy } from './core/events/strategy/LogCoinEventStrategy.js';

const client = await getTradingClient();
const priceWatcher = await PriceWatcherFactory
    .getCoinWatcher('btc', PS_CHAINLINK_TWAP_60)
    .warmUp(TIMER_FAST);

const scheduler = new ExecScheduler([
    async () => {
        const watcher = await CoinFrameEventTimerWatcher.create(
            'btc', '5m', TIMER_FAST, priceWatcher,
        );
        const strategy = new LogCoinStrategy();
        return new ExecManager(client, [watcher], [strategy], false);
    },
]);

await scheduler.start(FRAME_5M_MS, TIMER_NORM);
```

The scheduler aligns to the next 5-minute boundary. For every frame, it creates an
event watcher, invokes `strategy.execute()` every `TIMER_NORM` milliseconds, then
calls `strategy.cancel()` and disposes the watcher at the end.

Replace `LogCoinStrategy` only after validating the strategy in offline replay and
reviewing the trading lifecycle in [strategies.md](strategies.md).
