#!/usr/bin/env bash
set -Eeuo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_directory"

compose=(docker compose --env-file compose.env)
menu_compose=(docker compose --env-file compose.env --profile menu)
console_image='pm-bot:linux-amd64'
wireguard_directory='runtime/wireguard/wg_confs'
wireguard_config="$wireguard_directory/wg0.conf"
wireguard_template="$wireguard_directory/wg0.conf.new"
wireguard_previous_config="$wireguard_directory/wg0.conf.previous"
wireguard_source_template='network/wireguard/wg0.conf.template'
wireguard_override='compose.override.yaml'
wireguard_disabled_override='compose.override.yaml.disabled'
menu_choice=0
menu_page_size=10
menu_width=54
menu_inner_width=$((menu_width - 4))
doge_service_settings_begin='# BEGIN DOGE BASELINE SERVICE SETTINGS'
doge_service_settings_end='# END DOGE BASELINE SERVICE SETTINGS'

if [[ -n "${NO_COLOR:-}" || "${TERM:-}" == dumb ]]; then
    color_reset=''
    color_blue=''
    color_cyan=''
    color_green=''
    color_gray=''
    color_yellow=''
    color_red=''
else
    color_reset=$'\033[0m'
    color_blue=$'\033[1;34m'
    color_cyan=$'\033[1;36m'
    color_green=$'\033[1;32m'
    color_gray=$'\033[0;90m'
    color_yellow=$'\033[1;33m'
    color_red=$'\033[1;31m'
fi

clear_screen() {
    if [[ "${TERM:-}" == dumb ]]; then
        printf '\n'
    else
        printf '\033[2J\033[H'
    fi
}

truncate_text() {
    local text="$1" maximum="$2"
    if ((${#text} > maximum)); then
        printf '%.*s...' "$((maximum - 3))" "$text"
    else
        printf '%s' "$text"
    fi
}

render_top() {
    clear_screen
    render_border '╔' '╗'
    render_line "$color_cyan" 'PM BOT'
    render_line "$color_gray" 'MARKET AUTOMATION CONSOLE'
    render_rule
}

render_rule() {
    render_border '╠' '╣'
}

render_border() {
    local left="$1" right="$2" line=''
    local index
    for ((index = 0; index < menu_inner_width; index += 1)); do
        line+='═'
    done
    printf '%b%s%s%s%b\n' "$color_blue" "$left" "$line" "$right" "$color_reset"
}

render_line() {
    local color="$1" text
    text="$(truncate_text "$2" "$((menu_inner_width - 2))")"
    printf '%b║%b %-*s %b%b║%b\n' "$color_blue" "$color" "$((menu_inner_width - 2))" "$text" "$color_reset" "$color_blue" "$color_reset"
}

render_bottom() {
    render_border '╚' '╝'
}

render_section() {
    render_line "$color_cyan" "SECTION / $1"
    render_rule
}

render_static_screen() {
    local title="$1"
    shift
    render_top
    render_section "$title"
    local line
    for line in "$@"; do
        render_line "$color_gray" "$line"
    done
    render_rule
    render_line "$color_gray" 'Press Enter to continue'
    render_bottom
}

render_value() {
    local label="$1" value="$2" color="$3"
    render_line "$color" "$(printf '%-18s %s' "$label" "$value")"
}

setup_status_width() {
    local columns available status_width=96
    columns="$(tput cols 2>/dev/null || true)"
    if [[ "$columns" =~ ^[1-9][0-9]*$ ]]; then
        # Leave a small margin so the frame does not wrap in a terminal window.
        available=$((columns - 2))
        ((available < status_width)) && status_width=$available
    else
        # Keep the established compact width when the terminal size is unknown.
        status_width=$menu_width
    fi
    ((status_width < 4)) && status_width=4
    menu_inner_width=$((status_width - 2))
}

status_wrap_text() {
    local text="$1" maximum="$2" comma_break space_break index character chunk
    while ((${#text} > maximum)); do
        comma_break=-1
        space_break=-1
        for ((index = 0; index < maximum; index += 1)); do
            character="${text:index:1}"
            [[ "$character" == ',' ]] && comma_break=$((index + 1))
            [[ "$character" =~ [[:space:]] ]] && space_break=$index
        done
        if ((comma_break > 0)); then
            chunk="${text:0:comma_break}"
            text="${text:comma_break}"
        elif ((space_break > 0)); then
            chunk="${text:0:space_break}"
            text="${text:space_break}"
        else
            chunk="${text:0:maximum}"
            text="${text:maximum}"
        fi
        text="${text#"${text%%[![:space:]]*}"}"
        printf '%s\n' "$chunk"
    done
    printf '%s\n' "$text"
}

render_status_line() {
    local color="$1" text="$2" line
    local -a lines
    local text_width=$((menu_inner_width - 2))
    mapfile -t lines < <(status_wrap_text "$text" "$text_width")
    for line in "${lines[@]}"; do
        render_line "$color" "$line"
    done
}

render_status_value() {
    local label="$1" value="$2" color="$3" line
    local -a lines
    local text_width=$((menu_inner_width - 2))
    local value_width=$((text_width - 19))
    local label_prefix
    label_prefix="$(printf '%-18s ' "$label")"

    if ((value_width < 1)); then
        render_status_line "$color" "$label"
        mapfile -t lines < <(status_wrap_text "$value" "$text_width")
        for line in "${lines[@]}"; do
            render_line "$color" "$line"
        done
        return
    fi

    mapfile -t lines < <(status_wrap_text "$value" "$value_width")
    render_line "$color" "${label_prefix}${lines[0]}"
    for ((line = 1; line < ${#lines[@]}; line += 1)); do
        render_line "$color" "$(printf '%19s%s' '' "${lines[line]}")"
    done
}

pause() {
    printf '\n%bPress Enter to continue...%b' "$color_gray" "$color_reset"
    read -r
}

show_message() {
    printf '\n%b%s%b\n' "$color_yellow" "$*" "$color_reset"
    pause
}

menu_action_failure_reason() {
    local output="$1"
    if grep -Eqi 'permission denied.*docker|permission denied while trying to connect' "$output"; then
        printf 'Docker access is denied. Add this user to the docker group and sign in again.'
    elif grep -Eqi 'cannot connect to the docker daemon|failed to connect to the docker api|docker daemon is not running' "$output"; then
        printf 'Docker Engine is unavailable. Start Docker and try again.'
    elif grep -Eqi 'must be set in compose\.env|compose file.*invalid|invalid compose' "$output"; then
        printf 'Compose settings are missing or invalid. Open DOGE Settings, Service settings.'
    elif grep -Eqi 'no such image|image.*not found|pull access denied' "$output"; then
        printf 'The Docker image is unavailable. Use Settings, Update image.'
    elif grep -Eqi 'failed to connect to bus|failed to connect to user scope' "$output"; then
        printf 'User systemd is unavailable. Log in with a user session and try again.'
    elif grep -Eqi 'research is active' "$output"; then
        printf 'Weekly research is active. Wait for it to finish before removing the service.'
    elif grep -Eqi 'does not link to this project' "$output"; then
        printf 'An existing systemd service belongs to another project and was not changed.'
    else
        printf 'Check Status and the selected service logs.'
    fi
}

run_menu_action() {
    local title="$1" output reason
    shift
    if ! output="$(mktemp "${TMPDIR:-/tmp}/pm-bot-menu-action.XXXXXX")"; then
        show_message "$title failed. Unable to prepare a temporary status file."
        return 0
    fi
    if "$@" >"$output" 2>&1; then
        rm -f "$output"
        show_message "$title completed."
        return 0
    fi
    reason="$(menu_action_failure_reason "$output")"
    rm -f "$output"
    show_message "$title failed. $reason"
    return 0
}

choose_menu() {
    local title="$1"
    shift
    local -a items=("$@")
    local selected=0 key rest index first last total

    while true; do
        total=${#items[@]}
        first=$(((selected / menu_page_size) * menu_page_size))
        last=$((first + menu_page_size))
        ((last > total)) && last=$total
        render_top
        render_section "$title"
        for ((index = first; index < last; index += 1)); do
            if ((index == selected)); then
                render_line "$color_blue" "> $((index + 1)). ${items[index]}"
            else
                render_line "$color_gray" "  $((index + 1)). ${items[index]}"
            fi
        done
        render_rule
        if ((total > menu_page_size)); then
            render_line "$color_gray" "$((first + 1))-$last / $total   Up/Down Navigate   Enter Select   Esc Back"
        else
            render_line "$color_gray" 'Up/Down Navigate   Enter Select   Esc Back'
        fi
        render_bottom
        IFS= read -rsn1 key
        if [[ "$key" == $'\e' ]]; then
            rest=''
            IFS= read -rsn2 -t 0.1 rest || true
            case "$rest" in
                '[A') selected=$(((selected + ${#items[@]} - 1) % ${#items[@]})) ;;
                '[B') selected=$(((selected + 1) % ${#items[@]})) ;;
                *)
                    menu_choice=$((${#items[@]} - 1))
                    return
                    ;;
            esac
        elif [[ -z "$key" || "$key" == $'\n' || "$key" == $'\r' ]]; then
            menu_choice=$selected
            return
        fi
    done
}

open_editor() {
    local file="$1"
    local -a editor
    read -r -a editor <<< "${EDITOR:-vi}"
    command -v "${editor[0]}" >/dev/null 2>&1 || {
        show_message "Editor ${editor[0]} is unavailable. Set EDITOR and try again."
        return 1
    }
    "${editor[@]}" "$file"
}

ensure_compose_settings() {
    if [[ -e compose.env ]]; then
        return
    fi
    cp compose.env.example compose.env
    printf '\nPUID=%s\nPGID=%s\n' "$(id -u)" "$(id -g)" >> compose.env
    echo 'Created compose.env from compose.env.example.'
}

ensure_application_settings() {
    if [[ -f runtime/.env ]]; then
        return 0
    fi
    if [[ ! -f runtime.env.example ]]; then
        show_message 'Application settings template is missing: runtime.env.example.'
        return 1
    fi
    if ! mkdir -p runtime; then
        show_message 'Unable to create the runtime directory for application settings.'
        return 1
    fi
    if ! cp runtime.env.example runtime/.env; then
        show_message 'Unable to create runtime/.env from the application settings template.'
        return 1
    fi
    return 0
}

compose_settings_block_is_present() {
    [[ -f compose.env ]] || return 1
    local begin_count end_count
    begin_count="$(grep -Fxc "$doge_service_settings_begin" compose.env || true)"
    end_count="$(grep -Fxc "$doge_service_settings_end" compose.env || true)"
    [[ "$begin_count" == 1 && "$end_count" == 1 ]]
}

create_doge_service_settings_block() {
    ensure_compose_settings
    if compose_settings_block_is_present; then
        return
    fi

    local begin_count end_count temporary
    begin_count="$(grep -Fxc "$doge_service_settings_begin" compose.env || true)"
    end_count="$(grep -Fxc "$doge_service_settings_end" compose.env || true)"
    if [[ "$begin_count" != 0 || "$end_count" != 0 ]]; then
        show_message 'compose.env has an incomplete DOGE service-settings block. Repair it manually first.'
        return 1
    fi

    temporary="$(mktemp "$project_directory/.compose.env.XXXXXX")"
    if ! awk -v begin="$doge_service_settings_begin" -v end="$doge_service_settings_end" '
        /^DOGE_BASELINE_[A-Za-z0-9_]*=/ { values[++count] = $0; next }
        { lines[++lineCount] = $0 }
        END {
            for (lineIndex = 1; lineIndex <= lineCount; lineIndex += 1) print lines[lineIndex]
            print begin
            for (valueIndex = 1; valueIndex <= count; valueIndex += 1) print values[valueIndex]
            print end
        }
    ' compose.env > "$temporary"; then
        rm -f "$temporary"
        show_message 'Unable to create the DOGE service-settings block.'
        return 1
    fi
    chmod --reference=compose.env "$temporary"
    mv "$temporary" compose.env
}

validate_doge_service_settings_block() {
    local file="$1"
    awk '
        BEGIN { valid = 1 }
        /^[[:space:]]*$/ || /^[[:space:]]*#/ { next }
        /^DOGE_BASELINE_[A-Za-z0-9_]*=/ { count += 1; next }
        { valid = 0 }
        END { exit(valid && count > 0 ? 0 : 1) }
    ' "$file"
}

edit_doge_service_settings() {
    create_doge_service_settings_block || return
    local draft updated
    draft="$(mktemp "$project_directory/.doge-service-settings.XXXXXX")"
    updated="$(mktemp "$project_directory/.compose.env.XXXXXX")"
    awk -v begin="$doge_service_settings_begin" -v end="$doge_service_settings_end" '
        $0 == begin { copy = 1; next }
        $0 == end { exit }
        copy { print }
    ' compose.env > "$draft"
    if ! open_editor "$draft"; then
        rm -f "$draft" "$updated"
        return 1
    fi
    if ! validate_doge_service_settings_block "$draft"; then
        rm -f "$draft" "$updated"
        show_message 'Only comments, blank lines, and DOGE_BASELINE_*= entries are allowed in Service settings.'
        return 1
    fi
    if ! awk -v begin="$doge_service_settings_begin" -v end="$doge_service_settings_end" -v draft="$draft" '
        BEGIN {
            replacement = begin ORS
            while ((getline line < draft) > 0) replacement = replacement line ORS
            close(draft)
            replacement = replacement end ORS
        }
        $0 == begin { printf "%s", replacement; replace = 1; next }
        $0 == end { replace = 0; next }
        !replace { print }
    ' compose.env > "$updated"; then
        rm -f "$draft" "$updated"
        show_message 'Unable to save DOGE service settings.'
        return 1
    fi
    chmod --reference=compose.env "$updated"
    mv "$updated" compose.env
    rm -f "$draft"
}

environment_value() {
    local file="$1" name="$2"
    awk -F= -v name="$name" '$1 == name { print substr($0, length(name) + 2); exit }' "$file"
}

manifest_value() {
    local name="$1"
    [[ -f release-manifest.json ]] || return
    awk -F'"' -v name="$name" '$2 == name { print $4; exit }' release-manifest.json
}

ensure_console() {
    [[ -f compose.env && -f runtime/.env ]] || return 1
    local container_id='' image_id='' container_image='' running=''
    image_id="$(docker image inspect --format '{{.Id}}' "$console_image" 2>/dev/null || true)"
    [[ -n "$image_id" ]] || return 1
    container_id="$("${menu_compose[@]}" ps -q console 2>/dev/null || true)"
    if [[ -n "$container_id" ]]; then
        container_image="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)"
        running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)"
        if [[ "$container_image" == "$image_id" && "$running" == true ]]; then
            return 0
        fi
    fi
    if [[ -n "$container_id" && "$container_image" != "$image_id" ]]; then
        "${menu_compose[@]}" up -d --force-recreate console >/dev/null 2>&1
    else
        "${menu_compose[@]}" up -d console >/dev/null 2>&1
    fi
}

run_console_command() {
    ensure_console || return 1
    "${menu_compose[@]}" exec -T console \
        node --max-old-space-size=6144 dist/app/pm-bot.js "$@" </dev/null 2>/dev/null
}

run_doge_status() {
    run_console_command status:doge-baseline --json
}

run_account_status() {
    run_console_command status:account --text
}

status_value() {
    local key="$1" json="$2"
    awk -F: -v key="$key" 'index($0, "\"" key "\"") { value=$2; gsub(/[, "]/, "", value); print value; exit }' <<< "$json"
}

status_text_value() {
    local key="$1" json="$2"
    awk -F: -v key="$key" 'index($0, "\"" key "\"") {
        value=$0; sub(/^[^:]*:[[:space:]]*"?/, "", value); sub(/"?,?[[:space:]]*$/, "", value); print value; exit
    }' <<< "$json"
}

or_not_available() {
    [[ -n "$1" ]] && printf '%s' "$1" || printf 'not available'
}

format_epoch_ms() {
    local value="$1"
    [[ "$value" =~ ^[0-9]+([.][0-9]+)?$ ]] || { printf 'not available'; return; }
    date -u -d "@$((${value%.*} / 1000))" '+%Y-%m-%d %H:%M UTC' 2>/dev/null || printf '%sms' "${value%.*}"
}

format_epoch_seconds() {
    local value="$1"
    [[ "$value" =~ ^[0-9]+([.][0-9]+)?$ ]] || { printf 'not available'; return; }
    date -u -d "@${value%.*}" '+%Y-%m-%d %H:%M UTC' 2>/dev/null || printf '%ss' "${value%.*}"
}

format_duration_ms() {
    local value="$1" total days hours minutes
    [[ "$value" =~ ^[0-9]+([.][0-9]+)?$ ]] || { printf 'not available'; return; }
    total=$(( ${value%.*} / 1000 ))
    days=$((total / 86400))
    hours=$(((total % 86400) / 3600))
    minutes=$(((total % 3600) / 60))
    if ((days > 0)); then
        printf '%sd %sh' "$days" "$hours"
    elif ((hours > 0)); then
        printf '%sh %sm' "$hours" "$minutes"
    else
        printf '%sm' "$minutes"
    fi
}

wireguard_handshake_status() {
    [[ -f compose.override.yaml ]] || { printf 'not enabled'; return; }
    local handshake now
    handshake="$("${compose[@]}" exec -T wireguard-bridge sh -c 'wg show wg0 latest-handshakes | awk "NR == 1 { print \$2 }"' 2>/dev/null || true)"
    [[ "$handshake" =~ ^[0-9]+$ ]] && ((handshake > 0)) || { printf 'not available'; return; }
    now="$(date +%s)"
    printf '%ss ago' "$((now - handshake))"
}

preflight_clean_start() {
    local -a missing=()
    [[ -f runtime/.env ]] || missing+=('runtime/.env')
    [[ -f compose.env ]] || missing+=('compose.env')
    [[ -f runtime/models/doge-baseline/model.json ]] || missing+=('DOGE model.json')
    [[ -f runtime/models/doge-baseline/config.json ]] || missing+=('DOGE config.json')
    if [[ -f compose.override.yaml && ! -f "$wireguard_config" ]]; then
        missing+=('WireGuard wg0.conf')
    fi
    if ((${#missing[@]} > 0)); then
        show_message "Start blocked. Missing: ${missing[*]}"
        return 1
    fi
    if ! "${compose[@]}" config -q; then
        show_message 'Start blocked. Compose configuration is invalid.'
        return 1
    fi
}

start_doge_contour() {
    local -a services=(collector-doge-baseline strategy-doge-baseline refresh-doge-baseline)
    [[ -f compose.override.yaml ]] && services+=(wireguard-bridge)
    "${compose[@]}" up -d "${services[@]}"
}

stop_doge_contour() {
    local -a services=(collector-doge-baseline strategy-doge-baseline refresh-doge-baseline)
    [[ -f compose.override.yaml ]] && services+=(wireguard-bridge)
    "${compose[@]}" stop "${services[@]}"
}

restart_doge_contour() {
    local -a services=(collector-doge-baseline strategy-doge-baseline refresh-doge-baseline)
    [[ -f compose.override.yaml ]] && services+=(wireguard-bridge)
    "${compose[@]}" restart "${services[@]}"
}

show_account() {
    local account_text='' line
    render_top
    render_section 'ACCOUNT'
    render_line "$color_gray" 'Loading read-only account information...'
    render_bottom
    if [[ -f compose.env && -f runtime/.env ]]; then
        account_text="$(run_account_status || true)"
    fi
    render_top
    render_section 'ACCOUNT'
    if [[ -n "$account_text" ]]; then
        while IFS= read -r line; do
            render_line "$color_gray" "$line"
        done <<< "$account_text"
    else
        render_line "$color_yellow" 'Account status is not available.'
        render_line "$color_gray" 'Check Docker access and Application settings.'
    fi
    render_rule
    render_line "$color_gray" 'Press Enter to continue'
    render_bottom
    pause
}

show_status() {
    local strategy_mode='not available'
    local original_menu_inner_width="$menu_inner_width"
    setup_status_width
    if [[ -f compose.env ]]; then
        strategy_mode="$(environment_value compose.env DOGE_BASELINE_STRATEGY_MODE || true)"
    fi
    local status_json='' trading_enabled eligible_frames entry_profile exit_profile pause_reason model_version config_version model_config
    render_top
    render_section 'STATUS'
    render_status_value 'STRATEGY MODE' "$(or_not_available "$strategy_mode")" "$color_green"
    render_rule
    render_status_line "$color_gray" 'Loading validated status...'
    render_status_line "$color_gray" 'First history analysis can take longer.'
    render_bottom
    if [[ -f compose.env ]]; then
        status_json="$(run_doge_status || true)"
    fi
    render_top
    render_section 'STATUS'
    render_status_value 'STRATEGY MODE' "$(or_not_available "$strategy_mode")" "$color_green"
    trading_enabled="$(status_value tradingEnabled "$status_json")"
    if [[ "$trading_enabled" == true ]]; then
            render_status_value 'TRADING' 'enabled' "$color_green"
    elif [[ "$trading_enabled" == false ]]; then
            render_status_value 'TRADING' 'paused' "$color_yellow"
    else
            render_status_value 'TRADING' 'not available' "$color_yellow"
    fi
    eligible_frames="$(status_value eligibleFrames "$status_json" || true)"
    entry_profile="$(status_text_value entryProfile "$status_json" || true)"
    exit_profile="$(status_text_value exitProfile "$status_json" || true)"
    pause_reason="$(status_text_value pauseReason "$status_json" || true)"
    model_version="$(status_value version "$status_json" || true)"
    config_version="$(status_value configVersion "$status_json" || true)"
    if [[ -n "$model_version" || -n "$config_version" ]]; then
        model_config="v$(or_not_available "$model_version") / v$(or_not_available "$config_version")"
    else
        model_config='not available'
    fi
    render_status_value 'ELIGIBLE FRAMES' "$(or_not_available "$eligible_frames")" "$color_gray"
    render_status_value 'LAST FRAME' "$(format_epoch_seconds "$(status_value latestFrameStart "$status_json")")" "$color_gray"
    render_status_value 'HISTORY SPAN' "$(format_duration_ms "$(status_value historySpanMs "$status_json")")" "$color_gray"
    render_status_value 'LAST REFRESH' "$(format_epoch_ms "$(status_value lastSuccessfulRefreshAt "$status_json")")" "$color_gray"
    render_status_value 'ENTRY PROFILE' "$(or_not_available "$entry_profile")" "$color_gray"
    render_status_value 'EXIT PROFILE' "$(or_not_available "$exit_profile")" "$color_gray"
    render_status_value 'PAUSE REASON' "$(or_not_available "$pause_reason")" "$color_yellow"
    render_status_value 'MODEL / CONFIG' "$model_config" "$color_gray"
    render_status_value 'DISK FREE' "$(or_not_available "$(df -h runtime 2>/dev/null | awk 'NR == 2 { print $4 }')")" "$color_gray"
    render_status_value 'VPN' "$(wireguard_handshake_status)" "$color_gray"
    render_status_value 'RELEASE' "$(or_not_available "$(manifest_value gitRevision || true)")" "$color_gray"
    render_status_value 'IMAGE' "$(or_not_available "$(manifest_value imageId || true)")" "$color_gray"
    render_rule
    render_status_line "$color_cyan" 'SERVICES'
    if [[ -f compose.env ]]; then
        local -a service_rows
        mapfile -t service_rows < <("${compose[@]}" ps --format '{{.Service}}  {{.Status}}' 2>/dev/null | awk '$1 != "console"' || true)
        if ((${#service_rows[@]} == 0)); then
            render_status_line "$color_yellow" 'not available'
        else
            local service_row
            for service_row in "${service_rows[@]}"; do
                render_status_line "$color_gray" "$service_row"
            done
        fi
    else
        render_status_line "$color_yellow" 'not available: compose.env is missing'
    fi
    render_rule
    render_status_line "$color_gray" 'Press Enter to continue'
    render_bottom
    pause
    menu_inner_width="$original_menu_inner_width"
}

global_settings_menu() {
    while true; do
        choose_menu 'Settings' 'Application settings' 'Update image' 'Back'
        case "$menu_choice" in
            0)
                if ensure_application_settings; then
                    open_editor runtime/.env || true
                fi
                ;;
            1) run_menu_action 'Image update' bash install.sh --update-image --no-menu ;;
            2) return ;;
        esac
    done
}

doge_settings_menu() {
    while true; do
        choose_menu 'DOGE Settings' 'Service settings' 'Weekly research' 'Back'
        case "$menu_choice" in
            0) edit_doge_service_settings || true ;;
            1) weekly_research_menu ;;
            2) return ;;
        esac
    done
}

weekly_research_menu() {
    local weekly_settings='systemd/doge-regime/research.env'
    local weekly_template='systemd/doge-regime/research.env.example'
    while true; do
        choose_menu 'Weekly research' 'Weekly research settings' 'Install or update service' 'Uninstall service' 'Back'
        case "$menu_choice" in
            0)
                [[ -e "$weekly_settings" ]] || cp "$weekly_template" "$weekly_settings"
                open_editor "$weekly_settings" || true
                ;;
            1) run_menu_action 'Weekly research service installation' bash systemd/doge-regime/install.sh ;;
            2) run_menu_action 'Weekly research service removal' bash systemd/doge-regime/uninstall.sh ;;
            3) return ;;
        esac
    done
}

wireguard_status() {
    render_top
    render_section 'WIREGUARD CONNECTION'
    if [[ -f "$wireguard_override" ]]; then
        render_value 'OVERRIDE' 'enabled' "$color_green"
    elif [[ -f "$wireguard_disabled_override" ]]; then
        render_value 'OVERRIDE' 'disabled' "$color_yellow"
    else
        render_value 'OVERRIDE' 'not configured' "$color_yellow"
    fi
    [[ -f "$wireguard_config" ]] && render_value 'ACTIVE CONFIG' 'available' "$color_green" || render_value 'ACTIVE CONFIG' 'not available' "$color_yellow"
    [[ -f "$wireguard_template" ]] && render_value 'DRAFT' 'available' "$color_green" || render_value 'DRAFT' 'not available' "$color_yellow"
    [[ -f "$wireguard_previous_config" ]] && render_value 'PREVIOUS CONFIG' 'available' "$color_gray" || true
    render_rule
    render_line "$color_gray" 'No WireGuard credentials are displayed'
    render_line "$color_gray" 'Press Enter to continue'
    render_bottom
    pause
}

wireguard_override_menu_label() {
    [[ -f "$wireguard_override" ]] && printf 'Disable WireGuard' || printf 'Enable WireGuard'
}

toggle_wireguard_override() {
    if [[ -f "$wireguard_override" ]]; then
        mv "$wireguard_override" "$wireguard_disabled_override"
        show_message 'WireGuard override disabled. Restart services to apply the network change.'
        return
    fi
    if [[ -f "$wireguard_disabled_override" ]]; then
        mv "$wireguard_disabled_override" "$wireguard_override"
    else
        cp compose.wireguard.override.yaml.example "$wireguard_override"
    fi
    show_message 'WireGuard override enabled. Restart services to apply the network change.'
}

create_or_edit_wireguard_draft() {
    mkdir -p "$wireguard_directory"
    if [[ ! -f "$wireguard_template" ]]; then
        cp "$wireguard_source_template" "$wireguard_template"
        chmod 600 "$wireguard_template"
    fi
    open_editor "$wireguard_template" || true
}

wireguard_draft_field_is_set() {
    local section="$1" field="$2"
    awk -v section="$section" -v field="$field" '
        /^\[/ { current = $0 }
        current == "[" section "]" && $0 ~ "^" field "[[:space:]]*=" {
            value = $0
            sub(/^[^=]*=[[:space:]]*/, "", value)
            valid = value != "" && value !~ /^REPLACE_/
        }
        END { exit(valid ? 0 : 1) }
    ' "$wireguard_template"
}

validate_wireguard_draft() {
    [[ -f "$wireguard_template" ]] || {
        show_message 'WireGuard draft is not available. Create and edit it first.'
        return 1
    }
    local requirement
    for requirement in 'Interface PrivateKey' 'Interface Address' 'Peer PublicKey' 'Peer Endpoint' 'Peer AllowedIPs'; do
        wireguard_draft_field_is_set $requirement || {
            show_message 'WireGuard draft is incomplete or still contains a template placeholder.'
            return 1
        }
    done
    if ! docker run --rm --entrypoint wg-quick \
        -v "$project_directory/$wireguard_directory:/config:ro" \
        lscr.io/linuxserver/wireguard:latest strip /config/wg_confs/wg0.conf.new >/dev/null 2>&1; then
        show_message 'WireGuard draft failed syntax validation.'
        return 1
    fi
}

apply_wireguard_draft() {
    validate_wireguard_draft || return
    local active_was_present=false
    if [[ -f "$wireguard_config" ]]; then
        mv -f "$wireguard_config" "$wireguard_previous_config"
        active_was_present=true
    fi
    if ! mv "$wireguard_template" "$wireguard_config"; then
        if [[ "$active_was_present" == true ]]; then mv "$wireguard_previous_config" "$wireguard_config"; fi
        show_message 'WireGuard draft could not be applied. The active configuration was restored.'
        return 1
    fi
    chmod 600 "$wireguard_config"
    show_message 'WireGuard draft applied. Restart the WireGuard bridge and dependent services to use it.'
}

wireguard_menu() {
    while true; do
        choose_menu 'WireGuard' 'Status' "$(wireguard_override_menu_label)" 'Create or edit draft' 'Apply draft' 'Back'
        case "$menu_choice" in
            0) wireguard_status ;;
            1) toggle_wireguard_override ;;
            2) create_or_edit_wireguard_draft ;;
            3) apply_wireguard_draft ;;
            4) return ;;
        esac
    done
}

vpn_menu() {
    while true; do
        choose_menu 'VPN' 'WireGuard' 'Back'
        case "$menu_choice" in
            0) wireguard_menu ;;
            1) return ;;
        esac
    done
}

list_service_log_files() {
    local service="$1"
    [[ -d runtime/logs ]] || return
    find runtime/logs -maxdepth 1 -type f -name "${service}.log*" -printf '%T@:%p\n' 2>/dev/null |
        sort -t: -k1,1nr |
        cut -d: -f2-
}

open_log_file() {
    local file="$1"
    if ! command -v less >/dev/null 2>&1; then
        show_message 'less is required to view logs. Install it and try again.'
        return
    fi
    less +G -- "$file"
}

follow_log_file() {
    local file="$1"
    command -v less >/dev/null 2>&1 || { show_message 'less is required to view logs. Install it and try again.'; return; }
    less +F -- "$file" || true
}

open_filtered_log_file() {
    local file="$1"
    command -v less >/dev/null 2>&1 || { show_message 'less is required to view logs. Install it and try again.'; return; }
    { grep -Ei ' (warn|error):' -- "$file" || true; } | less +G
}

open_log_tail() {
    local file="$1" count
    printf 'Number of final lines [200]: '
    read -r count
    count="${count:-200}"
    [[ "$count" =~ ^[1-9][0-9]*$ ]] || { show_message 'Use a positive integer.'; return; }
    command -v less >/dev/null 2>&1 || { show_message 'less is required to view logs. Install it and try again.'; return; }
    tail -n "$count" -- "$file" | less +G
}

log_file_menu() {
    local file="$1"
    while true; do
        choose_menu "LOG / $(basename "$file")" 'Open at end' 'Follow current log' 'Warnings and errors' 'Last N lines' 'Back'
        case "$menu_choice" in
            0) open_log_file "$file" ;;
            1) follow_log_file "$file" ;;
            2) open_filtered_log_file "$file" ;;
            3) open_log_tail "$file" ;;
            4) return ;;
        esac
    done
}

view_service_logs() {
    local service="$1"
    local -a files labels
    mapfile -t files < <(list_service_log_files "$service")
    if ((${#files[@]} == 0)); then
        command -v less >/dev/null 2>&1 || { show_message 'less is required to view logs. Install it and try again.'; return; }
        { "${compose[@]}" logs --tail 200 --follow "$service" || true; } | less +F || true
        return
    fi
    local file
    for file in "${files[@]}"; do
        labels+=("$(basename "$file") $(du -h "$file" 2>/dev/null | awk '{ print $1 }') $(stat -c '%y' "$file" 2>/dev/null | cut -c1-16)")
    done
    labels+=('Back')
    while true; do
        choose_menu "LOG FILES / $service" "${labels[@]}"
        if ((menu_choice == ${#labels[@]} - 1)); then
            return
        fi
        log_file_menu "${files[menu_choice]}"
    done
}

service_menu() {
    local -a services
    mapfile -t services < <("${compose[@]}" config --services)
    ((${#services[@]} > 0)) || { show_message 'No Compose services are available.'; return; }
    services+=('Back')
    while true; do
        choose_menu 'Services' "${services[@]}"
        local selected="$menu_choice"
        if ((selected == ${#services[@]} - 1)); then
            return
        fi
        local service="${services[selected]}"
        while true; do
        choose_menu "Service: $service" 'Start' 'Stop' 'Restart' 'View logs' 'Back'
            case "$menu_choice" in
                0) run_menu_action "Start $service" "${compose[@]}" up -d "$service" ;;
                1) run_menu_action "Stop $service" "${compose[@]}" stop "$service" ;;
                2) run_menu_action "Restart $service" "${compose[@]}" restart "$service" ;;
                3) view_service_logs "$service" ;;
                4) break ;;
            esac
        done
    done
}

doge_baseline_menu() {
    while true; do
        choose_menu 'DOGE Baseline' 'Status' 'Start' 'Stop' 'Restart' 'VPN' 'Settings' 'Services' 'Back'
        case "$menu_choice" in
            0) show_status ;;
            1) if preflight_clean_start; then run_menu_action 'Start' start_doge_contour; fi ;;
            2) run_menu_action 'Stop' stop_doge_contour ;;
            3) run_menu_action 'Restart' restart_doge_contour ;;
            4) vpn_menu ;;
            5) doge_settings_menu ;;
            6) service_menu ;;
            7) return ;;
        esac
    done
}

if [[ -f compose.env && -f runtime/.env ]]; then
    ensure_console || true
fi

while true; do
    choose_menu 'PM Bot' 'Account' 'DOGE Baseline' 'Settings' 'Exit'
    case "$menu_choice" in
        0) show_account ;;
        1) doge_baseline_menu ;;
        2) global_settings_menu ;;
        3) exit 0 ;;
    esac
done
