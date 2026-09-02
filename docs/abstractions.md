# Core Abstractions

Here's a quick tour of the main pieces and how they fit. Skim the
[README](../README.md) first if you haven't.

## Execution layer

### `ExecScheduler`

`src/app/core/ExecScheduler.ts`

- Constructed with a list of `SchedulerTickInitType` handlers — async functions that
  each return an `ExecManager`.
- `start(alignMs, execTickMs)`:
  1. waits until the next frame boundary (`waitFrameStartMs`),
  2. registers a global SIGINT/SIGTERM shutdown hook,
  3. loops: runs all init handlers, then runs every `ExecManager` concurrently.
- On shutdown it stops managers, flushes the logger and exits.

### `ExecManager`

`src/app/core/ExecManager.ts`

- Holds a `ClobClient`, a list of `EventWatcher`s and a list of `EventStrategy`s.
- `start(tick)`: loops while no watcher is finished; each iteration runs every
  strategy's `execute()` and then waits `tick` ms.
- The constructor's `debug` flag (`ExecManager(..., true)`) makes it dump each
  watcher's up/down history to JSON on shutdown (see [`env.md`](env.md#data-persistence)).

### `ExecTarget`

`src/app/core/exec_targets.ts`

- Type alias for the data produced by watchers and consumed by strategies. Currently
  `CoinFrameEventMarketData`.

## Domain types

| Type | Location | Description |
| --- | --- | --- |
| `Coin` | `market/coins.ts` | Derived from the canonical `COIN_CONFIGS` registry |
| `EventFrame` | `market/frame.ts` | Derived from the canonical `FRAME_CONFIGS` registry |
| `MarketSide` | `market/side.ts` | Derived from the canonical `MARKET_SIDES` registry |

Frame helpers in `market/frame.ts`:

- `FRAME_5M_MS`/`FRAME_15M_MS`, `FRAME_5M_SEC`/`FRAME_15M_SEC`
- `getCurrentFrameStart(frame)`, `getFrameDuration(frame)`
- `getCoinSlug(coin, frame)` — deterministic market slug, e.g.
  `doge-updown-5m-1742227200`
- `waitFrameStart(frame)` / `waitFrameStartMs(ms)`

### `CoinFrameEventMarketData`

`src/app/core/history/coin_frame.ts`

The per-side history object produced by `CoinFrameEventTimerWatcher`:

- `event_slug`, `eventId`, `marketId`
- `coin`, `side`
- `start_time`, `end_time` (unix seconds)
- `coin_frame_start_price`, `coin_frame_end_price`
- `side_token_market_snapshots: MarketTokenSnapshot[]`

`MarketTokenSnapshot` holds one tick's data: `coin_price`, `timestamp`, `asks`,
`bids`, `price`, `midpoint`, `spread`, optional `opt_price`.

This is the live scheduler's legacy dump contract. It remains available for
external analysis but is not consumed by the offline replay. The dedicated
collector writes `HistoryFrameV2` from `src/app/core/history/history_frame.ts`,
including paired books, source timestamps, connection gaps and settlement.

## Event watchers

### `EventWatcher<EventDataType>`

`src/app/core/events/EventWatcher.ts`

Anything the scheduler hands to strategies:

- `getEventId()`, `getMarketOrderBooksWatchers()`
- `getWatcherHistoryUp()`, `getWatcherHistoryDown()`
- `isActive()`, `isWatching()`, `isFinished()`, `dispose()`

### `CoinFrameEventTimerWatcher`

`src/app/core/events/CoinFrameEventTimerWatcher.ts`

The usual one is:

- Created via `CoinFrameEventTimerWatcher.create(coin, frame, tick, priceWatcher)`.
- Creates a `CoinMarketOrderBooksWatcher` for the coin's slug, records the frame
  start price, then on every `tick` pushes an up/down `MarketTokenSnapshot`.
- When the order book watcher reports the frame finished, it records the end price
  and sets `isFinished()`.

## Price watchers

| Type                   | Location                               | Notes                                                                                 |
| ------------------------| ----------------------------------------| ---------------------------------------------------------------------------------------|
| `PriceWatcher`         | `market/price/PriceWatcher.ts`         | Base contract: `getSymbol`, `getCurrentPrice`, `getTimeStamp`, `warmUp`, `disconnect` |
| `CoinPriceWatcher`     | `market/price/CoinPriceWatcher.ts`     | Adds `getCoin`, `getCoinPrice`, `getPriceByFrame`                                     |
| `CoinPriceWatcherRTDS` | `market/price/CoinPriceWatcherRTDS.ts` | RTDS implementation; captures per-frame prices                                        |
| `PriceWatcherFactory`  | `market/price/PriceWatcherFactory.ts`  | Singleton cache per `(coin, source)`                                                  |

- `PriceSource` (`market/price/price_source.ts`): `'binance'` (`PS_BINANCE`) or
  `'chainlink'` (`PS_CHAINLINK`).
- `getCoinPrice()` returns the RTDS price rounded to the coin's precision
  (`coin_precis`).
- `getPriceByFrame(frame, timeoutMs)` waits for the captured start-of-frame price.

## Order book watchers

| Type | Location | Notes |
| --- | --- | --- |
| `MarketOrderBooksWatcher` | `market/orderbook/watcher/MarketOrderBooksWatcher.ts` | Interface + `EventMarketData`/`TokenMarketData`/`LiquidityInfo` |
| `LiveMarketOrderBooksWatcher` | `market/orderbook/watcher/LiveMarketOrderBooksWatcher.ts` | Generic implementation over `WSSubscriptionManager` |
| `CoinMarketOrderBooksWatcher` | `market/orderbook/watcher/CoinMarketOrderBooksWatcher.ts` | `create(slug)` → fetches event by slug, subscribes to up/down token books |

Under the hood:

- `WSSubscriptionManager` — one WebSocket connection, subscription tracking,
  reconnection, event routing (`onBook`, `onPriceChange`, `onLastTradePrice`,
  `onTickSizeChange`, `onPolymarketPriceUpdate`).
- `OrderBookCache` — per-asset `bids`/`asks` + derived `price`/`midpoint`/`spread`.

Sorting matters for best-price math: **bids ascending, asks descending**, so the
best bid/ask is always the *last* element of its array.

Key methods on `MarketOrderBooksWatcher`:

- `getBidsUp/getAsksUp/getBidsDown/getAsksDown`, `getBestBid(side)`, `getBestAsk(side)`
- `getUpPrice/getDownPrice`, `getUpMidpoint/getDownMidpoint`, `getUpSpread/getDownSpread`
- `getUpBidLiquidity` and friends → `LiquidityInfo { total_size, total_cost, average_price }`
- `getMarketData()` → `EventMarketData` (tick size, min order size, fees, rewards,
  up/down token ids)
- `isActive()`, `isWatching()`, `isFinished()`, `isUpBooked()`, `isDownBooked()`

## Orders watchers

| Type | Location | Notes |
| --- | --- | --- |
| `OrdersWatcher` | `market/orders/watcher/OrdersWatcher.ts` | Interface + `OrderStatus`, `OrderUpdateHandler` |
| `LiveOrdersWatcherRTDS` | `market/orders/watcher/LiveOrdersWatcherRTDS.ts` | User-channel WebSocket, syncs open orders on connect |

`OrderStatus` fields: `id`, `token_id`, `market`, `original_size`, `size_matched`,
`price`, `side`, plus derived flags `has_size_matched`, `has_size_matched_partial`,
`is_live`, `has_canceled`.

Wallets register an `OrderUpdateHandler` per order and get called on every fill
update, see [`wallets.md`](wallets.md).

## Wallets

`src/market/orders/`

- `OrderWallet` (`OrderWallet.ts`) defines the common contract: `buy`, `sell`,
  `cancel_order`, `cancel_all`, balance/tokens getters and `dispose`. Also exports
  `OrderWalletState` and `OrderWalletParams`.
- `PairOrderWallet` keeps one buy order and one sell order at a time.
- `LiveOrderWallet` can hold many orders and reserves balance/tokens
  (`getAvailableBalance`, `getAvailableTokens`). This is the one you want for
  strategies.
- `MultiOrderWallet` extends `OrderWallet` with the available-balance getters.

Wallets are covered in detail in [`docs/wallets.md`](wallets.md).

## REST layer

`src/rest/`

- `client-env.ts` — `getTradingClient()` (authenticated `ClobClient`),
  `getPublicClient()`, `getEnvApiKeyCreds()`, plus env validation and a geo-block
  check.
- `scan.ts` — Gamma API: `fetchEventBySlug`, `fetchMarketById`, `EventRaw`/`MarketRaw`.
- `orders.ts` — `placeMakerOrder`, `cancelOrder`, `placeFokMarketOrderBuy`,
  `getUSDBalance`, and the size/value constants (`DEFAULT_ORDER_MIN_SIZE`,
  `DEFAULT_BUY_ORDER_MIN_VALUE`, `DEFAULT_ORDER_AMOUNT_FRACTION`).
- `orders-price.ts` — `tick_price` (rounds buys down, sells up, clamps to
  `[tick, 1 - tick]`) and `valid_quantity_safe/unsafe`.
- `price.ts` — order book helpers like `getPriceByTokenId` and `isBidsEmpty`.
- `fees.ts`, `block.ts`, `hosts.ts` — fees, geo-blocking, host constants.

## Infrastructure utilities

| Module         | Purpose                                                                                                                   |
| ----------------| ---------------------------------------------------------------------------------------------------------------------------|
| `src/timer.ts` | `TickTimer` + `TIMER_SLOW`/`TIMER_NORM`/`TIMER_FAST` (100/50/25 ms)                                                       |
| `src/log.ts`   | Winston `logger` + `logger_shutdown`; console/file transports driven by env vars                                          |
| `src/dump.ts`  | Rotating JSON `dumper` for history snapshots                                                                              |
| `src/utils.ts` | `delay`, `retry`, `safeToNum`, `safeFloat`, `roundTo`, `isValid`, `error_str`, `fileWrite`, `killSignalsHook`, timestamps |
