# Environment Configuration

This document describes all environment variables used to configure the application.

## Wallet & API Authentication

| Variable | Description | Example |
|----------|-------------|---------|
| `PRIVATE_KEY` | Your wallet private key (must start with `0x`). | `0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef` |
| `API_KEY` | API key derived from your wallet (see [CLOB authentication docs](https://docs.polymarket.com/clob-api/authentication)). | `6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d` |
| `API_SECRET` | API secret derived from your wallet. | `9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c` |
| `API_PASSPHRASE` | API passphrase derived from your wallet. | `MyStrongPassphrase123!` |
| `SIGNATURE_TYPE` | Type of wallet signature:<br/>`0` – EOA (standard wallet)<br/>`1` – POLY_PROXY (Magic Link)<br/>`2` – GNOSIS_SAFE (most common for Polymarket) | `2` |
| `FUNDER_ADDRESS` | Address that will pay gas fees. For type `0` – your wallet address; for types `1`/`2` – your proxy/Safe address. | `0xyour_funder_address_here` |

## Logging Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Console log level (`debug`, `info`, `warn`, `error`). If not set, console logging is disabled. | (not set) |
| `LOG_FILE` | Path to the log file. Enables file logging when set. | (not set) |
| `LOG_FILE_LEVEL` | Log level for file output (e.g., `debug`, `info`). | (not set) |
| `LOG_FILE_MAX_SIZE` | Maximum file size in bytes before rotation. | `10485760` (10 MB) |
| `LOG_FILE_MAX_FILES` | Number of rotated log files to keep. | `3` |
| `NO_COLOR` | Disable ANSI colors in console output. Set to `1` or `true` to disable. | `0` (colors enabled) |

## Example `.env` File

```env
# Your wallet private key (starts with 0x)
PRIVATE_KEY=0xyour_private_key_here

# API credentials derived from the wallet (see CLOB client docs)
API_KEY=your_api_key_here
API_SECRET=your_api_secret_here
API_PASSPHRASE=your_api_passphrase_here

# Signature type: 0 = EOA (standard wallet), 1 = POLY_PROXY (Magic Link), 2 = GNOSIS_SAFE (most common for Polymarket)
SIGNATURE_TYPE=2

# Address that will pay gas fees (your wallet address for type 0, or your proxy address for types 1/2)
FUNDER_ADDRESS=0xyour_funder_address_here

# Console log level (debug|info|warn|error). Console is disabled if LOG_LEVEL not set
LOG_LEVEL=error

# Enable file logging by specifying a file path
LOG_FILE=logs/pm.log

# File log level
LOG_FILE_LEVEL=debug

# Max file size before rotation (bytes) – 10MB
LOG_FILE_MAX_SIZE=10485760

# Number of rotated log files to keep
LOG_FILE_MAX_FILES=3

# Output color option (0 = enable colors, 1 = disable)
NO_COLOR=0

# Dumps directory, disabled if not set
DUMPS_DIR=history

# Number of rotated dump files to keep
DUMP_MAX_FILES=20