# Wallets

A wallet gives one strategy an isolated virtual cash balance and token inventory
while it uses the shared Polymarket account. It validates exchange constraints,
tracks the associated orders and prevents the strategy from reserving the same
virtual balance twice.

## Choose a wallet

| Wallet                         | Use it when...                                                       |
| ------------------------------ | -------------------------------------------------------------------- |
| `PairOrderWallet`              | The strategy keeps at most one buy and one sell maker order.        |
| `LiveOrderWallet`              | The strategy may hold multiple independent active maker orders.     |
| `TakerLiveOrderWallet`         | Real orders must execute immediately or be cancelled.               |
| `VirtualTakerLiveOrderWallet`  | You need virtual taker-style execution over live order data.        |

All wallets implement `OrderWallet`; wallets that expose available cash and tokens
also implement `MultiOrderWallet`.

## Required inputs

Pass current market constraints into every wallet. Obtain them from the event
market watcher; do not hard-code them. `LiveOrderWallet`, `PairOrderWallet` and
`TakerLiveOrderWallet` require an order watcher. For the taker wallet it is used
only to recover a known order when a request fails after submission.

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
    fees_enabled: marketData.fees_enabled,
    taker_base_fee: marketData.taker_base_fee,
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

`VirtualTakerLiveOrderWallet` is immediate by design. It walks every executable
level currently visible in the live book, records a volume-weighted average price,
charges the configured taker fee and leaves an unfilled remainder in the virtual
position. A caller that needs full liquidation must retry that remainder when new
bid depth appears.

`TakerLiveOrderWallet` sends a marketable GTC limit order with `postOnly=false`,
reads its immediate execution and cancels any remaining quantity before returning.
It records the final fill status, actual VWAP and fees from the CLOB trade records;
only trades labelled `TAKER` by the exchange are charged a taker fee. It uses an
`OrdersWatcher` only when a request fails after the exchange has returned an order ID:
the watcher retains that order until it can be cancelled and reconciled.

For a resolved binary frame, `settle(outcome)` pays $1 per remaining virtual token
when the outcome matches the wallet side, and $0 otherwise. Settlement clears the
position and does not walk the book or charge an exit fee; it must not be
substituted with a sale at a final bid such as $0.99.

For strategy lifecycle and safe book reads, see [strategies.md](strategies.md).
