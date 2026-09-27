#!/usr/bin/env bash
set -Eeuo pipefail

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly CONFIG_FILE="$script_directory/research.env"
readonly CONFIG_TEMPLATE="$script_directory/research.env.example"
readonly UNIT_DIRECTORY="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
readonly SERVICE_UNIT='pm-bot-doge-regime-research.service'
readonly TIMER_UNIT='pm-bot-doge-regime-research.timer'
readonly SERVICE_TEMPLATE="$script_directory/${SERVICE_UNIT}.template"
readonly GENERATED_DIRECTORY="$script_directory/generated"
readonly GENERATED_SERVICE_UNIT="$GENERATED_DIRECTORY/$SERVICE_UNIT"

if [[ ! -e "$CONFIG_FILE" ]]; then
    cp "$CONFIG_TEMPLATE" "$CONFIG_FILE"
    echo "[DogeBaselineRegimeInstall] Created ${CONFIG_FILE} from the default template."
fi

generate_service_unit() {
    if [[ ! -r "$SERVICE_TEMPLATE" ]]; then
        echo "[DogeBaselineRegimeInstall] Missing service template: ${SERVICE_TEMPLATE}." >&2
        exit 1
    fi

    local escaped_project_directory="$script_directory/../.."
    escaped_project_directory="$(cd -- "$escaped_project_directory" && pwd)"
    escaped_project_directory="${escaped_project_directory//\\/\\\\}"
    escaped_project_directory="${escaped_project_directory//\"/\\\"}"

    mkdir -p "$GENERATED_DIRECTORY"
    while IFS= read -r line || [[ -n "$line" ]]; do
        printf '%s\n' "${line//__PROJECT_DIRECTORY__/\"$escaped_project_directory\"}"
    done < "$SERVICE_TEMPLATE" > "$GENERATED_SERVICE_UNIT"
}

link_unit() {
    local unit_name="$1"
    local source="$2"
    local linked="$UNIT_DIRECTORY/$unit_name"
    if [[ -L "$linked" ]] && [[ "$(readlink -f "$linked")" == "$source" ]]; then return; fi
    if [[ -e "$linked" || -L "$linked" ]]; then
        echo "[DogeBaselineRegimeInstall] ${linked} does not link to this project." >&2
        exit 1
    fi
    systemctl --user link "$source"
}

generate_service_unit
legacy_service_unit="$script_directory/$SERVICE_UNIT"
linked_service_unit="$UNIT_DIRECTORY/$SERVICE_UNIT"
if [[ -L "$linked_service_unit" ]] && [[ "$(readlink -f "$linked_service_unit")" == "$legacy_service_unit" ]]; then
    rm "$linked_service_unit"
fi
link_unit "$SERVICE_UNIT" "$GENERATED_SERVICE_UNIT"
link_unit "$TIMER_UNIT" "$script_directory/$TIMER_UNIT"
systemctl --user daemon-reload
systemctl --user reset-failed "$SERVICE_UNIT" "$TIMER_UNIT"
systemctl --user reenable --now "$TIMER_UNIT"
loginctl enable-linger "$USER"

echo '[DogeBaselineRegimeInstall] Weekly DOGE regime research timer is installed and enabled.'
systemctl --user show --property=FragmentPath "$SERVICE_UNIT"
systemctl --user list-timers --all "$TIMER_UNIT"
