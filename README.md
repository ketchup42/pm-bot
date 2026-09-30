# PM-BOT

Tools for researching and operating execution-aware Polymarket strategies.

PM-BOT collects market history, replays strategies on settled data, and runs a
guarded DOGE baseline contour through Docker.

## Important

PM-BOT is experimental software, not financial advice or a promise of profit.
Start with collected history, replay, and `--debug`. `--live` can submit real
orders and can lose funds. Keep credentials only in a local `runtime/.env` file;
the repository and deployment archives never include them.

## What it does

- Collects versioned, gzip-compressed Polymarket up/down market frames with
  price, order-book, connection-quality, and settlement data.
- Replays strategies against settled frames with visible-depth fills, fees,
  slippage, latency, and wallet constraints.
- Operates the DOGE baseline: train a model, tune entry/exit settings, refresh
  artifacts, and pause trading when replay evidence is insufficient.
- Ships a Docker-based operational console for status, account information,
  logs, updates, history maintenance, weekly research, and optional WireGuard
  routing.

```text
collect → settled history → model/config research → replay → refresh gate → strategy
                   │                                  │
                   └──────── weekly regime research ──┘
```

## Deploy on a server

Docker is the recommended operational path. Build either archive locally, copy it
to an x86-64 Linux server, extract it, and run the installer:

```bash
# Tiny: image, scripts, documentation, and empty runtime directories.
npm run deploy:docker -- --tiny

# Full: additionally includes the current DOGE artifacts and history.
npm run deploy:docker -- --full
```

If your local Docker daemon requires sudo, add `--sudo` to the build command.
On the server, use the extracted archive directory:

```bash
bash install.sh
```

The installer validates Docker and Compose, loads the image when needed, creates
only missing runtime files, and opens the terminal menu. Existing history, models,
logs, WireGuard profiles, and local settings are preserved. Later, open the same
console with:

```bash
bash menu.sh
```

Use **System → System settings** to complete `runtime/.env`, then use **DOGE
Baseline** to inspect status and control the contour. See the complete
[deployment guide](docs/deployment.md).

### Native archive

The standalone executable is retained for advanced local use. It does not include
the Docker console or service management:

```bash
npm run deploy -- --tiny
npm run deploy -- --full
```

The resulting `release/pm-bot-linux-x64-*.7z` archive contains
`pm-bot-linux-x64`. Run `./pm-bot-linux-x64 help` after extraction.

## Develop locally

Requirements: Node.js **22.6+** and npm.

```bash
npm install
npm run check

# Inspect supported coins, frames, and price sources.
npm run collect -- --help

# Collect one DOGE frame without trading credentials.
env HISTORY_SNAPSHOT_MS=100 \
  npm run collect -- --coin doge --frame 5m --source chainlink-twap-60 --count 1
```

The collector waits for the next frame boundary. Let a one-frame run finish with
`complete=true`; interrupted or incomplete frames are retained separately for
diagnostics.

## DOGE baseline workflow

For a local virtual run, use three terminals. In continuous collection,
`--count 2400` is both the number passed to the command and the retained complete
history limit per collected coin. `HISTORY_DIAGNOSTIC_FRAMES` independently limits
incomplete diagnostic frames.

```bash
# 1. Collect and retain the newest complete DOGE history frames.
env LOG_LEVEL=info HISTORY_SNAPSHOT_MS=100 HISTORY_BOOK_DEPTH=10 HISTORY_GZIP=true \
  npm run collect -- --coin doge --frame 5m --source chainlink-twap-60 --count 2400 --cycle
```

```bash
# 2. Run the strategy with a virtual wallet.
env LOG_LEVEL=info \
  npm run strategy:doge-baseline -- --debug --no-dumps --balance 100 --trade-value 10
```

```bash
# 3. Settle, retrain, tune, replay, and publish the selected working artifacts.
env LOG_LEVEL=info \
  npm run refresh:doge-baseline -- --frame 5m --count 25 --train-count 500 --replay 100 \
  --balance 100 --trade-value 10
```

The refresh gate may keep trading paused. This is intentional when replay PnL,
trend, or confirmation conditions do not meet the published policy.

## Command reference

| Command | Use it for |
| --- | --- |
| `npm run check` | Type-check, lint, and run the test suite. |
| `npm run collect -- --help` | Inspect collection options and supported sources. |
| `npm run history:settle` | Confirm outcomes in recorded history frames. |
| `npm run replay:doge-baseline -- --count 100 --balance 100 --trade-value 10` | Evaluate published DOGE artifacts with execution costs. |
| `npm run refresh:doge-baseline -- --help` | Inspect the automated DOGE refresh workflow. |
| `npm run strategy:doge-baseline -- --debug --balance 100 --trade-value 10` | Run virtual orders against live market data. |
| `npm run status:account` | Read account collateral, public position value, and open-order count. |
| `npm run status:doge-baseline` | Inspect artifacts, refresh state, and DOGE history status. |

## Documentation

| Guide | Start here when you need |
| --- | --- |
| [Deployment](docs/deployment.md) | A server install, update, menu workflow, VPN, or weekly research. |
| [Environment](docs/env.md) | A safe explanation of local settings and environment variables. |
| [Strategy guide](docs/strategies.md) | DOGE lifecycle, replay assumptions, or safe strategy changes. |
| [Architecture](docs/abstractions.md) | Data flow, history contracts, replay, and application components. |
| [Wallets](docs/wallets.md) | Virtual and live order-wallet semantics. |
| [Minimal integration](docs/example.md) | A small TypeScript scheduler composition. |

## Security and data handling

- Never commit wallet keys, API credentials, WireGuard keys, or local `.env` files.
- Collection and offline replay do not require authenticated trading credentials.
- The menu masks account identifiers and does not print secrets.
- WireGuard is optional. When enabled, contour containers share the bridge network
  namespace so their outbound traffic follows the tunnel policy.
