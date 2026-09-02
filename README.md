# PM-BOT

Trades Polymarket's up/down coin markets on 5- and 15-minute frames. Watches live
prices and order books, runs strategies against virtual wallets, and can dump each
frame's history to JSON for later study.

## Features

- Live prices from Polymarket's Real-Time Data Service (RTDS), for both Binance and
  Chainlink feeds.
- Order books streamed over the CLOB WebSocket. Best bid/ask, midpoint, spread and
  liquidity are all exposed.
- Virtual wallets that enforce tick size, min order size and min buy value, and keep
  track of fills and cancellations on their own.
- Strategies are just classes implementing `EventStrategy`, the scheduler runs them
  on a frame-aligned loop.
- Debug mode dumps every frame's history to JSON, handy for backtesting.
- Logging through Winston — console and rotating file, both optional.

## Installation

Requirements: **Node.js 22.6+** (the `dev` script uses `--experimental-strip-types`),
npm.

```bash
npm install
```

Create a `.env` file with your wallet/API credentials and optional logging/dump
settings. The full variable reference is in [`docs/env.md`](docs/env.md).

Run in dev mode (native TypeScript):

```bash
npm run dev
```

Or build and run the compiled output:

```bash
npm run build
npm start
```

### Scripts

| Script              | Description                                    |
| ---------------------| ------------------------------------------------|
| `npm run dev`       | Run `src/app/index.ts` via Node type-stripping |
| `npm run build`     | Compile TypeScript to `dist/` (`tsc`)          |
| `npm start`         | Run compiled `dist/app/index.js`               |
| `npm run typecheck` | Type-check without emitting (`tsc --noEmit`)   |
| `npm run collect -- --coin btc --frame 5m --source chainlink-twap-60 --count 1` | Collect a fixed number of public frames without placing orders (`0` = continuous) |
| `npm run history:settle` | Confirm settlement for collected V2 frames |
| `npm run backtest -- --history history/frames --output history/reports/latest` | Run the deterministic V2 no-trade replay baseline |
| `npm run test:history` | Build and test history collection and replay |

## Documentation

- [`docs/env.md`](docs/env.md) — environment variables & `.env` example.
- [`docs/abstractions.md`](docs/abstractions.md) — core abstractions and layers.
- [`docs/strategies.md`](docs/strategies.md) — adding & debugging strategies.
- [`docs/wallets.md`](docs/wallets.md) — virtual wallet usage.
- [`docs/example.md`](docs/example.md) — minimal start-to-run example.
