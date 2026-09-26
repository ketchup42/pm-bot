#!/usr/bin/env bash
set -Eeuo pipefail

project_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_directory"

mkdir -p runtime/models/doge-baseline
exec 9>runtime/models/doge-baseline/regime-research.host.lock
if ! flock -n 9; then
    echo '[DogeBaselineRegimeResearch] Another host research run is already active.' >&2
    exit 0
fi

compose=(docker compose --env-file compose.env)
services=(strategy-doge-baseline refresh-doge-baseline)

restore_contour() {
    status=$?
    trap - EXIT INT TERM
    "${compose[@]}" up -d "${services[@]}" || echo \
        '[DogeBaselineRegimeResearch] Failed to restore strategy and refresh.' >&2
    exit "$status"
}

trap restore_contour EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${compose[@]}" stop "${services[@]}"
"${compose[@]}" run --rm --no-deps \
    -e LOG_FILE=/app/logs/regime-doge-baseline.log \
    refresh-doge-baseline \
    research:doge-baseline-regime \
    --frame 5m \
    --count 25 \
    --train-count 500 \
    --replay 100 \
    --latency-ms 250 \
    --apply
