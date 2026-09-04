# Virtual wallets

A wallet gives one strategy an isolated virtual cash balance and token inventory
while it uses the shared Polymarket account. It validates exchange constraints,
tracks the associated orders and prevents the strategy from reserving the same
virtual balance twice.

## Choose a wallet

| Wallet                         | Use it when...                                                    |
| ------------------------------ | ----------------------------------------------------------------- |
| `PairOrderWallet`              | The strategy keeps at most one buy and one sell order.            |
| `LiveOrderWallet`              | The strategy may hold multiple independent active orders.         |
| `VirtualTakerLiveOrderWallet`  | You need virtual taker-style execution over live order data.      |

All wallets implement `OrderWallet`; wallets that expose available cash and tokens
also implement `MultiOrderWallet`.

## Required inputs

Create an order watcher for the market condition and pass its current market
constraints into the wallet. Obtain these values from the event market watcher; do
not hard-code them.

```ts
const marketData = marketWatcher.getMarketData();
const sideData = marketWatcher.getUpMarketData();
const ordersWatcher = await LiveOrdersWatcherRTDS.create(
    marketData.conditionId,
    client,
    client.creds,
);

const wallet = await LiveOrderWallet.create(client, {
    token_id: sideData.tokenId,
    balance: 5,
    tick_size: marketData.tick_size,
    min_order_size: marketData.min_order_size,
    min_buy_order_value: 1,
}, ordersWatcher);
```

## Order and shutdown behaviour

| Operation               | Behaviour                                                            |
| ----------------------- | -------------------------------------------------------------------- |
| `buy(price, quantity)`  | Validates tick, minimum size/value and available virtual cash.       |
| `sell(price, quantity)` | Validates tick, quantity and available virtual tokens.               |
| `cancel_order(id)`      | Requests cancellation and releases its reservation after the update. |
| `cancel_all()`          | Cancels every active wallet order.                                   |
| `dispose(false)`        | Cancels active orders while retaining the position at frame end.     |
| `dispose(true)`         | Cancels active orders and attempts to liquidate remaining tokens.    |

`buy` and `sell` may return `undefined` when validation fails or no order is
created. Always handle that result, and do not assume a submitted limit order has
filled until the order watcher reports the state.

For strategy lifecycle and safe book reads, see [strategies.md](strategies.md).
