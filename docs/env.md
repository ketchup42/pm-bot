# Environment variables

Everything the app reads from the environment, in one place.

## Wallet & API Authentication

| Variable         | Description                                                                                                                                                                                                          | Example                                                              |
| ------------------| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------| ----------------------------------------------------------------------|
| `PRIVATE_KEY`    | Your wallet private key (must start with `0x`).                                                                                                                                                                      | `0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef` |
| `API_KEY`        | API key derived from your wallet.                                                                                              | `6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d`                                   |
| `API_SECRET`     | API secret derived from your wallet.                                                                                                                                                                                 | `9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c` |
| `API_PASSPHRASE` | API passphrase derived from your wallet.                                                                                                                                                                             | `MyStrongPassphrase123!`                                             |
| `SIGNATURE_TYPE` | Type of wallet signature (default `2`):<br/>`0` – EOA (standard wallet)<br/>`1` – POLY_PROXY (Magic Link)<br/>`2` – GNOSIS_SAFE (most common for Polymarket)<br/>`3` – Deposit wallet (new deposit‑only wallet type) | `2`                                                                  |
| `FUNDER_ADDRESS` | Address that will pay gas fees. For type `0` – your wallet address; for types `1`/`2`/`3` – your proxy/Safe/deposit address.                                                                                         | `0xyour_funder_address_here`                                         |

## Blockchain Configuration

| Variable | Description | Example |
|----------|-------------|---------|
| `POLYGON_RPC_URL` | Polygon RPC endpoint (required for reading blockchain data and submitting transactions). Use a public endpoint or a private RPC provider for better reliability. | `https://polygon-rpc.com` |

## Logging Configuration

| Variable             | Description                                                                                     | Default              |
| ----------------------| -------------------------------------------------------------------------------------------------| ----------------------|
| `LOG_LEVEL`          | Console log level (`debug`, `info`, `warn`, `error`). If not set, console logging is disabled.  | (not set)            |
| `LOG_FILE`           | Path to the log file. File logging is enabled when `LOG_FILE_LEVEL` is also set.                | (not set)            |
| `LOG_FILE_LEVEL`     | Log level for file output (e.g., `debug`, `info`). Enables file logging when `LOG_FILE` is set. | (not set)            |
| `LOG_FILE_MAX_SIZE`  | Maximum file size in bytes before rotation.                                                     | `5242880` (5 MB)     |
| `LOG_FILE_MAX_FILES` | Number of rotated log files to keep.                                                            | `5`                  |
| `NO_COLOR`           | Disable ANSI colors in console output. Set to `1` or `true` to disable.                         | `0` (colors enabled) |

## Data Persistence

| Variable | Description | Default |
|----------|-------------|---------|
| `DUMPS_DIR` | Directory where historical data dumps (e.g., trade history) are stored. Disabled if not set. | (not set) |
| `DUMP_MAX_FILES` | Number of rotated dump files to keep. | `10` |

### Dedicated history collector

The read-only collector started with
`npm run collect -- --coin btc --frame 5m --source chainlink-twap-60`
does not create a trading client and does not place orders.

It writes `HistoryFrameV2` files used by the offline replay. Scheduler dumps in
`DUMPS_DIR` use a separate live format and are not replay inputs. After markets
resolve, `npm run history:settle` confirms their winning outcome. The no-network
baseline is started with `npm run backtest -- --history history/frames`.

| Variable              | Description                                       | Default          |
| -----------------------| ---------------------------------------------------| ------------------|
| `HISTORY_DIR`         | Directory for versioned frame files.              | `history/frames` |
| `HISTORY_SNAPSHOT_MS` | Snapshot interval in milliseconds (minimum `25`). | `100`            |
| `HISTORY_BOOK_DEPTH`  | Number of best bid/ask levels stored per side.    | `10`             |
| `HISTORY_GZIP`        | Compress each frame (`true`/`false`, `1`/`0`).    | `true`           |
| `HISTORY_MAX_FRAMES`  | Retained frame count; `0` disables rotation.      | `0`              |

## A full `.env` example

```env
# Your wallet private key (starts with 0x)
PRIVATE_KEY=0xyour_private_key_here

# API credentials derived from the wallet (see CLOB client docs)
API_KEY=your_api_key_here
API_SECRET=your_api_secret_here
API_PASSPHRASE=your_api_passphrase_here

# Signature type:
# 0 = EOA (externally owned account) – standard wallet, pays its own gas.
# 1 = POLY_PROXY (Magic Link / email login) – proxy wallet controlled by Polymarket.
# 2 = GNOSIS_SAFE – most common for accounts created via browser wallet (MetaMask, WalletConnect).
# 3 = Deposit wallet – new deposit‑only wallet type.
SIGNATURE_TYPE=2

# Address that will pay gas fees and holds the trading collateral (pUSD).
# For type 0: your EOA address.
# For types 1/2/3: the proxy, Safe, or deposit wallet address shown in your Polymarket profile.
FUNDER_ADDRESS=0xyour_funder_address_here

# Polygon RPC endpoint (required for reading blockchain data and submitting transactions)
POLYGON_RPC_URL=https://polygon-rpc.com

# Console log level (debug|info|warn|error). Console is disabled if LOG_LEVEL not set
LOG_LEVEL=error

# Enable file logging by specifying a file path
LOG_FILE=logs/polymarket.log

# File log level (debug|info|warn|error)
LOG_FILE_LEVEL=info

# Max file size before rotation (bytes) – 5MB
LOG_FILE_MAX_SIZE=5242880

# Number of rotated log files to keep
LOG_FILE_MAX_FILES=5

# Output color option (0 = enable colors, 1 = disable)
NO_COLOR=0

# Scheduler dumps directory, disabled if not set
DUMPS_DIR=history/dumps

# Number of rotated scheduler dump files to keep
DUMP_MAX_FILES=20

# Directory for collected historical frame files
HISTORY_DIR=history/frames

# Snapshot interval in milliseconds
HISTORY_SNAPSHOT_MS=100

# Number of best bid and ask levels stored for each market side
HISTORY_BOOK_DEPTH=10

# Enable gzip compression for historical frame files
HISTORY_GZIP=true

# Maximum retained frame count; 0 disables automatic deletion
HISTORY_MAX_FRAMES=0
