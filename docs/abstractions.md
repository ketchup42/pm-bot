# Architecture

The project separates live execution from historical research. The separation is
intentional: a public collector must not initialise a trading client, and an offline
replay must not need any network connection.

```text
Live execution: price watcher + CLOB book → event watcher → strategy → wallet → CLOB

Research:       price watcher + CLOB book → HistoryFrameV2 → settlement → replay report
```

## Canonical domain registries

These files define the supported runtime values. Their exported types and validation
helpers are derived from the registry, so change the registry rather than duplicating
its lists elsewhere.

| Type / registry      | Location                                  | Responsibility                                  |
| -------------------- | ----------------------------------------- | ----------------------------------------------- |
| `Coin`               | `market/coins.ts`                         | Coin symbols and price precision.               |
| `EventFrame`         | `market/frame.ts`                         | Frame IDs, durations and boundary helpers.      |
| `MarketSide`         | `market/side.ts`                          | The `up` and `down` token sides.                |
| `PriceSource`        | `market/price/price_source.ts`            | Source IDs and stream-quality timeouts.         |
| Replay preset        | `app/core/backtest/replay_presets.ts`     | Single replay and matrix strategy registry.     |

`getSupportedCoins()`, `getSupportedFrames()` and `getSupportedPriceSources()` feed
the collector CLI. `waitFrameStartMsUntil()` centralises cancellable waits for frame
boundaries.

## Live execution layer

| Component                       | Location                                           | Responsibility                                          |
| ------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `ExecScheduler`                 | `app/core/ExecScheduler.ts`                        | Aligns work to frame boundaries and manages managers.   |
| `ExecManager`                   | `app/core/ExecManager.ts`                          | Runs strategies against active event watchers.          |
| `CoinFrameEventTimerWatcher`    | `app/core/events/CoinFrameEventTimerWatcher.ts`    | Captures a live coin frame and its two token books.     |
| `EventStrategy`                 | `app/core/events/strategy/EventStrategy.ts`        | Contract implemented by live strategies.                |
| `OrderWallet`                   | `market/orders/OrderWallet.ts`                     | Virtual balance, order lifecycle and exchange limits.   |

The live entry point is `src/app/index.ts`. It creates an authenticated client and
is therefore separate from `collect`, `history:settle` and replay commands.

## Market data watchers

| Component                     | Location                                                  | Responsibility                                                       |
| ----------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------- |
| `CoinPriceWatcher`            | `market/price/CoinPriceWatcher.ts`                        | Coin price, timestamp, frame-boundary capture and connection events. |
| `CoinPriceWatcherRTDS`        | `market/price/CoinPriceWatcherRTDS.ts`                    | RTDS implementation for regular price sources.                       |
| `CoinPriceWatcherTWAP`        | `market/price/CoinPriceWatcherTWAP.ts`                    | Chainlink 30s/60s TWAP implementation.                               |
| `PriceWatcherFactory`         | `market/price/PriceWatcherFactory.ts`                     | Cached watcher per `(coin, source)`.                                 |
| `CoinMarketOrderBooksWatcher` | `market/orderbook/watcher/CoinMarketOrderBooksWatcher.ts` | Resolves a slug and watches paired up/down CLOB books.               |
| `WSSubscriptionManager`       | `market/orderbook/manager/WSSubscriptionManager.ts`       | CLOB subscriptions, routing and reconnects.                          |

`getPriceByFrame()` supplies the start/end price captured at a precise frame
boundary. It is not a generic "latest price" lookup. Books expose bids, asks,
midpoint, spread, liquidity and market constraints for both token sides.

## History V2 and settlement

`HistoryFrameV2` is the research data contract. Each file contains the selected
coin/frame/source, exact frame boundaries, paired order-book snapshots, captured
start/end coin prices, connection events, data gaps, market metadata, settlement
and a data-quality verdict.

| Field group                      | Why it matters                                              |
| -------------------------------- | ----------------------------------------------------------- |
| `snapshots`                      | Timestamped coin price and best-depth CLOB books.           |
| `coin_frame_*_price`             | Price captured at the actual beginning/end of the frame.    |
| `connection_events`, `data_gaps` | Evidence for stream interruptions and stale observations.   |
| `data_quality`                   | Whether coverage and connection criteria permit normal use. |
| `settlement`                     | Derived outcome plus later-confirmed market result.         |

`complete=true` is a collection-quality label. `history:settle` independently
fetches the event again and writes `confirmed_outcome` once the market is closed.
The legacy live scheduler dumps are retained for external analysis but are not
`HistoryFrameV2` and are not replay inputs.

## Offline replay

| Component           | Location                             | Responsibility                                               |
| ------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `ReplayStrategy`    | `app/core/backtest/replay.ts`        | Pure per-snapshot trading decision contract.                 |
| `simulateTakerFill` | `app/core/backtest/replay.ts`        | Applies book depth, fee, balance and token constraints.      |
| `runReplay`         | `app/core/backtest/replay.ts`        | Calculates fills, settlement value, PnL and risk metrics.    |
| `runReplayMatrix`   | `app/core/backtest/replay_matrix.ts` | Replays every preset over the same eligible frame set.       |

The report separates theoretical PnL before execution costs, PnL before fees, and
net PnL. Fees, spread crossing and book-walk slippage are reported independently,
so no single gross number hides execution cost.

## REST and utilities

| Module               | Responsibility                                                   |
| -------------------- | ---------------------------------------------------------------- |
| `rest/scan.ts`       | Reads Gamma events/markets and normalises optional API fields.   |
| `rest/fees.ts`       | Fee-rate and taker-fee calculation.                              |
| `rest/client-env.ts` | Validates live credentials and builds CLOB clients.              |
| `utils.ts`           | Shared conversion, retry, file-write, error and signal helpers.  |
| `log.ts`             | Winston logger and orderly shutdown.                             |
