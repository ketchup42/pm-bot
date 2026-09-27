#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
unit_directory="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
service_unit='pm-bot-doge-regime-research.service'
timer_unit='pm-bot-doge-regime-research.timer'
generated_service_unit="$script_directory/generated/$service_unit"

if systemctl --user is-active --quiet "$service_unit"; then
    echo '[DogeBaselineRegimeUninstall] Research is active. Wait for it to finish before uninstalling.' >&2
    exit 1
fi

remove_project_link() {
    local unit_name="$1"
    local source="$2"
    local legacy_source="${3:-}"
    local linked="$unit_directory/$unit_name"
    if [[ ! -e "$linked" && ! -L "$linked" ]]; then return; fi
    local linked_source
    linked_source="$(readlink -f "$linked")"
    if [[ ! -L "$linked" ]] || [[ "$linked_source" != "$source" && "$linked_source" != "$legacy_source" ]]; then
        echo "[DogeBaselineRegimeUninstall] ${linked} does not link to this project." >&2
        exit 1
    fi
    rm "$linked"
}

systemctl --user disable --now "$timer_unit" || true
remove_project_link "$service_unit" "$generated_service_unit" "$script_directory/$service_unit"
remove_project_link "$timer_unit" "$script_directory/$timer_unit"
rm -f "$generated_service_unit"
rmdir "$script_directory/generated" 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user reset-failed "$service_unit" "$timer_unit" || true

echo '[DogeBaselineRegimeUninstall] Weekly DOGE regime research timer is uninstalled.'
