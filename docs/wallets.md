# Virtual Wallets for Trading Strategies

Each strategy operates with its **own virtual balance**, even if all strategies share the same exchange account. The wallet automatically enforces exchange constraints (tick size, minimum order size, minimum buy value), places limit orders, and tracks their execution via a WebSocket watcher. You don't need to update the balance manually — the wallet does it for you.

## What the wallet can do

- Maintain its own virtual USD balance and token quantity.
- Place limit buy and sell orders that comply with exchange rules.
- Automatically account for partial fills, cancellations, and complete fills.
- Instantly handle orders that are filled immediately (status `matched`) at the actual trade price.
- Prevent spending more than the virtual balance (by reserving funds for active orders).
- On shutdown, cancel all orders and, optionally, sell remaining tokens at market price.

## How to create a wallet

You need:

1. **A CLOB client** (`ClobClient`) – to send requests to the exchange.
2. **Market parameters** – token, tick size, minimum order size, minimum buy value (usually obtained from the `MarketData` of your watcher).
3. **An orders watcher** (`OrdersWatcher`) – to monitor your orders in real time.

### Simple wallet (`PairOrderWallet`)

Holds **only one buy order and one sell order** at a time. Suitable for most strategies.

```typescript
import { PairOrderWallet } from './path/to/wallet.js';
import { LiveOrdersWatcherRTDS } from './path/to/watcher.js';

// 1. Create an orders watcher (using conditionId)
const watcher = await LiveOrdersWatcherRTDS.create(conditionId, client, apiCreds);

// 2. Create a wallet with a virtual balance of 5 USD
const wallet = await PairOrderWallet.create(client, {
    token_id: tokenId,
    balance: 5,
    tick_size: 0.01,
    min_order_size: 5,
    min_buy_order_value: 1
}, watcher);

// 3. Place a limit buy order
const buyState = await wallet.buy(0.52, 5);
if (buyState) {
    console.log(`Order placed, ID = ${buyState.id}`);
    if (buyState.fast_full_trade) {
        console.log('Order was filled instantly!');
    }
}

// 4. Later – cancel all orders and sell tokens before exiting
await wallet.dispose(true);   // true – sell remaining tokens at market