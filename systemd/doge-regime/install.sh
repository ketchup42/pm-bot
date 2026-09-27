#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
config_file="$script_directory/research.env"
unit_directory="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
service_unit='pm-bot-doge-regime-research.service'
timer_unit='pm-bot-doge-regime-research.timer'
service_template="$script_directory/${service_unit}.template"
generated_directory="$script_directory/generated"
generated_service_unit="$generated_directory/$service_unit"

if [[ ! -e "$config_file" ]]; then
    cp "$script_directory/research.env.example" "$config_file"
    echo "[DogeBaselineRegimeInstall] Created ${config_file} from the default template."
fi

generate_service_unit() {
    if [[ ! -r "$service_template" ]]; then
        echo "[DogeBaselineRegimeInstall] Missing service template: ${service_template}." >&2
        exit 1
    fi

    local escaped_project_directory="$script_directory/../.."
    escaped_project_directory="$(cd -- "$escaped_project_directory" && pwd)"
    escaped_project_directory="${escaped_project_directory//\\/\\\\}"
    escaped_project_directory="${escaped_project_directory//\"/\\\"}"

    mkdir -p "$generated_directory"
    while IFS= read -r line || [[ -n "$line" ]]; do
        printf '%s\n' "${line//__PROJECT_DIRECTORY__/\"$escaped_project_directory\"}"
    done < "$service_template" > "$generated_service_unit"
}

link_unit() {
    local unit_name="$1"
    local source="$2"
    local linked="$unit_directory/$unit_name"
    if [[ -L "$linked" ]] && [[ "$(readlink -f "$linked")" == "$source" ]]; then return; fi
    if [[ -e "$linked" || -L "$linked" ]]; then
        echo "[DogeBaselineRegimeInstall] ${linked} does not link to this project." >&2
        exit 1
    fi
    systemctl --user link "$source"
}

generate_service_unit
legacy_service_unit="$script_directory/$service_unit"
linked_service_unit="$unit_directory/$service_unit"
if [[ -L "$linked_service_unit" ]] && [[ "$(readlink -f "$linked_service_unit")" == "$legacy_service_unit" ]]; then
    rm "$linked_service_unit"
fi
link_unit "$service_unit" "$generated_service_unit"
link_unit "$timer_unit" "$script_directory/$timer_unit"
systemctl --user daemon-reload
systemctl --user reset-failed "$service_unit" "$timer_unit"
systemctl --user reenable --now "$timer_unit"
loginctl enable-linger "$USER"

echo '[DogeBaselineRegimeInstall] Weekly DOGE regime research timer is installed and enabled.'
systemctl --user show --property=FragmentPath "$service_unit"
systemctl --user list-timers --all "$timer_unit"
