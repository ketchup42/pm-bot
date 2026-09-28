#!/usr/bin/env bash
set -Eeuo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_directory"

readonly COMPOSE_ENV_FILE='compose.env'
readonly COMPOSE_ENV_TEMPLATE='compose.env.example'
readonly RELEASE_MANIFEST_FILE='release-manifest.json'
readonly INSTALL_SCRIPT='install.sh'
readonly RUNTIME_DIRECTORY='runtime'
readonly APPLICATION_ENV_FILE="$RUNTIME_DIRECTORY/.env"
readonly APPLICATION_ENV_TEMPLATE='runtime.env.example'
readonly LOG_DIRECTORY="$RUNTIME_DIRECTORY/logs"
readonly DOGE_MODEL_DIRECTORY="$RUNTIME_DIRECTORY/models/doge-baseline"
readonly DOGE_MODEL_FILE="$DOGE_MODEL_DIRECTORY/model.json"
readonly DOGE_CONFIG_FILE="$DOGE_MODEL_DIRECTORY/config.json"
readonly CONSOLE_IMAGE='pm-bot:linux-amd64'
readonly CONSOLE_SERVICE='console'
readonly COLLECTOR_SERVICE='collector-doge-baseline'
readonly STRATEGY_SERVICE='strategy-doge-baseline'
readonly REFRESH_SERVICE='refresh-doge-baseline'
readonly WIREGUARD_SERVICE='wireguard-bridge'
readonly WIREGUARD_DIRECTORY="$RUNTIME_DIRECTORY/wireguard/wg_confs"
readonly WIREGUARD_CONFIG="$WIREGUARD_DIRECTORY/wg0.conf"
readonly WIREGUARD_TEMPLATE="$WIREGUARD_DIRECTORY/wg0.conf.new"
readonly WIREGUARD_PREVIOUS_CONFIG="$WIREGUARD_DIRECTORY/wg0.conf.previous"
readonly WIREGUARD_SOURCE_TEMPLATE='network/wireguard/wg0.conf.template'
readonly WIREGUARD_OVERRIDE='compose.override.yaml'
readonly WIREGUARD_DISABLED_OVERRIDE='compose.override.yaml.disabled'
readonly WIREGUARD_OVERRIDE_TEMPLATE='compose.wireguard.override.yaml.example'
readonly WEEKLY_RESEARCH_DIRECTORY='systemd/doge-regime'
readonly WEEKLY_RESEARCH_SETTINGS="$WEEKLY_RESEARCH_DIRECTORY/research.env"
readonly WEEKLY_RESEARCH_TEMPLATE="$WEEKLY_RESEARCH_DIRECTORY/research.env.example"
readonly WEEKLY_RESEARCH_INSTALL_SCRIPT="$WEEKLY_RESEARCH_DIRECTORY/install.sh"
readonly WEEKLY_RESEARCH_UNINSTALL_SCRIPT="$WEEKLY_RESEARCH_DIRECTORY/uninstall.sh"
readonly -a DOGE_SERVICES=("$COLLECTOR_SERVICE" "$STRATEGY_SERVICE" "$REFRESH_SERVICE")

compose=(docker compose --env-file "$COMPOSE_ENV_FILE")
menu_compose=(docker compose --env-file "$COMPOSE_ENV_FILE" --profile menu)
menu_choice=0
menu_page_size=10
menu_width=54
menu_inner_width=$((menu_width - 4))
readonly LOG_MENU_WIDTH=64
doge_service_settings_begin='# BEGIN DOGE BASELINE SERVICE SETTINGS'
doge_service_settings_end='# END DOGE BASELINE SERVICE SETTINGS'

if [[ -n "${NO_COLOR:-}" || "${TERM:-}" == dumb ]]; then
    color_reset=''
    color_terminal_reset=''
    color_blue=''
    color_cyan=''
    color_green=''
    color_gray=''
    color_yellow=''
    color_red=''
else
    color_reset=$'\033[0m'
    color_terminal_reset=$'\033[0m'
    color_blue=$'\033[38;2;120;175;194m'
    color_cyan=$'\033[38;2;130;216;208m'
    color_green=$'\033[38;2;199;222;114m'
    color_gray=$'\033[38;2;133;137;144m'
    color_yellow=$'\033[38;2;229;180;92m'
    color_red=$'\033[38;2;229;180;92m'
fi

trap 'printf "%b" "$color_terminal_reset"' EXIT

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

setup_detail_width() {
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
    local label="$1" value="$2" color="$3" requested_label_width="${4:-}" line
    local -a lines
    local text_width=$((menu_inner_width - 2))
    local label_width=${#label}
    ((label_width < 18)) && label_width=18
    if [[ "$requested_label_width" =~ ^[0-9]+$ ]] && ((requested_label_width > label_width)); then
        label_width=$requested_label_width
    fi
    local value_width=$((text_width - label_width - 1))
    local label_prefix continuation_prefix
    label_prefix="$(printf '%-*s ' "$label_width" "$label")"
    continuation_prefix="$(printf '%*s' "$((label_width + 1))" '')"

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
        render_line "$color" "${continuation_prefix}${lines[line]}"
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
        printf 'The Docker image is unavailable. Use System, Update image.'
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
                render_line "$color_green" "> $((index + 1)). ${items[index]}"
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
    if [[ -e "$COMPOSE_ENV_FILE" ]]; then
        return
    fi
    cp "$COMPOSE_ENV_TEMPLATE" "$COMPOSE_ENV_FILE"
    printf '\nPUID=%s\nPGID=%s\n' "$(id -u)" "$(id -g)" >> "$COMPOSE_ENV_FILE"
    echo "Created $COMPOSE_ENV_FILE from $COMPOSE_ENV_TEMPLATE."
}

ensure_application_settings() {
    if [[ -f "$APPLICATION_ENV_FILE" ]]; then
        return 0
    fi
    if [[ ! -f "$APPLICATION_ENV_TEMPLATE" ]]; then
        show_message "System settings template is missing: $APPLICATION_ENV_TEMPLATE."
        return 1
    fi
    if ! mkdir -p "$RUNTIME_DIRECTORY"; then
        show_message 'Unable to create the runtime directory for System settings.'
        return 1
    fi
    if ! cp "$APPLICATION_ENV_TEMPLATE" "$APPLICATION_ENV_FILE"; then
        show_message "Unable to create $APPLICATION_ENV_FILE from the System settings template."
        return 1
    fi
    return 0
}

compose_settings_block_is_present() {
    [[ -f "$COMPOSE_ENV_FILE" ]] || return 1
    local begin_count end_count
    begin_count="$(grep -Fxc "$doge_service_settings_begin" "$COMPOSE_ENV_FILE" || true)"
    end_count="$(grep -Fxc "$doge_service_settings_end" "$COMPOSE_ENV_FILE" || true)"
    [[ "$begin_count" == 1 && "$end_count" == 1 ]]
}

create_doge_service_settings_block() {
    ensure_compose_settings
    if compose_settings_block_is_present; then
        return
    fi

    local begin_count end_count temporary
    begin_count="$(grep -Fxc "$doge_service_settings_begin" "$COMPOSE_ENV_FILE" || true)"
    end_count="$(grep -Fxc "$doge_service_settings_end" "$COMPOSE_ENV_FILE" || true)"
    if [[ "$begin_count" != 0 || "$end_count" != 0 ]]; then
        show_message "$COMPOSE_ENV_FILE has an incomplete DOGE service-settings block. Repair it manually first."
        return 1
    fi

    temporary="$(mktemp "$project_directory/.${COMPOSE_ENV_FILE}.XXXXXX")"
    if ! awk -v begin="$doge_service_settings_begin" -v end="$doge_service_settings_end" '
        /^DOGE_BASELINE_[A-Za-z0-9_]*=/ { values[++count] = $0; next }
        { lines[++lineCount] = $0 }
        END {
            for (lineIndex = 1; lineIndex <= lineCount; lineIndex += 1) print lines[lineIndex]
            print begin
            for (valueIndex = 1; valueIndex <= count; valueIndex += 1) print values[valueIndex]
            print end
        }
    ' "$COMPOSE_ENV_FILE" > "$temporary"; then
        rm -f "$temporary"
        show_message 'Unable to create the DOGE service-settings block.'
        return 1
    fi
    chmod --reference="$COMPOSE_ENV_FILE" "$temporary"
    mv "$temporary" "$COMPOSE_ENV_FILE"
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
    updated="$(mktemp "$project_directory/.${COMPOSE_ENV_FILE}.XXXXXX")"
    awk -v begin="$doge_service_settings_begin" -v end="$doge_service_settings_end" '
        $0 == begin { copy = 1; next }
        $0 == end { exit }
        copy { print }
    ' "$COMPOSE_ENV_FILE" > "$draft"
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
    ' "$COMPOSE_ENV_FILE" > "$updated"; then
        rm -f "$draft" "$updated"
        show_message 'Unable to save DOGE service settings.'
        return 1
    fi
    chmod --reference="$COMPOSE_ENV_FILE" "$updated"
    mv "$updated" "$COMPOSE_ENV_FILE"
    rm -f "$draft"
}

environment_value() {
    local file="$1" name="$2"
    [[ -f "$file" ]] || return
    awk -F= -v name="$name" '$1 == name { print substr($0, length(name) + 2); exit }' "$file"
}

manifest_value() {
    local name="$1"
    [[ -f "$RELEASE_MANIFEST_FILE" ]] || return
    awk -F'"' -v name="$name" '$2 == name { print $4; exit }' "$RELEASE_MANIFEST_FILE"
}

ensure_console() {
    [[ -f "$COMPOSE_ENV_FILE" && -f "$APPLICATION_ENV_FILE" ]] || return 1
    local container_id='' image_id='' container_image='' running=''
    image_id="$(docker image inspect --format '{{.Id}}' "$CONSOLE_IMAGE" 2>/dev/null || true)"
    [[ -n "$image_id" ]] || return 1
    container_id="$("${menu_compose[@]}" ps -q "$CONSOLE_SERVICE" 2>/dev/null || true)"
    if [[ -n "$container_id" ]]; then
        container_image="$(docker inspect --format '{{.Image}}' "$container_id" 2>/dev/null || true)"
        running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)"
        if [[ "$container_image" == "$image_id" && "$running" == true ]]; then
            return 0
        fi
    fi
    if [[ -n "$container_id" && "$container_image" != "$image_id" ]]; then
        "${menu_compose[@]}" up -d --force-recreate "$CONSOLE_SERVICE" >/dev/null 2>&1
    else
        "${menu_compose[@]}" up -d "$CONSOLE_SERVICE" >/dev/null 2>&1
    fi
}

run_console_command() {
    ensure_console || return 1
    "${menu_compose[@]}" exec -T "$CONSOLE_SERVICE" \
        node --max-old-space-size=6144 dist/app/pm-bot.js "$@" </dev/null 2>/dev/null
}

run_doge_status() {
    run_console_command status:doge-baseline --json
}

run_doge_health_status() {
    run_console_command status:doge-baseline --health --json
}

run_account_status() {
    run_console_command status:account --text
}

run_connection_status() {
    run_console_command status:connection --json
}

run_trading_config_validation() {
    run_console_command validate:trading-config --json
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

nested_status_value() {
    local section="$1" key="$2" json="$3"
    awk -F: -v section="$section" -v key="$key" '
        index($0, "\"" section "\"") { inside = 1; next }
        inside && index($0, "\"" key "\"") {
            value = $2; gsub(/[, "]/, "", value); print value; exit
        }
    ' <<< "$json"
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
    [[ -f "$WIREGUARD_OVERRIDE" ]] || { printf 'not enabled'; return; }
    local handshake now
    handshake="$("${compose[@]}" exec -T "$WIREGUARD_SERVICE" sh -c 'wg show wg0 latest-handshakes | awk "NR == 1 { print \$2 }"' 2>/dev/null || true)"
    [[ "$handshake" =~ ^[0-9]+$ ]] && ((handshake > 0)) || { printf 'not available'; return; }
    now="$(date +%s)"
    printf '%ss ago' "$((now - handshake))"
}

preflight_doge_contour() {
    local action="$1" validation=''
    local -a missing=()
    [[ -f "$APPLICATION_ENV_FILE" ]] || missing+=("$APPLICATION_ENV_FILE")
    [[ -f "$COMPOSE_ENV_FILE" ]] || missing+=("$COMPOSE_ENV_FILE")
    [[ -f "$DOGE_MODEL_FILE" ]] || missing+=('DOGE model.json')
    [[ -f "$DOGE_CONFIG_FILE" ]] || missing+=('DOGE config.json')
    if [[ -f "$WIREGUARD_OVERRIDE" && ! -f "$WIREGUARD_CONFIG" ]]; then
        missing+=('WireGuard wg0.conf')
    fi
    if ((${#missing[@]} > 0)); then
        show_message "$action blocked. Missing: ${missing[*]}"
        return 1
    fi
    if ! "${compose[@]}" config -q; then
        show_message "$action blocked. Compose configuration is invalid."
        return 1
    fi
    if ! validation="$(run_trading_config_validation)"; then
        show_message "$action blocked. Trading configuration could not be validated. Check Docker access and System settings."
        return 1
    fi
    if [[ "$(status_value valid "$validation")" != true ]]; then
        show_message "$action blocked. Replace API credential placeholders in System settings."
        return 1
    fi
    return 0
}

start_doge_contour() {
    local -a services=("${DOGE_SERVICES[@]}")
    [[ -f "$WIREGUARD_OVERRIDE" ]] && services+=("$WIREGUARD_SERVICE")
    "${compose[@]}" up -d "${services[@]}"
}

stop_doge_contour() {
    local -a services=("${DOGE_SERVICES[@]}")
    [[ -f "$WIREGUARD_OVERRIDE" ]] && services+=("$WIREGUARD_SERVICE")
    "${compose[@]}" stop "${services[@]}"
}

restart_doge_contour() {
    local -a services=("${DOGE_SERVICES[@]}")
    if [[ ! -f "$WIREGUARD_OVERRIDE" ]]; then
        "${compose[@]}" up -d --no-deps --force-recreate "${services[@]}"
        return
    fi
    if service_is_running "$CONSOLE_SERVICE"; then
        services+=("$CONSOLE_SERVICE")
    fi
    "${menu_compose[@]}" up -d --force-recreate "$WIREGUARD_SERVICE" "${services[@]}"
}

service_is_running() {
    local service="$1"
    "${menu_compose[@]}" ps --status running --services 2>/dev/null | grep -Fxq "$service"
}

restart_wireguard_bridge() {
    local -a services=("$WIREGUARD_SERVICE")
    local service
    for service in "$CONSOLE_SERVICE" "${DOGE_SERVICES[@]}"; do
        if service_is_running "$service"; then
            services+=("$service")
        fi
    done
    "${menu_compose[@]}" up -d --force-recreate "${services[@]}"
}

restart_service() {
    local service="$1"
    if [[ "$service" == "$WIREGUARD_SERVICE" ]]; then
        restart_wireguard_bridge
        return
    fi
    "${compose[@]}" up -d --no-deps --force-recreate "$service"
}

refresh_now() {
    printf '\nType REFRESH to start an immediate DOGE refresh: '
    local confirmation=''
    read -r confirmation
    if [[ "$confirmation" != 'REFRESH' ]]; then
        show_message 'Immediate refresh cancelled.'
        return
    fi
    run_menu_action 'Immediate refresh' restart_service "$REFRESH_SERVICE"
}

service_status_rows() {
    [[ -f "$COMPOSE_ENV_FILE" ]] || return
    "${compose[@]}" ps --format '{{.Service}}|{{.Status}}' 2>/dev/null || true
}

render_service_statuses() {
    local -a rows=() names=() statuses=()
    local row service status service_width=0 index
    mapfile -t rows < <(service_status_rows)
    for row in "${rows[@]}"; do
        IFS='|' read -r service status <<< "$row"
        [[ "$service" == "$CONSOLE_SERVICE" || -z "$service" ]] && continue
        names+=("$service")
        statuses+=("$status")
        ((${#service} > service_width)) && service_width=${#service}
    done
    if ((${#names[@]} == 0)); then
        render_status_line "$color_yellow" 'not available'
        return
    fi
    for ((index = 0; index < ${#names[@]}; index += 1)); do
        render_status_value "${names[index]}" "${statuses[index]}" "$color_gray" "$service_width"
    done
}

history_file_count() {
    local directory="$1" count
    [[ -d "$directory" ]] || {
        printf '0'
        return
    }
    if ! count="$(find "$directory" -maxdepth 1 -type f -name '*.json*' -print 2>/dev/null | wc -l | tr -d ' ')"; then
        return
    fi
    printf '%s' "$count"
}

show_health_check() {
    local status_json='' docker_status='not available' compose_status='not available' trading='not available' trading_display
    local latest_frame last_refresh
    docker info >/dev/null 2>&1 && docker_status='ready'
    if [[ -f "$COMPOSE_ENV_FILE" ]] && "${compose[@]}" config -q >/dev/null 2>&1; then
        compose_status='valid'
    fi
    render_top
    render_section 'DOGE HEALTH CHECK'
    render_value 'DOCKER' "$docker_status" "$color_gray"
    render_value 'COMPOSE' "$compose_status" "$color_gray"
    render_line "$color_gray" 'Checking operating status...'
    render_bottom
    if [[ -f "$COMPOSE_ENV_FILE" ]]; then
        status_json="$(run_doge_health_status || true)"
    fi
    trading="$(status_value tradingEnabled "$status_json" || true)"
    case "$trading" in
        true) trading_display='enabled' ;;
        false) trading_display='paused' ;;
        *) trading_display='not available' ;;
    esac
    latest_frame="$(format_epoch_seconds "$(status_value latestFrameStart "$status_json")")"
    last_refresh="$(format_epoch_ms "$(status_value lastSuccessfulRefreshAt "$status_json")")"
    render_value 'TRADING' "$trading_display" "$color_gray"
    render_value 'LAST FRAME' "$latest_frame" "$color_gray"
    render_value 'LAST REFRESH' "$last_refresh" "$color_gray"
    render_value 'VPN' "$(wireguard_handshake_status)" "$color_gray"
    render_rule
    render_line "$color_cyan" 'SERVICES'
    render_service_statuses
    render_rule
    render_line "$color_gray" 'Press Enter to continue'
    render_bottom
    pause
}

show_history() {
    local status_json='' complete_frames diagnostic_frames eligible_frames first_frame latest_frame
    local history_frames_directory history_directory diagnostic_directory
    render_top
    render_section 'DOGE HISTORY'
    render_line "$color_gray" 'Loading cached history status...'
    render_bottom
    if [[ -f "$COMPOSE_ENV_FILE" ]]; then
        status_json="$(run_doge_status || true)"
    fi
    complete_frames="$(status_value completeFrames "$status_json" || true)"
    eligible_frames="$(status_value eligibleFrames "$status_json" || true)"
    first_frame="$(format_epoch_seconds "$(status_value firstFrameStart "$status_json")")"
    latest_frame="$(format_epoch_seconds "$(status_value latestFrameStart "$status_json")")"
    history_frames_directory="$RUNTIME_DIRECTORY/$(environment_value "$APPLICATION_ENV_FILE" HISTORY_DIR || true)"
    [[ "$history_frames_directory" == "$RUNTIME_DIRECTORY/" ]] && history_frames_directory="$RUNTIME_DIRECTORY/history/frames"
    history_directory="$(dirname "$history_frames_directory")"
    diagnostic_directory="$history_directory/diagnostics"
    if [[ -z "$complete_frames" ]]; then
        complete_frames="$(history_file_count "$history_frames_directory")"
    fi
    diagnostic_frames="$(history_file_count "$diagnostic_directory")"
    render_top
    render_section 'DOGE HISTORY'
    render_value 'COMPLETE FRAMES' "$(or_not_available "$complete_frames")" "$color_gray"
    render_value 'ELIGIBLE FRAMES' "$(or_not_available "$eligible_frames")" "$color_gray"
    render_value 'DIAGNOSTIC' "$(or_not_available "$diagnostic_frames")" "$color_gray"
    render_value 'FIRST ELIGIBLE' "$first_frame" "$color_gray"
    render_value 'LAST ELIGIBLE' "$latest_frame" "$color_gray"
    render_value 'FRAMES SIZE' "$(or_not_available "$(du -sh "$history_frames_directory" 2>/dev/null | awk '{ print $1 }')")" "$color_gray"
    render_value 'DIAGNOSTICS SIZE' "$(or_not_available "$(du -sh "$diagnostic_directory" 2>/dev/null | awk '{ print $1 }')")" "$color_gray"
    render_value 'COMPLETE LIMIT' "$(or_not_available "$(environment_value "$COMPOSE_ENV_FILE" DOGE_BASELINE_COLLECT_COUNT || true)")" "$color_gray"
    render_value 'DIAGNOSTIC LIMIT' "$(or_not_available "$(environment_value "$APPLICATION_ENV_FILE" HISTORY_DIAGNOSTIC_FRAMES || true)")" "$color_gray"
    render_rule
    render_line "$color_gray" 'Press Enter to continue'
    render_bottom
    pause
}

show_resource_usage() {
    local original_menu_inner_width="$menu_inner_width"
    setup_detail_width
    render_top
    render_section 'DOGE RESOURCE USAGE'
    render_line "$color_gray" 'Collecting current container statistics...'
    render_bottom
    local -a services=() container_ids=() rows=()
    local service container_id stats row container cpu memory block_io index
    for service in "${DOGE_SERVICES[@]}" "$WIREGUARD_SERVICE"; do
        [[ "$service" == "$WIREGUARD_SERVICE" && ! -f "$WIREGUARD_OVERRIDE" ]] && continue
        service_is_running "$service" || continue
        container_id="$("${compose[@]}" ps -q "$service" 2>/dev/null || true)"
        [[ -n "$container_id" ]] || continue
        services+=("$service")
        container_ids+=("$container_id")
    done
    if ((${#container_ids[@]} > 0)); then
        stats="$(docker stats --no-stream --format '{{.Container}}|{{.CPUPerc}}|{{.MemUsage}}|{{.BlockIO}}' "${container_ids[@]}" 2>/dev/null || true)"
        while IFS='|' read -r container cpu memory block_io; do
            [[ -n "$container" ]] || continue
            for ((index = 0; index < ${#container_ids[@]}; index += 1)); do
                if [[ "${container_ids[index]}" == "$container"* ]]; then
                    rows+=("${services[index]}|$cpu|$memory|$block_io")
                    break
                fi
            done
        done <<< "$stats"
    fi

    render_top
    render_section 'DOGE RESOURCE USAGE'
    if ((${#rows[@]} == 0)); then
        render_status_line "$color_yellow" 'No active DOGE services.'
    else
        local service_width=7 cpu_width=3 memory_width=14 block_width=8
        for row in "${rows[@]}"; do
            IFS='|' read -r service cpu memory block_io <<< "$row"
            ((${#service} > service_width)) && service_width=${#service}
            ((${#cpu} > cpu_width)) && cpu_width=${#cpu}
            ((${#memory} > memory_width)) && memory_width=${#memory}
            ((${#block_io} > block_width)) && block_width=${#block_io}
        done
        local table_width=$((service_width + cpu_width + memory_width + block_width + 9))
        local available_width=$((menu_inner_width - 2))
        if ((table_width <= available_width)); then
            render_line "$color_cyan" "$(printf "%-*s | %-*s | %-*s | %-*s" "$service_width" SERVICE "$cpu_width" CPU "$memory_width" 'MEMORY / LIMIT' "$block_width" 'BLOCK I/O')"
            for row in "${rows[@]}"; do
                IFS='|' read -r service cpu memory block_io <<< "$row"
                render_line "$color_gray" "$(printf "%-*s | %-*s | %-*s | %-*s" "$service_width" "$service" "$cpu_width" "$cpu" "$memory_width" "$memory" "$block_width" "$block_io")"
            done
        else
            for row in "${rows[@]}"; do
                IFS='|' read -r service cpu memory block_io <<< "$row"
                render_status_line "$color_cyan" "$service"
                render_status_value 'CPU' "$cpu" "$color_gray"
                render_status_value 'MEMORY / LIMIT' "$memory" "$color_gray"
                render_status_value 'BLOCK I/O' "$block_io" "$color_gray"
            done
        fi
    fi
    render_rule
    render_status_line "$color_gray" 'Press Enter to continue'
    render_bottom
    pause
    menu_inner_width="$original_menu_inner_width"
}

show_doge_monitor() {
    while true; do
        choose_menu 'DOGE Monitor' 'Health check' 'History' 'Refresh now' 'Resource usage' 'Back'
        case "$menu_choice" in
            0) show_health_check ;;
            1) show_history ;;
            2) refresh_now ;;
            3) show_resource_usage ;;
            4) return ;;
        esac
    done
}

show_account() {
    local account_text='' line
    render_top
    render_section 'ACCOUNT'
    render_line "$color_gray" 'Loading read-only account information...'
    render_bottom
    if [[ -f "$COMPOSE_ENV_FILE" && -f "$APPLICATION_ENV_FILE" ]]; then
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
        render_line "$color_gray" 'Check Docker access and System settings.'
    fi
    render_rule
    render_line "$color_gray" 'Press Enter to continue'
    render_bottom
    pause
}

show_status() {
    local strategy_mode='not available'
    local original_menu_inner_width="$menu_inner_width"
    setup_detail_width
    if [[ -f "$COMPOSE_ENV_FILE" ]]; then
        strategy_mode="$(environment_value "$COMPOSE_ENV_FILE" DOGE_BASELINE_STRATEGY_MODE || true)"
    fi
    local status_json='' trading_enabled eligible_frames entry_profile exit_profile pause_reason model_version config_version model_config
    render_top
    render_section 'STATUS'
    render_status_value 'STRATEGY MODE' "$(or_not_available "$strategy_mode")" "$color_green"
    render_rule
    render_status_line "$color_gray" 'Loading validated status...'
    render_status_line "$color_gray" 'First history analysis can take longer.'
    render_bottom
    if [[ -f "$COMPOSE_ENV_FILE" ]]; then
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
    render_status_value 'DISK FREE' "$(or_not_available "$(df -h "$RUNTIME_DIRECTORY" 2>/dev/null | awk 'NR == 2 { print $4 }')")" "$color_gray"
    render_status_value 'VPN' "$(wireguard_handshake_status)" "$color_gray"
    render_status_value 'RELEASE' "$(or_not_available "$(manifest_value gitRevision || true)")" "$color_gray"
    render_status_value 'IMAGE' "$(or_not_available "$(manifest_value imageId || true)")" "$color_gray"
    render_rule
    render_status_line "$color_cyan" 'SERVICES'
    if [[ -f "$COMPOSE_ENV_FILE" ]]; then
        render_service_statuses
    else
        render_status_line "$color_yellow" "not available: $COMPOSE_ENV_FILE is missing"
    fi
    render_rule
    render_status_line "$color_gray" 'Press Enter to continue'
    render_bottom
    pause
    menu_inner_width="$original_menu_inner_width"
}

show_connection() {
    local status_json='' ipv4 dns_available route ipv4_reason
    local original_menu_inner_width="$menu_inner_width"
    setup_detail_width
    render_top
    render_section 'CONNECTION'
    render_line "$color_gray" 'Checking IPv4 and DNS...'
    render_bottom
    if [[ -f "$COMPOSE_ENV_FILE" && -f "$APPLICATION_ENV_FILE" ]]; then
        status_json="$(run_connection_status || true)"
    fi
    ipv4="$(nested_status_value ipv4 value "$status_json" || true)"
    dns_available="$(nested_status_value dns available "$status_json" || true)"
    ipv4_reason="$(nested_status_value ipv4 reason "$status_json" || true)"
    [[ -n "$ipv4" ]] || ipv4="not available${ipv4_reason:+ ($ipv4_reason)}"
    route='not enabled'
    if [[ -f "$WIREGUARD_OVERRIDE" ]]; then
        route="$("${compose[@]}" exec -T "$WIREGUARD_SERVICE" sh -c 'ip route get 1.1.1.1 2>/dev/null | head -n 1' 2>/dev/null || true)"
        route="$(or_not_available "$route")"
    fi
    render_top
    render_section 'CONNECTION'
    render_status_value 'IPV4' "$ipv4" "$color_gray"
    if [[ "$dns_available" == true ]]; then
        render_status_value 'DNS' 'available' "$color_gray"
    else
        render_status_value 'DNS' 'not available' "$color_gray"
    fi
    render_status_value 'VPN ROUTE' "$route" "$color_gray"
    render_status_value 'VPN' "$(wireguard_handshake_status)" "$color_gray"
    render_rule
    render_status_line "$color_gray" 'Press Enter to continue'
    render_bottom
    pause
    menu_inner_width="$original_menu_inner_width"
}

stopped_compose_containers() {
    [[ -f "$COMPOSE_ENV_FILE" ]] || return
    local container_id service running
    while IFS= read -r container_id; do
        [[ -n "$container_id" ]] || continue
        service="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$container_id" 2>/dev/null || true)"
        running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)"
        [[ "$running" == false && -n "$service" ]] && printf '%s\n' "$service"
    done < <("${compose[@]}" ps -aq 2>/dev/null || true)
}

show_stopped_containers() {
    local original_menu_inner_width="$menu_inner_width"
    local -a services=()
    mapfile -t services < <(stopped_compose_containers)
    setup_detail_width
    render_top
    render_section 'STOPPED CONTAINERS'
    if ((${#services[@]} == 0)); then
        render_status_line "$color_gray" 'No stopped containers in this project.'
    else
        local service
        for service in "${services[@]}"; do
            render_status_line "$color_gray" "$service"
        done
    fi
    render_rule
    render_status_line "$color_gray" 'Press Enter to continue'
    render_bottom
    pause
    menu_inner_width="$original_menu_inner_width"
}

show_image_usage() {
    local original_menu_inner_width="$menu_inner_width"
    local image details image_width=0
    local -a images=("$CONSOLE_IMAGE" 'lscr.io/linuxserver/wireguard:latest') details=()
    setup_detail_width
    for image in "${images[@]}"; do
        details+=("$(docker image inspect --format '{{.Size}} bytes | {{.Id}}' "$image" 2>/dev/null || true)")
        ((${#image} > image_width)) && image_width=${#image}
    done
    render_top
    render_section 'IMAGE USAGE'
    local index
    for ((index = 0; index < ${#images[@]}; index += 1)); do
        render_status_value "${images[index]}" "$(or_not_available "${details[index]}")" "$color_gray" "$image_width"
    done
    render_rule
    render_status_line "$color_gray" 'Press Enter to continue'
    render_bottom
    pause
    menu_inner_width="$original_menu_inner_width"
}

remove_stopped_containers() {
    local -a services=()
    mapfile -t services < <(stopped_compose_containers)
    if ((${#services[@]} == 0)); then
        show_message 'No stopped containers are available to remove.'
        return
    fi
    printf '\nStopped containers: %s\n' "${services[*]}"
    printf 'Type REMOVE to delete only these stopped project containers: '
    local confirmation=''
    read -r confirmation
    if [[ "$confirmation" != 'REMOVE' ]]; then
        show_message 'Stopped-container removal cancelled.'
        return
    fi
    run_menu_action 'Stopped-container removal' "${compose[@]}" rm -f
}

docker_menu() {
    while true; do
        choose_menu 'Docker tools' 'Show stopped containers' 'Show image usage' 'Remove stopped containers' 'Back'
        case "$menu_choice" in
            0) show_stopped_containers ;;
            1) show_image_usage ;;
            2) remove_stopped_containers ;;
            3) return ;;
        esac
    done
}

system_menu() {
    while true; do
        choose_menu 'System' 'Connection' 'VPN settings' 'System settings' 'Docker tools' 'Update image' 'Back'
        case "$menu_choice" in
            0) show_connection ;;
            1) vpn_menu ;;
            2)
                if ensure_application_settings; then
                    open_editor "$APPLICATION_ENV_FILE" || true
                fi
                ;;
            3) docker_menu ;;
            4)
                run_menu_action 'Image update' bash "$INSTALL_SCRIPT" --update-image --no-menu
                ;;
            5)
                return
                ;;
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
    while true; do
        choose_menu 'Weekly research' 'Weekly research settings' 'Install or update service' 'Uninstall service' 'Back'
        case "$menu_choice" in
            0)
                [[ -e "$WEEKLY_RESEARCH_SETTINGS" ]] || cp "$WEEKLY_RESEARCH_TEMPLATE" "$WEEKLY_RESEARCH_SETTINGS"
                open_editor "$WEEKLY_RESEARCH_SETTINGS" || true
                ;;
            1) run_menu_action 'Weekly research service installation' bash "$WEEKLY_RESEARCH_INSTALL_SCRIPT" ;;
            2) run_menu_action 'Weekly research service removal' bash "$WEEKLY_RESEARCH_UNINSTALL_SCRIPT" ;;
            3) return ;;
        esac
    done
}

wireguard_status() {
    render_top
    render_section 'WIREGUARD CONNECTION'
    if [[ -f "$WIREGUARD_OVERRIDE" ]]; then
        render_value 'OVERRIDE' 'enabled' "$color_green"
    elif [[ -f "$WIREGUARD_DISABLED_OVERRIDE" ]]; then
        render_value 'OVERRIDE' 'disabled' "$color_yellow"
    else
        render_value 'OVERRIDE' 'not configured' "$color_yellow"
    fi
    [[ -f "$WIREGUARD_CONFIG" ]] && render_value 'ACTIVE CONFIG' 'available' "$color_green" || render_value 'ACTIVE CONFIG' 'not available' "$color_yellow"
    [[ -f "$WIREGUARD_TEMPLATE" ]] && render_value 'DRAFT' 'available' "$color_green" || render_value 'DRAFT' 'not available' "$color_yellow"
    [[ -f "$WIREGUARD_PREVIOUS_CONFIG" ]] && render_value 'PREVIOUS CONFIG' 'available' "$color_gray" || true
    render_rule
    render_line "$color_gray" 'No WireGuard credentials are displayed'
    render_line "$color_gray" 'Press Enter to continue'
    render_bottom
    pause
}

wireguard_override_menu_label() {
    [[ -f "$WIREGUARD_OVERRIDE" ]] && printf 'Disable WireGuard' || printf 'Enable WireGuard'
}

toggle_wireguard_override() {
    if [[ -f "$WIREGUARD_OVERRIDE" ]]; then
        mv "$WIREGUARD_OVERRIDE" "$WIREGUARD_DISABLED_OVERRIDE"
        show_message 'WireGuard override disabled. Restart services to apply the network change.'
        return
    fi
    if [[ -f "$WIREGUARD_DISABLED_OVERRIDE" ]]; then
        mv "$WIREGUARD_DISABLED_OVERRIDE" "$WIREGUARD_OVERRIDE"
    else
        cp "$WIREGUARD_OVERRIDE_TEMPLATE" "$WIREGUARD_OVERRIDE"
    fi
    show_message 'WireGuard override enabled. Restart services to apply the network change.'
}

create_or_edit_wireguard_draft() {
    mkdir -p "$WIREGUARD_DIRECTORY"
    if [[ ! -f "$WIREGUARD_TEMPLATE" ]]; then
        cp "$WIREGUARD_SOURCE_TEMPLATE" "$WIREGUARD_TEMPLATE"
        chmod 600 "$WIREGUARD_TEMPLATE"
    fi
    open_editor "$WIREGUARD_TEMPLATE" || true
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
    ' "$WIREGUARD_TEMPLATE"
}

validate_wireguard_draft() {
    [[ -f "$WIREGUARD_TEMPLATE" ]] || {
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
        -v "$project_directory/$WIREGUARD_DIRECTORY:/config:ro" \
        lscr.io/linuxserver/wireguard:latest strip /config/wg_confs/wg0.conf.new >/dev/null 2>&1; then
        show_message 'WireGuard draft failed syntax validation.'
        return 1
    fi
}

apply_wireguard_draft() {
    validate_wireguard_draft || return
    local active_was_present=false
    if [[ -f "$WIREGUARD_CONFIG" ]]; then
        mv -f "$WIREGUARD_CONFIG" "$WIREGUARD_PREVIOUS_CONFIG"
        active_was_present=true
    fi
    if ! mv "$WIREGUARD_TEMPLATE" "$WIREGUARD_CONFIG"; then
        if [[ "$active_was_present" == true ]]; then mv "$WIREGUARD_PREVIOUS_CONFIG" "$WIREGUARD_CONFIG"; fi
        show_message 'WireGuard draft could not be applied. The active configuration was restored.'
        return 1
    fi
    chmod 600 "$WIREGUARD_CONFIG"
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
    [[ -d "$LOG_DIRECTORY" ]] || return
    find "$LOG_DIRECTORY" -maxdepth 1 -type f -name "${service}.log*" -printf '%T@:%p\n' 2>/dev/null |
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
        choose_menu "LOG / $(basename "$file")" 'Open at end' 'Warnings and errors' 'Last N lines' 'Follow current log' 'Back'
        case "$menu_choice" in
            0) open_log_file "$file" ;;
            1) open_filtered_log_file "$file" ;;
            2) open_log_tail "$file" ;;
            3) follow_log_file "$file" ;;
            4) return ;;
        esac
    done
}

view_service_logs() {
    local service="$1" original_menu_width="$menu_width" original_menu_inner_width="$menu_inner_width"
    menu_width=$LOG_MENU_WIDTH
    menu_inner_width=$((menu_width - 4))
    if [[ "$service" == "$WIREGUARD_SERVICE" ]]; then
        if ! command -v less >/dev/null 2>&1; then
            show_message 'less is required to view logs. Install it and try again.'
            menu_width=$original_menu_width
            menu_inner_width=$original_menu_inner_width
            return
        fi
        { "${compose[@]}" logs --tail 200 "$service" || true; } | less +G || true
        menu_width=$original_menu_width
        menu_inner_width=$original_menu_inner_width
        return
    fi
    local -a files labels
    mapfile -t files < <(list_service_log_files "$service")
    if ((${#files[@]} == 0)); then
        if ! command -v less >/dev/null 2>&1; then
            show_message 'less is required to view logs. Install it and try again.'
            menu_width=$original_menu_width
            menu_inner_width=$original_menu_inner_width
            return
        fi
        { "${compose[@]}" logs --tail 200 --follow "$service" || true; } | less +F || true
        menu_width=$original_menu_width
        menu_inner_width=$original_menu_inner_width
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
            menu_width=$original_menu_width
            menu_inner_width=$original_menu_inner_width
            return
        fi
        log_file_menu "${files[menu_choice]}"
    done
}

service_menu() {
    local -a services=() configured_services=()
    mapfile -t configured_services < <("${compose[@]}" config --services)
    local service
    for service in "${configured_services[@]}"; do
        [[ "$service" == "$CONSOLE_SERVICE" ]] || services+=("$service")
    done
    ((${#services[@]} > 0)) || { show_message 'No Compose services are available.'; return; }
    services+=('Back')
    while true; do
        choose_menu 'Services' "${services[@]}"
        local selected="$menu_choice"
        if ((selected == ${#services[@]} - 1)); then
            return
        fi
        service="${services[selected]}"
        while true; do
        choose_menu "Service: $service" 'Start' 'Stop' 'Restart' 'View logs' 'Back'
            case "$menu_choice" in
                0)
                    if [[ "$service" != "$STRATEGY_SERVICE" ]] || preflight_doge_contour "Start $service"; then
                        run_menu_action "Start $service" "${compose[@]}" up -d "$service"
                    fi
                    ;;
                1) run_menu_action "Stop $service" "${compose[@]}" stop "$service" ;;
                2)
                    if [[ "$service" != "$STRATEGY_SERVICE" ]] || preflight_doge_contour "Restart $service"; then
                        run_menu_action "Restart $service" restart_service "$service"
                    fi
                    ;;
                3) view_service_logs "$service" ;;
                4) break ;;
            esac
        done
    done
}

doge_baseline_menu() {
    while true; do
        choose_menu 'DOGE Baseline' 'Status' 'Start' 'Stop' 'Restart' 'Monitor' 'Settings' 'Services' 'Back'
        case "$menu_choice" in
            0) show_status ;;
            1) if preflight_doge_contour 'Start'; then run_menu_action 'Start' start_doge_contour; fi ;;
            2) run_menu_action 'Stop' stop_doge_contour ;;
            3) if preflight_doge_contour 'Restart'; then run_menu_action 'Restart' restart_doge_contour; fi ;;
            4) show_doge_monitor ;;
            5) doge_settings_menu ;;
            6) service_menu ;;
            7) return ;;
        esac
    done
}

if [[ -f "$COMPOSE_ENV_FILE" && -f "$APPLICATION_ENV_FILE" ]]; then
    ensure_console || true
fi

while true; do
    choose_menu 'PM Bot' 'Account' 'DOGE Baseline' 'System' 'Exit'
    case "$menu_choice" in
        0) show_account ;;
        1) doge_baseline_menu ;;
        2) system_menu ;;
        3) exit 0 ;;
    esac
done
