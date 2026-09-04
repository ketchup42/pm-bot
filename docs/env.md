# Environment variables

Use a local `.env` only for values that belong on the machine running the bot.
Never commit it. The history collector and offline replay do not require wallet or
API credentials; live trading does.

## Which mode needs which settings?

| Mode                          | Credentials | Relevant settings                                      |
| ----------------------------- | ----------- | ------------------------------------------------------ |
| `collect`                     | No          | `HISTORY_*`, logging                                   |
| `history:settle`              | No          | `HISTORY_DIR`, logging                                 |
| `backtest`, `backtest:matrix` | No          | Command-line arguments only                            |
| `dev`, `start`                | Yes         | Wallet/API settings, optional RPC, logging and dumps   |

## Live trading credentials

These values are read only when creating an authenticated trading client. Keep the
examples as placeholders; replace them locally, never in source control.

| Variable         | Required | Meaning                                                                    |
| ---------------- | -------- | -------------------------------------------------------------------------- |
| `PRIVATE_KEY`    | Yes      | 64-character hexadecimal wallet key, with or without `0x`.                 |
| `API_KEY`        | Yes      | Polymarket CLOB API key derived for the wallet.                            |
| `API_SECRET`     | Yes      | Secret paired with `API_KEY`.                                              |
| `API_PASSPHRASE` | Yes      | Passphrase paired with the API credentials.                                |
| `FUNDER_ADDRESS` | Yes      | Collateral/gas payer; must be a valid `0x` address.                        |
| `SIGNATURE_TYPE` | No       | `0` EOA, `1` POLY_PROXY, `2` GNOSIS_SAFE, `3` deposit wallet; default `2`. |

## Network and logging

| Variable             | Default                    | Meaning                                                                  |
| -------------------- | -------------------------- | ------------------------------------------------------------------------ |
| `POLYGON_RPC_URL`    | `https://polygon-rpc.com`  | Polygon RPC endpoint used by live trading and balance reads.             |
| `LOG_LEVEL`          | unset                      | Console level: `debug`, `info`, `warn` or `error`; unset disables it.    |
| `LOG_FILE`           | unset                      | Output file for rotating logs.                                           |
| `LOG_FILE_LEVEL`     | unset                      | File log level; use with `LOG_FILE`.                                     |
| `LOG_FILE_MAX_SIZE`  | `5242880`                  | Maximum log-file size in bytes before rotation.                          |
| `LOG_FILE_MAX_FILES` | `5`                        | Number of rotated log files retained.                                    |
| `NO_COLOR`           | `0`                        | Set `1` or `true` to disable ANSI colours in console output.             |

## History collector

The collector is read-only. It writes `HistoryFrameV2` files, which are the only
history format accepted by the offline replay. Its command-line selection is
`--coin`, `--frame`, `--source` and optional `--count`; environment variables tune
storage and sampling.

| Variable              | Default          | Accepted values / meaning                                                |
| --------------------- | ---------------- | ------------------------------------------------------------------------ |
| `HISTORY_DIR`         | `history/frames` | Directory for versioned frame files.                                     |
| `HISTORY_SNAPSHOT_MS` | `100`            | Snapshot interval in milliseconds; integer, at least `25`.               |
| `HISTORY_BOOK_DEPTH`  | `10`             | Best bid/ask levels saved for each side; integer from `1` to `100`.      |
| `HISTORY_GZIP`        | `true`           | `true`/`false` or `1`/`0`; gzip each frame file.                         |
| `HISTORY_MAX_FRAMES`  | `0`              | Number of retained files; `0` disables collector-side rotation.          |

Stable BTC 5-minute collection configuration observed in this project:

```bash
env HISTORY_DIR='history/frames' HISTORY_SNAPSHOT_MS=100 HISTORY_BOOK_DEPTH=10 \
  HISTORY_GZIP=true HISTORY_MAX_FRAMES=0 \
  npm run collect -- --coin btc --frame 5m --source chainlink-twap-60
```

The watcher timeouts and stream-quality thresholds are code-level source settings
in `src/market/price/price_source.ts`, deliberately not environment variables.

## Legacy scheduler dumps

`DUMPS_DIR` and `DUMP_MAX_FILES` affect diagnostic snapshots written by the live
scheduler. They use a legacy external-analysis format and are not inputs to
`backtest` or `backtest:matrix`.

| Variable         | Default | Meaning                                         |
| ---------------- | ------- | ----------------------------------------------- |
| `DUMPS_DIR`      | `dumps` | Destination directory for scheduler dump files. |
| `DUMP_MAX_FILES` | `10`    | Number of scheduler dump files to retain.       |

## Placeholder `.env` for live mode

```env
# Wallet private key. Keep the real value outside version control.
PRIVATE_KEY=0xyour_private_key_here

# CLOB credentials derived for that wallet.
API_KEY=your_api_key_here
API_SECRET=your_api_secret_here
API_PASSPHRASE=your_api_passphrase_here

# 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE, 3=deposit wallet.
SIGNATURE_TYPE=2

# Collateral and gas payer address.
FUNDER_ADDRESS=0xyour_funder_address_here

# Optional live infrastructure and logs.
POLYGON_RPC_URL=https://polygon-rpc.com
LOG_LEVEL=info
LOG_FILE=logs/polymarket.log
LOG_FILE_LEVEL=info

# Optional read-only history collection.
HISTORY_DIR=history/frames
HISTORY_SNAPSHOT_MS=100
HISTORY_BOOK_DEPTH=10
HISTORY_GZIP=true
HISTORY_MAX_FRAMES=0
```
