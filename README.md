# PM-BOT

PM-BOT collects and analyses Polymarket up/down markets for supported coins and
time frames. It has two intentionally separate modes:

- **Research mode** is public and read-only: collect `HistoryFrameV2` files,
  confirm settlements, and replay registered strategy presets offline.
- **Live mode** uses authenticated CLOB credentials and can place orders. Treat it
  as operational software, not as a guarantee of profit.

Start with research mode. It is the shortest path to reproducible evidence before
changing a strategy or enabling any live execution.

## Quick start: research workflow

Requirements: Node.js **22.6+** and npm.

```bash
npm install

# Check the project without contacting a trading account.
npm run check

# Display the current supported coins, frames and price sources.
npm run collect -- --help

# Collect one BTC 5-minute frame. This command is read-only.
npm run collect -- --coin btc --frame 5m --source chainlink-twap-60 --count 1
```

The collector waits for the next frame boundary, records the complete frame, and
writes it to `history/frames` by default. Do not interrupt a one-frame run before
its `Saved ... complete=true` line.

When a market has resolved, confirm its actual outcome and replay only the usable
data:

```bash
# Updates unresolved HistoryFrameV2 files in HISTORY_DIR.
npm run history:settle

# Runs one deterministic preset and writes its report files.
npm run backtest -- --history history/frames --output history/reports/latest --strategy v2

# Runs every registered preset and writes a comparable matrix report.
npm run backtest:matrix -- --history history/frames --output history/reports/matrix/latest
```

`backtest:matrix` includes only frames with `data_quality.complete=true` and a
confirmed settlement. Its `manifest.json` explains every excluded frame.

## Commands

| Command                                                                                      | Purpose                                                                        |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `npm run dev`                                                                                | Run the live entry point from TypeScript.                                      |
| `npm run build`                                                                              | Compile `src/` into `dist/`.                                                   |
| `npm start`                                                                                  | Run the compiled live entry point.                                             |
| `npm run typecheck`                                                                          | Type-check without producing output.                                           |
| `npm run lint`                                                                               | Run static checks for source and tests.                                        |
| `npm run test:history`                                                                       | Build and run the repository test suite.                                       |
| `npm run test:coverage`                                                                      | Run the tests with Node's coverage report.                                     |
| `npm run check`                                                                              | Run type-checking, linting and tests.                                          |
| `npm run collect -- --coin btc --frame 5m --source chainlink-twap-60 --count 1`              | Collect public V2 history; `--count 0` runs until stopped.                     |
| `npm run history:settle`                                                                     | Confirm outcomes for collected V2 history.                                     |
| `npm run backtest -- --history history/frames --output history/reports/latest --strategy v2` | Replay one registered preset.                                                  |
| `npm run backtest:matrix -- --history history/frames --output history/reports/matrix/latest` | Replay every registered preset on eligible frames.                             |

## Data lifecycle

```text
public price + CLOB streams
           │
           ▼
      collect ──► HistoryFrameV2 files ──► history:settle ──► backtest / matrix
                                             │                         │
                                             ▼                         ▼
                                     confirmed outcome         reports and metrics
```

`complete=true` means the collector met its coverage, price-boundary and
connection-quality requirements. It does **not** mean that a strategy will be
profitable. Settlement confirmation is a separate, later step.

## Live mode and credentials

`npm run dev` and `npm start` construct an authenticated trading client. Configure
the required credentials in a local `.env`; never commit that file or its contents.
The exact variables, defaults and a placeholder-only example are in
[docs/env.md](docs/env.md).

The current live entry point uses BTC on 5-minute frames with the Chainlink 60s
TWAP price source and starts the trend-line V1/V2 strategies. Review
[`src/app/index.ts`](src/app/index.ts) before running it.

## Documentation map

| Document                                    | Read it when you need to...                                       |
| ------------------------------------------- | ----------------------------------------------------------------- |
| [Environment](docs/env.md)                  | Configure read-only collection, logging, dumps or live access.    |
| [Architecture](docs/abstractions.md)        | Navigate the collectors, watchers, history and replay layers.     |
| [Strategy guide](docs/strategies.md)        | Add or change an event strategy safely.                           |
| [Virtual wallets](docs/wallets.md)          | Understand simulated balances, orders and shutdown behaviour.     |
| [Live integration example](docs/example.md) | See the minimal scheduler/watcher/strategy wiring.                |

## Source-of-truth registries

Do not copy lists of supported instruments into callers. Change these registries
instead; their derived types and CLI validation update with them.

| Registry                                  | Owns                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| `src/market/coins.ts`                     | Supported coins and external-price precision.                |
| `src/market/frame.ts`                     | Supported frames and their durations.                        |
| `src/market/price/price_source.ts`        | Supported price sources and timeout/quality characteristics. |
| `src/app/core/backtest/replay_presets.ts` | Presets available to single replay and matrix replay.        |
