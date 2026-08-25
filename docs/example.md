## How to start?

A minimal start-to-run example wiring a single strategy for `doge` on the 5-minute
frame.

```typescript
import { getTradingClient } from "../rest/client-env.js";
import { PriceWatcherFactory } from "../market/price/PriceWatcherFactory.js";
import { PS_CHAINLINK } from "../market/price/price_source.js";
import { FRAME_5M_MS } from "../market/frame.js";
import { TIMER_FAST, TIMER_NORM } from "../timer.js";
import { CoinFrameEventTimerWatcher } from "./core/events/CoinFrameEventTimerWatcher.js";
import { MyStrategy } from "./core/events/strategy/MyStrategy.js";
import { ExecScheduler } from "./core/ExecScheduler.js";
import { ExecManager } from "./core/ExecManager.js";

// 1. Authenticated CLOB client (reads PRIVATE_KEY / API_* / FUNDER_ADDRESS / SIGNATURE_TYPE)
const client = await getTradingClient();

// 2. Coin price watcher (Chainlink source), warmed up so a price is available
const coin_watcher = await PriceWatcherFactory.getCoinWatcher('doge', PS_CHAINLINK).warmUp(TIMER_FAST);

const scheduler = new ExecScheduler([
    async () => {
        // 3. Frame watcher: snapshots price + order book every TIMER_FAST ms
        const watcher = await CoinFrameEventTimerWatcher.create('doge', '5m', TIMER_FAST, coin_watcher);

        // 4. Strategy trading the 'up' side
        const strategy = await MyStrategy.create(watcher.getEventId(), 'doge', 'up');

        // 5. One ExecManager per frame; debug=true dumps history on finish
        return new ExecManager(client, [watcher], [strategy], true);
    }
]);

// 6. Start the scheduler:
//    - align to 5-minute boundaries (FRAME_5M_MS)
//    - each ExecManager executes strategies every TIMER_NORM ms
await scheduler.start(FRAME_5M_MS, TIMER_NORM);
```

> `MyStrategy` is a placeholder — replace it with your own `EventStrategy`
> implementation before running.

See [`strategies.md`](strategies.md) for a full guide and [`abstractions.md`](abstractions.md)
for the layer details.
