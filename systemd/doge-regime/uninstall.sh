#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly UNIT_DIRECTORY="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
readonly SERVICE_UNIT='pm-bot-doge-regime-research.service'
readonly TIMER_UNIT='pm-bot-doge-regime-research.timer'
readonly GENERATED_DIRECTORY="$script_directory/generated"
readonly GENERATED_SERVICE_UNIT="$GENERATED_DIRECTORY/$SERVICE_UNIT"

if systemctl --user is-active --quiet "$SERVICE_UNIT"; then
    echo '[DogeBaselineRegimeUninstall] Research is active. Wait for it to finish before uninstalling.' >&2
    exit 1
fi

remove_project_link() {
    local unit_name="$1"
    local source="$2"
    local legacy_source="${3:-}"
    local linked="$UNIT_DIRECTORY/$unit_name"
    if [[ ! -e "$linked" && ! -L "$linked" ]]; then return; fi
    local linked_source
    linked_source="$(readlink -f "$linked")"
    if [[ ! -L "$linked" ]] || [[ "$linked_source" != "$source" && "$linked_source" != "$legacy_source" ]]; then
        echo "[DogeBaselineRegimeUninstall] ${linked} does not link to this project." >&2
        exit 1
    fi
    rm "$linked"
}

systemctl --user disable --now "$TIMER_UNIT" || true
remove_project_link "$SERVICE_UNIT" "$GENERATED_SERVICE_UNIT" "$script_directory/$SERVICE_UNIT"
remove_project_link "$TIMER_UNIT" "$script_directory/$TIMER_UNIT"
rm -f "$GENERATED_SERVICE_UNIT"
rmdir "$GENERATED_DIRECTORY" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user reset-failed "$SERVICE_UNIT" "$TIMER_UNIT" || true

echo '[DogeBaselineRegimeUninstall] Weekly DOGE regime research timer is uninstalled.'
