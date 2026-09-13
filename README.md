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

# Train and publish a DOGE model while retaining its current trading configuration.
npm run research:doge-baseline-model -- --count 500

# Select and atomically publish per-mode edges and emergency-exit parameters for the working model.
npm run research:doge-baseline-config -- --count 500

# Replay the published model on the newest 100 eligible frames.
npm run replay:doge-baseline -- --history history/frames --count 100 \
  --balance 100 --trade-value 10 --output history/reports/doge-baseline/latest

# Settle, train, tune both model configurations, then compare four pairs on 100 later frames.
npm run refresh:doge-baseline -- --frame 5m --count 100 --train-count 500 --replay 100
```

The matrix uses only frames with `data_quality.complete=true` and a confirmed
outcome. Its `manifest.json` lists excluded files and their reasons.

## Commands

| Command                                                                                        | Purpose                                                              |
| ------------------------------------------------------------------------------------------------| ----------------------------------------------------------------------|
| `npm run build`                                                                                | Compile `src/` into `dist/`.                                         |
| `npm run check`                                                                                | Run type-checking, linting and tests.                                |
| `npm run collect -- --coin doge --frame 5m --source chainlink-twap-60 --count 700 --cycle`     | Retain a 700-frame DOGE buffer for 500+100 model evaluation.         |
| `npm run history:settle`                                                                       | Confirm outcomes for collected V3 frames.                            |
| `npm run backtest -- --history history/frames --strategy v2`                                   | Replay one registered reference preset.                              |
| `npm run backtest:matrix -- --history history/frames`                                          | Compare all registered reference presets.                            |
| `npm run research:doge-baseline-model -- --count 500`                                          | Train and publish the two-mode DOGE model.                           |
| `npm run research:doge-baseline-config -- --count 500`                                         | Tune and publish per-mode edge and exit configuration.               |
| `npm run replay:doge-baseline -- --model <file> --config <file> --history history/frames --count 100 --balance 100 --trade-value 10` | Replay a specified model and matching configuration. |
| `npm run strategy:doge-baseline -- --debug --balance 100 --trade-value 10`                      | Run DOGE with a virtual wallet.                                       |
| `npm run strategy:doge-baseline -- --live --balance 100 --trade-value 10`                       | Run DOGE with real orders.                                            |
| `npm run refresh:doge-baseline -- --frame 5m --count 100 --train-count 500 --replay 100`       | Tune two model/config pairs and compare them on 100 later frames.    |

## Data lifecycle

```text
selected-source prices + CLOB order books
                  │
                  ▼
collect → HistoryFrameV3 → history:settle → model/config research → model.json + config.json
                              │                                           │
                              └──────────── replay:doge-baseline ◀────────┘
                                                                     │
                                                                     ▼
                                                      strategy:doge-baseline
```

`complete=true` describes collection quality: snapshot coverage, boundary prices
and connection state. It does **not** mean that a strategy is profitable. Outcome
confirmation is a separate later operation.

Configuration research keeps the same eligible frames as model training, but reduces
their snapshots in memory to a 250 ms cadence. This bounds memory use for the
two-stage matrix: 35 natural entry configurations, then 12 emergency-exit variants
for each of three finalists. It does not modify the original history files. Normal replay keeps
using every recorded snapshot.

The DOGE model contains two independent logistic-regression modes. The early mode
decides at 60 seconds from 15/30/60-second returns. If it does not enter, the late
mode decides at 120 seconds from 75/90/120-second returns. The replay command uses
the already published model and applies the same prediction-side entry rule. Market
price can reject the predicted trade but cannot switch it to the opposite side. Ask
depth, VWAP, taker fee and the minimum order value must preserve the configured edge
before an entry is submitted. An emergency exit is allowed in the final 60 seconds
after DOGE remains 0.05% against the position for five seconds. It walks
available bid depth and retries an unsold remainder no more than once per second
without placing duplicate active orders. Positions held through a
natural frame end are settled at $1 for the winning side or $0 for the losing side;
they are not sold at the final bid and do not incur an exit fee.

Candidate refresh requires profitable replay, sufficient prediction quality and a
trade count equal to 10% of replay frames, bounded from 5 to 20. A candidate also
cannot trail a profitable working model by more than 20% net PnL on the same frames.

## Live mode and secrets

`strategy:doge-baseline` requires exactly one explicit mode: `--debug` creates a
virtual wallet, while `--live` enables real orders. Both modes require a positive
`--balance` and `--trade-value`; the latter cannot exceed the balance. The scheduler
still initialises an authenticated client in both modes. Configure it in a local
`.env`, which must never be committed or written to logs. The complete variable list
and a placeholder-only example are in [docs/env.md](docs/env.md). Review the model
and its latest replay report first.

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
