# PM-BOT

PM-BOT collects and researches Polymarket up/down markets for supported coins and
time frames. Research mode uses public data only; live mode can submit real orders.

Start with research. It provides reproducible data and tests hypotheses with
execution costs before changing a strategy or enabling trading.

## Research quick start

Requirements: Node.js **22.6+** and npm.

```bash
npm install

# Check types, style and tests without accessing a trading account.
npm run check

# Show the current coins, frames and price sources.
npm run collect -- --help

# Collect one frame for every coin in market/coins.ts.
env HISTORY_SNAPSHOT_MS=50 \
  npm run collect -- --coin all --frame 5m --source chainlink-twap-60 --count 1
```

The collector waits for the next frame boundary and writes one target frame for
each supported coin. Every `HistoryFrameV3` file contains Up/Down order books and
a price basket for every coin from the same source that determines the target
market outcome. Do not interrupt a one-frame run before its
`Saved ... complete=true` line.

At 50 ms, a five-minute frame expects 6,000 snapshots per target;
`complete=true` requires at least 5,700. The current registry has six targets, so
a full interval can write up to 36,000 snapshots. See [docs/env.md](docs/env.md)
for configuration details and the continuous collection command.

The collector uses one shared price connection for the complete basket of its
selected source. It reconnects after ten seconds without an update for an active
coin, while preserving the strict V3 freshness checks. Failed connection attempts
use a capped exponential delay from one second up to thirty seconds.

After markets close, confirm their outcomes and run analysis only on usable data:

```bash
# Writes confirmed outcomes into unresolved V3 frames.
npm run history:settle

# Runs one registered preset and writes a report.
npm run backtest -- --history history/frames --output history/reports/latest --strategy v2

# Runs every registered preset on the same data set.
npm run backtest:matrix -- --history history/frames --output history/reports/matrix/latest

# Train both DOGE baseline entries on the newest 500 eligible frames.
npm run research:doge-baseline -- --count 500

# Replay the published model with fees, spread, slippage and book depth.
npm run replay:doge-baseline -- --history history/frames --output history/reports/doge-baseline/latest
```

The matrix uses only frames with `data_quality.complete=true` and a confirmed
outcome. Its `manifest.json` lists excluded files and their reasons.

## Commands

| Command                                                                                      | Purpose                                                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `npm run dev`                                                                                | Run the original live entry point from TypeScript.                       |
| `npm run build`                                                                              | Compile `src/` into `dist/`.                                             |
| `npm start`                                                                                  | Run the compiled original live entry point.                              |
| `npm run check`                                                                              | Run type-checking, linting and tests.                                    |
| `npm run collect -- --coin doge --frame 5m --source chainlink-twap-60 --count 500 --cycle`   | Continuously retain the newest 500 DOGE frames.                          |
| `npm run history:settle`                                                                     | Confirm outcomes for collected V3 frames.                                |
| `npm run backtest -- --history history/frames --strategy v2`                                 | Replay one registered reference preset.                                  |
| `npm run backtest:matrix -- --history history/frames`                                        | Compare all registered reference presets.                                |
| `npm run research:doge-baseline -- --count 500`                                              | Train and atomically publish the two-mode DOGE model.                    |
| `npm run replay:doge-baseline -- --history history/frames`                                   | Replay the published DOGE model without retraining it.                   |
| `npm run strategy:doge-baseline -- --debug true`                                             | Run DOGE with a virtual wallet; `false` enables real orders.             |
| `npm run model-refresh:doge-baseline -- --frame 5m --count 100 --train-count 500`            | Settle and retrain immediately, then every 100 frame boundaries.         |

## Data lifecycle

```text
selected-source prices + CLOB order books
                  │
                  ▼
collect → HistoryFrameV3 → history:settle → research:doge-baseline → model.json
                              │                                      │
                              └──────── replay:doge-baseline ◀────────┘
                                                                     │
                                                                     ▼
                                                      strategy:doge-baseline
```

`complete=true` describes collection quality: snapshot coverage, boundary prices
and connection state. It does **not** mean that a strategy is profitable. Outcome
confirmation is a separate later operation.

The DOGE model contains two independent logistic-regression modes. The early mode
decides at 60 seconds from 15/30/60-second returns. If it does not enter, the late
mode decides at 120 seconds from 75/90/120-second returns. The replay command uses
the already published model and applies the same prediction-side entry rule. Market
price can reject the predicted trade but cannot switch it to the opposite side. An
emergency exit is allowed in the final 30 seconds after DOGE remains one basis point
against the position for five seconds.

## Live mode and secrets

`npm run dev` and `npm start` create an authenticated trading client. Configure it
in a local `.env`, which must never be committed or written to logs. The complete
variable list and a placeholder-only example are in [docs/env.md](docs/env.md).

`strategy:doge-baseline` defaults to a virtual wallet, but the current scheduler
still initialises an authenticated client in both modes. Passing `--debug false`
enables real orders. Review the model and its latest replay report first.

## Documentation

| Document                                    | Read it when you need to...                                      |
| ------------------------------------------- | ---------------------------------------------------------------- |
| [Environment](docs/env.md)                  | Configure collection, logs, dumps or live access.                |
| [Architecture](docs/abstractions.md)        | Understand watchers, history and replay layers.                  |
| [Strategy guide](docs/strategies.md)        | Add or change an event strategy safely.                          |
| [Virtual wallets](docs/wallets.md)          | Understand balances, orders and shutdown behaviour.              |
| [Live integration example](docs/example.md) | See minimal scheduler, watcher and strategy wiring.              |

## Canonical registries

Do not copy lists of coins, frames, sources or strategy presets into callers.
Change the central registry instead; derived types and command-line validation
update with it.

| Registry                                  | Owns                                                             |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `src/market/coins.ts`                     | Supported coins and external-price precision.                    |
| `src/market/frame.ts`                     | Supported frames and their durations.                            |
| `src/market/price/price_source.ts`        | Price sources, timeouts and quality criteria.                    |
| `src/app/defaults.ts`                     | Default values for collection and replay.                        |
| `src/app/core/backtest/replay_presets.ts` | Presets available to single and matrix replay.                   |
