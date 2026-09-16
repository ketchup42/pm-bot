# PM-BOT

PM-BOT collects Polymarket up/down market data, replays strategies with execution
costs, and runs the DOGE baseline strategy. Start with research and virtual
trading. `--live` can submit real orders.

## Quick start

Requirements: Node.js **22.6+** and npm.

```bash
npm install
npm run check

# Show supported coins, frames, and price sources.
npm run collect -- --help

# Record one frame for every registered coin.
env HISTORY_SNAPSHOT_MS=50 \
  npm run collect -- --coin all --frame 5m --source chainlink-twap-60 --count 1
```

The collector waits for the next frame boundary. Do not interrupt a one-frame run
before its `Saved ... complete=true` message.

## DOGE virtual working loop

Run these three commands in separate terminals. The collector retains the newest
700 frames. The strategy uses a virtual wallet. Refresh confirms outcomes,
re-trains, tunes configuration, and compares the working and candidate pairs.

```bash
env LOG_LEVEL=info HISTORY_SNAPSHOT_MS=50 HISTORY_BOOK_DEPTH=10 HISTORY_GZIP=true \
  npm run collect -- --coin doge --frame 5m --source chainlink-twap-60 --count 700 --cycle
```

```bash
env LOG_LEVEL=info \
  npm run strategy:doge-baseline -- --debug --balance 100 --trade-value 10
```

```bash
env LOG_LEVEL=info \
  npm run refresh:doge-baseline -- --frame 5m --count 50 --train-count 500 --replay 100
```

```text
collect → history frames → history:settle → model/config refresh → strategy
                                    │                  │
                                    └──── replay ──────┘
```

## Commands

| Command                                                                                 | Purpose                                                                 |
| -----------------------------------------------------------------------------------------| -------------------------------------------------------------------------|
| `npm run check`                                                                         | Type-check, lint, and run tests.                                        |
| `npm run collect -- --coin doge --frame 5m --source chainlink-twap-60`                  | Collect DOGE HistoryFrameV3 data.                                       |
| `npm run history:settle`                                                                | Confirm outcomes in recorded frames.                                    |
| `npm run replay:doge-baseline -- --count 100 --balance 100 --trade-value 10`            | Replay the published DOGE pair with the default 250 ms execution delay. |
| `npm run research:doge-baseline-model -- --count 500`                                   | Train and publish a DOGE model.                                         |
| `npm run research:doge-baseline-config -- --count 500`                                  | Tune and publish DOGE configuration.                                    |
| `npm run refresh:doge-baseline -- --frame 5m --count 50 --train-count 500 --replay 100` | Refresh and compare four model/config pairs using the same delay.       |
| `npm run strategy:doge-baseline -- --debug --balance 100 --trade-value 10`              | Run with a virtual wallet.                                              |
| `npm run strategy:doge-baseline -- --live --balance 100 --trade-value 10`               | Submit real orders.                                                     |

## Deployment archive

Create a Linux x64 archive after the full project check:

```bash
# Binary and deployment instructions only.
npm run deploy -- --tiny

# Binary, current DOGE model artifacts, and history frames.
npm run deploy -- --full
```

The archive in `release/` contains `pm-bot-linux-x64`. Node.js and
`node_modules` are not required on the server. After extraction:

```bash
cd pm-bot-linux-x64
chmod +x pm-bot-linux-x64
./pm-bot-linux-x64 help
```

The executable embeds a 6 GiB V8 old-space limit. Copy or create `.env` manually
beside it for live access. Archives never include secrets.

## Docker deployment

Docker deployment targets Linux x86-64 independently of the server distribution.
It runs the three DOGE contours as `collector-doge-baseline`,
`strategy-doge-baseline`, and `refresh-doge-baseline` with shared runtime data
and separate logs.

```bash
npm run deploy:docker -- --tiny
npm run deploy:docker -- --full

# Use this when Docker is available only through sudo.
npm run deploy:docker -- --tiny --sudo
npm run deploy:docker -- --full --sudo
```

See [Deployment](docs/deployment.md) for Docker requirements, server setup, and
Compose commands. Runtime application settings remain in `runtime/.env`. DOGE
Baseline command parameters are configured separately in `compose.env`.

## Documentation

| Document | Use it for |
| --- | --- |
| [Environment](docs/env.md) | Environment variables, logging, collection, and live credentials. |
| [Architecture](docs/abstractions.md) | Watchers, history, replay, and domain registries. |
| [Strategy guide](docs/strategies.md) | DOGE behavior and safe strategy changes. |
| [Virtual wallets](docs/wallets.md) | Balances, orders, and shutdown behavior. |
| [Deployment](docs/deployment.md) | Native and Docker deployment. |
| [Live integration example](docs/example.md) | Minimal scheduler, watcher, and strategy wiring. |
