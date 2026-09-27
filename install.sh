#!/usr/bin/env bash
set -Eeuo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_directory"
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

require_file image.tar
require_file release-manifest.json
require_file compose.yaml
require_file compose.env.example
require_file compose.wireguard.override.yaml.example
require_file runtime.env.example
require_file menu.sh
require_file network/wireguard/wg0.conf.template

mkdir -p runtime/history runtime/models runtime/logs runtime/wireguard/wg_confs

if [[ ! -e compose.env ]]; then
    cp compose.env.example compose.env
    printf '\nPUID=%s\nPGID=%s\n' "$(id -u)" "$(id -g)" >> compose.env
    echo '[PM Bot install] Created compose.env from compose.env.example.'
fi

if [[ ! -f runtime/.env ]]; then
    cp runtime.env.example runtime/.env || fail 'Unable to create runtime/.env from runtime.env.example.'
    echo '[PM Bot install] Created runtime/.env from runtime.env.example. Replace live API placeholders before using live trading.'
fi

installed_manifest='runtime/.installed-release-manifest.json'
expected_image_sha256="$(awk -F'"' '/"imageSha256"/ { print $4; exit }' release-manifest.json)"
expected_image_name="$(awk -F'"' '/"imageName"/ { print $4; exit }' release-manifest.json)"
expected_image_id="$(awk -F'"' '/"imageId"/ { print $4; exit }' release-manifest.json)"
expected_wireguard_image_name="$(awk -F'"' '/"wireguardImageName"/ { print $4; exit }' release-manifest.json)"
expected_wireguard_image_id="$(awk -F'"' '/"wireguardImageId"/ { print $4; exit }' release-manifest.json)"

[[ "$expected_image_sha256" =~ ^[a-f0-9]{64}$ ]] || fail 'release-manifest.json has no valid SHA-256 for image.tar.'

verify_image_archive() {
    command -v sha256sum >/dev/null 2>&1 || fail 'sha256sum is required to verify image.tar.'
    local actual_image_sha256
    actual_image_sha256="$(sha256sum image.tar | awk '{ print $1 }')"
    [[ "$actual_image_sha256" == "$expected_image_sha256" ]] || fail 'image.tar does not match the SHA-256 in release-manifest.json.'
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

if [[ "$force_image_update" == true || ! -f "$installed_manifest" ]] ||
    ! cmp -s release-manifest.json "$installed_manifest" || ! images_match_manifest; then
    echo '[PM Bot install] Loading Docker images from image.tar.'
    verify_image_archive
    docker load -i image.tar
    images_match_manifest || fail 'Docker loaded image.tar, but the required application or WireGuard image does not match release-manifest.json.'
    cp release-manifest.json "$installed_manifest"
else
    echo '[PM Bot install] Docker images already match release-manifest.json.'
fi
docker compose --env-file compose.env config -q

echo '[PM Bot install] Ready.'
if [[ "$open_menu" == true ]]; then
    exec bash "$project_directory/menu.sh"
fi
