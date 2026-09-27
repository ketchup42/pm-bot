# Environment variables

Use a local `.env` only for values that belong on the machine running the bot.
Never commit it. The history collector and offline replay do not require wallet or
API credentials. Live trading does.

## Which mode needs which settings?

| Mode                       | Credentials | Relevant settings                                    |
| ----------------------------| -------------| ------------------------------------------------------|
| `collect`                  | No          | `HISTORY_*`, logging                                 |
| `history:settle`           | No          | `HISTORY_DIR`, logging                               |
| `backtest`, model research | No          | Command-line arguments, `STRATEGY_MODELS_DIR`        |
| `strategy:doge-baseline`   | Yes         | Model path, wallet/API settings and logging          |
| `dev`, `start`             | Yes         | Wallet/API settings, optional RPC, logging and dumps |

## Live trading credentials

These values are read only when creating an authenticated trading client. Keep the
examples as placeholders. Replace them locally, never in source control.

| Variable         | Required | Meaning                                                                    |
| ---------------- | -------- | -------------------------------------------------------------------------- |
| `PRIVATE_KEY`    | Yes      | 64-character hexadecimal wallet key, with or without `0x`.                 |
| `API_KEY`        | Yes      | Polymarket CLOB API key derived for the wallet.                            |
| `API_SECRET`     | Yes      | Secret paired with `API_KEY`.                                              |
| `API_PASSPHRASE` | Yes      | Passphrase paired with the API credentials.                                |
| `FUNDER_ADDRESS` | Yes      | Collateral/gas payer. Must be a valid `0x` address.                        |
| `SIGNATURE_TYPE` | No       | `0` EOA, `1` POLY_PROXY, `2` GNOSIS_SAFE, `3` deposit wallet. Default `2`. |

## Network and logging

| Variable             | Default                    | Meaning                                                                  |
| -------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `POLYGON_RPC_URL`    | `https://polygon-rpc.com`  | Polygon RPC endpoint used by live trading and balance reads.             |
| `LOG_LEVEL`          | unset                      | Console level: `debug`, `info`, `warn` or `error`. Unset disables it.    |
| `LOG_FILE`           | unset                      | Output file for rotating logs.                                            |
| `LOG_FILE_LEVEL`     | unset                      | File log level. Use with `LOG_FILE`.                                     |
| `LOG_FILE_MAX_SIZE`  | `5242880`                  | Maximum log-file size in bytes before rotation.                          |
| `LOG_FILE_MAX_FILES` | `5`                        | Number of rotated log files retained.                                    |
| `NO_COLOR`           | `0`                        | Set `1` or `true` to disable ANSI colours in console output.             |

## History collector

The collector is read-only. It writes `HistoryFrameV3` files, the only history
format accepted by offline replay. `--coin all` is the normal mode: it collects one
target-market frame for every coin in `market/coins.ts`, with a price basket from the
same selected source in every snapshot. `--coin <coin>` limits the target market,
but still keeps the complete basket. `--frame`, `--source` and optional `--count`
select the frame, common price source and number of frames.

| Variable              | Default          | Accepted values / meaning                                                 |
| --------------------- | ---------------- | ------------------------------------------------------------------------- |
| `HISTORY_DIR`         | `history/frames` | Directory for versioned frame files.                                      |
| `HISTORY_SNAPSHOT_MS` | `100`            | Snapshot interval in milliseconds. Integer, at least `25`.                |
| `HISTORY_BOOK_DEPTH`  | `10`             | Best bid/ask levels saved for each side. Integer from `1` to `100`.       |
| `HISTORY_GZIP`        | `true`           | `true`/`false` or `1`/`0`. Gzip each frame file.                          |
| `HISTORY_DIAGNOSTIC_FRAMES` | `250`     | Incomplete diagnostic frames retained per coin by that collector.         |

Recommended multi-coin 5-minute collection configuration:

```bash
env HISTORY_DIR='history/frames' HISTORY_SNAPSHOT_MS=100 HISTORY_BOOK_DEPTH=10 \
  HISTORY_GZIP=true HISTORY_DIAGNOSTIC_FRAMES=250 \
  npm run collect -- --coin all --frame 5m --source chainlink-twap-60 --count 2400 --cycle
```

At the default 100 ms interval, a five-minute target frame expects 3,000 snapshots
and needs at least 2,850 for the 95% coverage criterion. The current six-target
`--coin all` run can therefore write up to 18,000 snapshots per five-minute
interval. Set `HISTORY_SNAPSHOT_MS` explicitly when diagnosing host or network
capacity. 100 ms is the project default.

The collector uses one shared price connection per selected source for the complete
coin basket. It reconnects after 10 seconds without an update for any active coin.
Repeated failed connections wait 1, 2, 4, 8 seconds and so on, capped at 30 seconds.
The timeout and stream-quality thresholds are code-level source settings in
`src/market/price/price_source.ts`, deliberately not environment variables.

Without `--cycle`, `--count N` collects N frames and stops. With `--cycle`, the
collector runs forever and retains the newest N complete frames for each selected
target coin. `HISTORY_DIAGNOSTIC_FRAMES` retains incomplete diagnostic frames
separately. Set it to `0` to disable diagnostic deletion. Rotation does not delete
frames belonging to coins outside the current collector command.

## Strategy models

| Variable              | Default  | Meaning                                         |
| --------------------- | -------- | ----------------------------------------------- |
| `STRATEGY_MODELS_DIR` | `models` | Root directory for atomically published models. |

## Legacy scheduler dumps

`DUMPS_DIR` and `DUMP_MAX_FILES` affect diagnostic snapshots written by the live
scheduler. They use a legacy external-analysis format and are not inputs to
`backtest` or `backtest:matrix`.

| Variable         | Default | Meaning                                         |
| ---------------- | ------- | ----------------------------------------------- |
| `DUMPS_DIR`      | `dumps` | Destination directory for scheduler dump files. |
| `DUMP_MAX_FILES` | `10`    | Number of scheduler dump files to retain.       |

## Placeholder `.env` for live mode

`runtime.env.example` is the tracked source for this template. The Docker
installer copies it to `runtime/.env` only when that local file is absent.

```env
# Your wallet private key (starts with 0x).
PRIVATE_KEY=REPLACE_WITH_PRIVATE_KEY

# API credentials derived from the wallet for the Polymarket CLOB client.
API_KEY=REPLACE_WITH_CLOB_API_KEY
API_SECRET=REPLACE_WITH_CLOB_API_SECRET
API_PASSPHRASE=REPLACE_WITH_CLOB_API_PASSPHRASE

# Signature type for the Polymarket account:
# 0 = EOA (externally owned account) — the wallet pays its own gas.
# 1 = POLY_PROXY (Magic Link or email login) — a Polymarket proxy wallet.
# 2 = GNOSIS_SAFE — commonly used with browser wallets such as MetaMask.
# 3 = Deposit wallet — a deposit-only wallet type.
SIGNATURE_TYPE=2

# Address that pays gas and holds the trading collateral (pUSD).
# For type 0, use the EOA address. For types 1, 2, and 3, use the proxy or
# deposit-wallet address shown in the Polymarket profile.
FUNDER_ADDRESS=REPLACE_WITH_FUNDER_ADDRESS

# Polygon RPC endpoint for blockchain reads and transaction submission.
# A private RPC provider can be more reliable than the public endpoint.
POLYGON_RPC_URL=https://polygon-rpc.com

# Root directory for trained strategy models.
STRATEGY_MODELS_DIR=models

# Console log level (debug|info|warn|error). Console logging is disabled when unset.
LOG_LEVEL=info

# Enable file logging by specifying a file path.
LOG_FILE=logs/polymarket.log

# File log level (debug|info|warn|error).
LOG_FILE_LEVEL=info
LOG_FILE_MAX_SIZE=10485760
LOG_FILE_MAX_FILES=5
NO_COLOR=0

# Legacy scheduler dumps. Docker DOGE strategy runs use --no-dumps.
DUMPS_DIR=history/dumps
DUMP_MAX_FILES=20

# Directory for collected historical frame files.
HISTORY_DIR=history/frames

# Snapshot interval in milliseconds.
HISTORY_SNAPSHOT_MS=100

# Number of best bid and ask levels stored for each market side.
HISTORY_BOOK_DEPTH=10

# Enable gzip compression for historical frame files.
HISTORY_GZIP=true

# Incomplete frames are kept separately for diagnostics. Set 0 to disable deletion.
HISTORY_DIAGNOSTIC_FRAMES=250
```
