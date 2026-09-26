#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
unit_directory="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
service_unit='pm-bot-doge-regime-research.service'
timer_unit='pm-bot-doge-regime-research.timer'

if systemctl --user is-active --quiet "$service_unit"; then
    echo '[DogeBaselineRegimeUninstall] Research is active. Wait for it to finish before uninstalling.' >&2
    exit 1
fi

remove_project_link() {
    local unit_name="$1"
    local source="$script_directory/$unit_name"
    local linked="$unit_directory/$unit_name"
    if [[ ! -e "$linked" && ! -L "$linked" ]]; then return; fi
    if [[ ! -L "$linked" ]] || [[ "$(readlink -f "$linked")" != "$source" ]]; then
        echo "[DogeBaselineRegimeUninstall] ${linked} does not link to this project." >&2
        exit 1
    fi
    rm "$linked"
}

systemctl --user disable --now "$timer_unit" || true
remove_project_link "$service_unit"
remove_project_link "$timer_unit"
systemctl --user daemon-reload
systemctl --user reset-failed "$service_unit" "$timer_unit" || true

echo '[DogeBaselineRegimeUninstall] Weekly DOGE regime research timer is uninstalled.'
