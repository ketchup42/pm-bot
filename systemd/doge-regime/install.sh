#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
config_file="$script_directory/research.env"
unit_directory="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
service_unit='pm-bot-doge-regime-research.service'
timer_unit='pm-bot-doge-regime-research.timer'

if [[ ! -e "$config_file" ]]; then
    cp "$script_directory/research.env.example" "$config_file"
    echo "[DogeBaselineRegimeInstall] Created ${config_file} from the default template."
fi

link_unit() {
    local unit_name="$1"
    local source="$script_directory/$unit_name"
    local linked="$unit_directory/$unit_name"
    if [[ -L "$linked" ]] && [[ "$(readlink -f "$linked")" == "$source" ]]; then return; fi
    if [[ -e "$linked" || -L "$linked" ]]; then
        echo "[DogeBaselineRegimeInstall] ${linked} does not link to this project." >&2
        exit 1
    fi
    systemctl --user link "$source"
}

link_unit "$service_unit"
link_unit "$timer_unit"
systemctl --user daemon-reload
systemctl --user reset-failed "$service_unit" "$timer_unit"
systemctl --user reenable --now "$timer_unit"
loginctl enable-linger "$USER"

echo '[DogeBaselineRegimeInstall] Weekly DOGE regime research timer is installed and enabled.'
systemctl --user show --property=FragmentPath "$service_unit"
systemctl --user list-timers --all "$timer_unit"
