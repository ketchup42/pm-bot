#!/usr/bin/env bash
set -Eeuo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_directory"

readonly IMAGE_ARCHIVE_FILE='image.tar'
readonly RELEASE_MANIFEST_FILE='release-manifest.json'
readonly COMPOSE_FILE='compose.yaml'
readonly COMPOSE_ENV_FILE='compose.env'
readonly COMPOSE_ENV_TEMPLATE='compose.env.example'
readonly WIREGUARD_OVERRIDE_TEMPLATE='compose.wireguard.override.yaml.example'
readonly APPLICATION_ENV_TEMPLATE='runtime.env.example'
readonly MENU_SCRIPT='menu.sh'
readonly WIREGUARD_SOURCE_TEMPLATE='network/wireguard/wg0.conf.template'
readonly RUNTIME_DIRECTORY='runtime'
readonly APPLICATION_ENV_FILE="$RUNTIME_DIRECTORY/.env"
readonly INSTALLED_MANIFEST_FILE="$RUNTIME_DIRECTORY/.installed-release-manifest.json"
readonly HISTORY_DIRECTORY="$RUNTIME_DIRECTORY/history"
readonly MODEL_DIRECTORY="$RUNTIME_DIRECTORY/models"
readonly LOG_DIRECTORY="$RUNTIME_DIRECTORY/logs"
readonly WIREGUARD_DIRECTORY="$RUNTIME_DIRECTORY/wireguard/wg_confs"

force_image_update=false
open_menu=true
for argument in "$@"; do
    case "$argument" in
        --update-image) force_image_update=true ;;
        --no-menu) open_menu=false ;;
        *) echo "[PM Bot install] Unknown argument: $argument" >&2; exit 1 ;;
    esac
done

fail() {
    echo "[PM Bot install] $*" >&2
    exit 1
}

require_file() {
    [[ -f "$1" ]] || fail "Missing required file: $1"
}

command -v docker >/dev/null 2>&1 || fail 'Docker Engine is required.'
docker info >/dev/null 2>&1 || fail 'Docker is unavailable for this user. Add the user to the docker group and log in again.'
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required. Use docker compose, not docker-compose.'

require_file "$IMAGE_ARCHIVE_FILE"
require_file "$RELEASE_MANIFEST_FILE"
require_file "$COMPOSE_FILE"
require_file "$COMPOSE_ENV_TEMPLATE"
require_file "$WIREGUARD_OVERRIDE_TEMPLATE"
require_file "$APPLICATION_ENV_TEMPLATE"
require_file "$MENU_SCRIPT"
require_file "$WIREGUARD_SOURCE_TEMPLATE"

mkdir -p "$HISTORY_DIRECTORY" "$MODEL_DIRECTORY" "$LOG_DIRECTORY" "$WIREGUARD_DIRECTORY"

if [[ ! -e "$COMPOSE_ENV_FILE" ]]; then
    cp "$COMPOSE_ENV_TEMPLATE" "$COMPOSE_ENV_FILE"
    printf '\nPUID=%s\nPGID=%s\n' "$(id -u)" "$(id -g)" >> "$COMPOSE_ENV_FILE"
    echo "[PM Bot install] Created $COMPOSE_ENV_FILE from $COMPOSE_ENV_TEMPLATE."
fi

if [[ ! -f "$APPLICATION_ENV_FILE" ]]; then
    cp "$APPLICATION_ENV_TEMPLATE" "$APPLICATION_ENV_FILE" || fail "Unable to create $APPLICATION_ENV_FILE from $APPLICATION_ENV_TEMPLATE."
    echo "[PM Bot install] Created $APPLICATION_ENV_FILE from $APPLICATION_ENV_TEMPLATE. Replace live API placeholders before using live trading."
fi

expected_image_sha256="$(awk -F'"' '/"imageSha256"/ { print $4; exit }' "$RELEASE_MANIFEST_FILE")"
expected_image_name="$(awk -F'"' '/"imageName"/ { print $4; exit }' "$RELEASE_MANIFEST_FILE")"
expected_image_id="$(awk -F'"' '/"imageId"/ { print $4; exit }' "$RELEASE_MANIFEST_FILE")"
expected_wireguard_image_name="$(awk -F'"' '/"wireguardImageName"/ { print $4; exit }' "$RELEASE_MANIFEST_FILE")"
expected_wireguard_image_id="$(awk -F'"' '/"wireguardImageId"/ { print $4; exit }' "$RELEASE_MANIFEST_FILE")"

[[ "$expected_image_sha256" =~ ^[a-f0-9]{64}$ ]] || fail "$RELEASE_MANIFEST_FILE has no valid SHA-256 for $IMAGE_ARCHIVE_FILE."

verify_image_archive() {
    command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required to verify $IMAGE_ARCHIVE_FILE."
    local actual_image_sha256
    actual_image_sha256="$(sha256sum "$IMAGE_ARCHIVE_FILE" | awk '{ print $1 }')"
    [[ "$actual_image_sha256" == "$expected_image_sha256" ]] || fail "$IMAGE_ARCHIVE_FILE does not match the SHA-256 in $RELEASE_MANIFEST_FILE."
}

image_matches_manifest() {
    local image_name="$1"
    local expected_image_id="$2"
    local actual_image_id
    [[ -n "$image_name" && -n "$expected_image_id" ]] || return 1
    actual_image_id="$(docker image inspect --format '{{.Id}}' "$image_name" 2>/dev/null || true)"
    [[ "$actual_image_id" == "$expected_image_id" ]]
}

images_match_manifest() {
    image_matches_manifest "$expected_image_name" "$expected_image_id" &&
        image_matches_manifest "$expected_wireguard_image_name" "$expected_wireguard_image_id"
}

if [[ "$force_image_update" == true || ! -f "$INSTALLED_MANIFEST_FILE" ]] ||
    ! cmp -s "$RELEASE_MANIFEST_FILE" "$INSTALLED_MANIFEST_FILE" || ! images_match_manifest; then
    echo "[PM Bot install] Loading Docker images from $IMAGE_ARCHIVE_FILE."
    verify_image_archive
    docker load -i "$IMAGE_ARCHIVE_FILE"
    images_match_manifest || fail "Docker loaded $IMAGE_ARCHIVE_FILE, but the required application or WireGuard image does not match $RELEASE_MANIFEST_FILE."
    cp "$RELEASE_MANIFEST_FILE" "$INSTALLED_MANIFEST_FILE"
else
    echo "[PM Bot install] Docker images already match $RELEASE_MANIFEST_FILE."
fi
docker compose --env-file "$COMPOSE_ENV_FILE" --profile menu config -q

echo '[PM Bot install] Ready.'
if [[ "$open_menu" == true ]]; then
    exec bash "$project_directory/$MENU_SCRIPT"
fi
