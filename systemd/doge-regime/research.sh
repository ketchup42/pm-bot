#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_directory="$(cd -- "$script_directory/../.." && pwd)"
cd "$project_directory"

readonly CONFIG_FILE="$script_directory/research.env"
readonly CONFIG_TEMPLATE="$script_directory/research.env.example"
readonly COMPOSE_ENV_FILE='compose.env'
readonly RUNTIME_DIRECTORY='runtime'
readonly DOGE_MODEL_DIRECTORY="$RUNTIME_DIRECTORY/models/doge-baseline"
readonly RESEARCH_LOCK_FILE="$DOGE_MODEL_DIRECTORY/regime-research.host.lock"
readonly STRATEGY_SERVICE='strategy-doge-baseline'
readonly REFRESH_SERVICE='refresh-doge-baseline'
readonly RESEARCH_LOG_FILE='/app/logs/regime-doge-baseline.log'

if [[ ! -r "$CONFIG_FILE" ]]; then
    echo "[DogeBaselineRegimeResearch] Missing ${CONFIG_FILE}. Copy ${CONFIG_TEMPLATE} first." >&2
    exit 1
fi
# This local file intentionally uses simple Bash-compatible KEY=value assignments.
source "$CONFIG_FILE"

require_nonempty() {
    local name="$1"
    if [[ -z "${!name:-}" ]]; then
        echo "[DogeBaselineRegimeResearch] ${name} must be set in ${CONFIG_FILE##*/}." >&2
        exit 1
    fi
}

require_positive_integer() {
    local name="$1"
    local value="${!name:-}"
    if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
        echo "[DogeBaselineRegimeResearch] ${name} must be a positive integer." >&2
        exit 1
    fi
}

require_nonnegative_integer() {
    local name="$1"
    local value="${!name:-}"
    if [[ ! "$value" =~ ^[0-9]+$ ]]; then
        echo "[DogeBaselineRegimeResearch] ${name} must be a non-negative integer." >&2
        exit 1
    fi
}

require_nonempty DOGE_BASELINE_REGIME_FRAME
require_positive_integer DOGE_BASELINE_REGIME_COUNT
require_positive_integer DOGE_BASELINE_REGIME_TRAIN_COUNT
require_positive_integer DOGE_BASELINE_REGIME_REPLAY_COUNT
require_nonnegative_integer DOGE_BASELINE_REGIME_LATENCY_MS
require_positive_integer DOGE_BASELINE_REGIME_REFRESH_WAIT_TIMEOUT_SECONDS
require_positive_integer DOGE_BASELINE_REGIME_REFRESH_POLL_INTERVAL_SECONDS

mkdir -p "$DOGE_MODEL_DIRECTORY"
exec 9>"$RESEARCH_LOCK_FILE"
if ! flock -n 9; then
    echo '[DogeBaselineRegimeResearch] Another host research run is already active.' >&2
    exit 0
fi

compose=(docker compose --env-file "$COMPOSE_ENV_FILE")
services=("$STRATEGY_SERVICE" "$REFRESH_SERVICE")

refresh_completed() {
    "${compose[@]}" logs --since "$1" --no-log-prefix "$REFRESH_SERVICE" 2>/dev/null | grep -Eq \
        '\[DogeBaselineRefresh\] (Published |Working model and config retained: |Initial model and config published)'
}

start_refresh_then_strategy() {
    local refresh_started_at deadline
    refresh_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if ! "${compose[@]}" up -d "$REFRESH_SERVICE"; then
        echo '[DogeBaselineRegimeResearch] Failed to start refresh. Strategy remains stopped.' >&2
        return 1
    fi
    deadline=$((SECONDS + DOGE_BASELINE_REGIME_REFRESH_WAIT_TIMEOUT_SECONDS))
    echo '[DogeBaselineRegimeResearch] Waiting for the first successful refresh before starting strategy.'
    while (( SECONDS < deadline )); do
        if refresh_completed "$refresh_started_at"; then
            if ! "${compose[@]}" up -d "$STRATEGY_SERVICE"; then
                echo '[DogeBaselineRegimeResearch] Refresh completed, but strategy could not be started.' >&2
                return 1
            fi
            echo '[DogeBaselineRegimeResearch] Refresh completed. Strategy started.'
            return 0
        fi
        sleep "$DOGE_BASELINE_REGIME_REFRESH_POLL_INTERVAL_SECONDS"
    done
    echo '[DogeBaselineRegimeResearch] Timed out waiting for a successful refresh. Strategy remains stopped.' >&2
    return 1
}

recover_after_signal() {
    local signal="$1"
    local status="$2"
    trap - INT TERM
    echo "[DogeBaselineRegimeResearch] ${signal} received. Recovering through refresh before exit." >&2
    if start_refresh_then_strategy; then
        echo '[DogeBaselineRegimeResearch] Recovery completed after interruption.' >&2
    else
        echo '[DogeBaselineRegimeResearch] Recovery refresh failed. Strategy remains stopped.' >&2
    fi
    exit "$status"
}

trap 'recover_after_signal INT 130' INT
trap 'recover_after_signal TERM 143' TERM

"${compose[@]}" stop "${services[@]}"
research_status=0
"${compose[@]}" run --rm --no-deps \
    -e LOG_FILE="$RESEARCH_LOG_FILE" \
    "$REFRESH_SERVICE" \
    research:doge-baseline-regime \
    --frame "$DOGE_BASELINE_REGIME_FRAME" \
    --count "$DOGE_BASELINE_REGIME_COUNT" \
    --train-count "$DOGE_BASELINE_REGIME_TRAIN_COUNT" \
    --replay "$DOGE_BASELINE_REGIME_REPLAY_COUNT" \
    --latency-ms "$DOGE_BASELINE_REGIME_LATENCY_MS" \
    --apply || research_status=$?

if (( research_status != 0 )); then
    echo "[DogeBaselineRegimeResearch] Research failed with status=${research_status}; refreshing before strategy restart." >&2
fi
if ! start_refresh_then_strategy; then exit 1; fi
exit "$research_status"
