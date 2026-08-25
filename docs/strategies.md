# Adding & Debugging Strategies

How a strategy lives through a frame, plus how to write and debug your own. The
pieces it uses are described in [`docs/abstractions.md`](abstractions.md).

## What a strategy looks like

`src/app/core/events/strategy/EventStrategy.ts`:

```ts
export interface EventStrategy<EventDataType> {
    execute(client: ClobClient, watchers: readonly EventWatcher<EventDataType>[]): Promise<boolean>;
    cancel(client: ClobClient, watchers: readonly EventWatcher<EventDataType>[]): Promise<boolean>;
}
```

- `execute` is called on **every tick** by `ExecManager` while the frame is active.
  Return `true` if something was done, `false` otherwise.
- `cancel` is called once at the end of the frame (or on shutdown) to roll back
  state and dispose resources.

### Lifecycle

1. `ExecScheduler.start` waits for the next frame boundary and creates the
   `ExecManager` via the init handler.
2. `ExecManager.start` runs `strategy.execute(...)` every `tick` ms until the watcher
   reports `isFinished()`.
3. On finish, `ExecManager.die()` calls `strategy.cancel(...)` and then disposes the
   watchers (dumping history first if the manager is in debug mode).

## Step-by-step: add a new strategy

### 1. Create the file

```ts
import { ClobClient } from "@polymarket/clob-client-v2";
import { EventStrategy } from "./EventStrategy.js";
import { CoinFrameEventMarketData } from "../../history/coin_frame.js";
import { EventWatcher } from "../EventWatcher.js";
import { logger } from "../../../../log.js";

export class MyStrategy implements EventStrategy<CoinFrameEventMarketData> {
    // ...
}
```

### 2. Constructor + factory

```ts
private constructor(eventId: string, coin: Coin, side: MarketSide) { /* store */ }

public static async create(eventId: string, coin: Coin, side: MarketSide): Promise<MyStrategy> {
    return new MyStrategy(eventId, coin, side);
}
```

Store `_eventId` (used to find your watcher), the `coin` and `side` you trade.

### 3. Find your watchers inside `execute`

```ts
if (!this._event)   this._event   = watchers.find(w => w.getEventId() === this._eventId);
if (!this._market)  this._market  = this._event?.getMarketOrderBooksWatchers()?.[0];
if (!this._frameTime) { /* read start_time/end_time from getWatcherHistoryUp/Down()[0] */ }
```

### 4. Create a virtual wallet once

```ts
if (!this._wallet) {
    const marketData = this._market.getMarketData();
    const sideData = this._side === 'up' ? this._market.getUpMarketData() : this._market.getDownMarketData();
    this._wallet = await LiveOrderWallet.create(client, {
        token_id: sideData.tokenId,
        balance: 5,
        tick_size: marketData.tick_size,
        min_order_size: marketData.min_order_size,
        min_buy_order_value: DEFAULT_BUY_ORDER_MIN_VALUE,
    }, await LiveOrdersWatcherRTDS.create(marketData.conditionId, client, client!.creds));
}
```

### 5. Trading rules

Read the book with `getBestAsk(side)` / `getBestBid(side)` and place orders:

```ts
const ask = this._market.getBestAsk(this._side);
const bid = this._market.getBestBid(this._side);
if (ask === undefined || bid === undefined) return false;

// Taker entry: cross the ask by one tick.
await this._wallet.buy(ask + this._wallet.getTick(), 5);

// Taker exit: cross the bid by one tick.
await this._wallet.sell(bid - this._wallet.getTick(), this._wallet.getTokensQuantity());
```

- `wallet.buy/sell` internally apply `tick_price` (rounds buy down, sell up) and
  clamp to `[tick, 1 - tick]`.
- A crossing order is posted with `postOnly=false`, so it fills right away
  (`fast_full_trade`); the wallet records the actual fill price from the trade data.
- Track order references and clear them when `!wallet.isLive(id)`.

### 6. `cancel()`

```ts
public async cancel(client, watchers): Promise<boolean> {
    if (this._wallet) await this._wallet.dispose(true); // cancel orders + sell remaining tokens
    // reset all per-frame state
    this._wallet = undefined;
    this._event = undefined;
    this._market = undefined;
    this._frameTime = undefined;
    return true;
}
```

`dispose(true)` liquidates the remaining position at the end of the frame; use
`dispose(false)` to keep the position instead.

### 7. Wire it into `index.ts`

```ts
const client = await getTradingClient();
const coin_watcher = await PriceWatcherFactory.getCoinWatcher('doge', PS_CHAINLINK).warmUp(TIMER_FAST);

const scheduler = new ExecScheduler([
    async () => {
        const watcher = await CoinFrameEventTimerWatcher.create('doge', '5m', TIMER_FAST, coin_watcher);
        const strategy = await MyStrategy.create(watcher.getEventId(), 'doge', 'up');
        return new ExecManager(client, [watcher], [strategy], true);
    }
]);

await scheduler.start(FRAME_5M_MS, TIMER_NORM);
```

## Debugging

- **Verbose logs**: set `LOG_LEVEL=debug` (console) and/or `LOG_FILE` +
  `LOG_FILE_LEVEL=debug` for a file. See [`docs/env.md`](env.md).
- **History dumps**: set `DUMPS_DIR=history` and pass `debug = true` to
  `ExecManager`. On frame end it writes each watcher's up/down history to JSON,
  which you can inspect (or replay later).
- **No-op strategy**: `LogCoinEventStrategy` just logs `execute`/`cancel` calls —
  useful to verify the pipeline before adding real logic.

### Common pitfalls

- **Book not booked yet**: `getBestAsk/getBestBid` return `undefined` until the first
  snapshot arrives. Guard with `if (ask === undefined || bid === undefined) return false;`.
- **Taker price clamping**: buying `ask + tick` near `1.0` gets clamped to
  `1 - tick`; the order may rest instead of filling. Same for selling near the tick
  floor.
- **Forced liquidation**: with `dispose(true)`, a position opened right before the
  frame ends gets sold at the tick price. Use an end-of-frame cutoff (e.g. stop
  entering after `progress > 0.9`) to avoid this.
- **Min order size / value**: the wallet rejects orders below `min_order_size` or
  `min_buy_order_value`; check the values from `getMarketData()`.
- **Insufficient balance**: `wallet.buy` returns `undefined` when the order value
  exceeds the virtual balance.
