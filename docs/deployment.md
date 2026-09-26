# Deployment

## Docker for Linux x86-64

Docker deployment is independent of the Linux distribution on the server. The
only server requirements are Docker Engine, Docker Compose v2, and an x86-64 CPU.

Build an archive locally:

```bash
# Image, Compose configuration, and instructions.
npm run deploy:docker -- --tiny

# The same package with the current DOGE model and saved history frames.
npm run deploy:docker -- --full
```

If the local user is not in the `docker` group, do not run npm itself through
`sudo`. Use the optional flag instead. Only Docker receives elevated privileges
and the resulting archive remains owned by the local user:

```bash
npm run deploy:docker -- --tiny --sudo
npm run deploy:docker -- --full --sudo
```

Before loading and starting the contour, add the server user to the `docker`
group, log out of SSH completely, and log in again:

```bash
sudo groupadd --force docker
sudo usermod -aG docker "$USER"
id -nG
docker info
```

Upload and unpack the selected archive on the server, then load its image:

```bash
7z x pm-bot-docker-linux-amd64-tiny.7z
cd pm-bot-docker-linux-amd64
docker load -i image.tar
```

Create the local Compose parameters file:

```bash
cp compose.env.example compose.env
printf '\nPUID=%s\nPGID=%s\n' "$(id -u)" "$(id -g)" >> compose.env
```

`runtime/.env` is mounted read-only and contains application settings and
secrets. It is never included in an archive. The full archive additionally
contains `runtime/models` and `runtime/history`. The tiny archive requires those
to be copied separately before strategy or refresh can use them. All archives
already contain the writable `runtime/history`, `runtime/models`, and
`runtime/logs` directories, so Docker does not create them as root.

Application environment variables such as `LOG_LEVEL`, log rotation, and
`HISTORY_SNAPSHOT_MS` belong in `runtime/.env`. The complete Docker contour
configuration, including `PUID`, `PGID`, and DOGE command parameters, belongs in
`compose.env`. Compose stops before creating containers if any required value is
absent.

The Docker strategy command includes `--no-dumps`, so virtual runs do not create
legacy scheduler dump files. This does not affect virtual order execution.

## WireGuard bridge

The optional Docker override directs the complete network traffic of the contour
through a WireGuard client container. Copy the existing client configuration to
`runtime/wireguard/wg_confs/wg0.conf`. This file contains private credentials and
is never included in Git, the Docker build context, or deployment archives.

Enable the override only after stopping the host WireGuard client that uses the
same key:

```bash
cp compose.override.yaml.example compose.override.yaml
```

The client configuration must route IPv4 traffic through the tunnel with
`AllowedIPs = 0.0.0.0/0`. Do not set `Table = off`. Use an IP address in
`Endpoint` so the initial tunnel connection does not depend on DNS. Add
`DNS = 1.1.1.1` to `[Interface]`. IPv6 is disabled inside the WireGuard network
namespace. The remote WireGuard server must forward and NAT client traffic to
the internet.

Add the following line to `[Interface]` as a kill switch. It blocks ordinary
external traffic unless it goes through `wg0`, while allowing WireGuard's marked
encrypted packets to reach the VPN server:

```ini
PostUp = iptables -I OUTPUT ! -o %i -m mark ! --mark $(wg show %i fwmark) -m addrtype ! --dst-type LOCAL -j REJECT
```

The override assigns `1.1.1.1` as DNS for `wireguard-bridge`. Docker does not
allow individual DNS settings on services that share its network namespace.

Start a contour:

```bash
docker compose --env-file compose.env up -d collector-doge-baseline

docker compose --env-file compose.env up -d strategy-doge-baseline

docker compose --env-file compose.env up -d refresh-doge-baseline
```

The three services share `runtime/history` and `runtime/models`. Their separate
file logs are written to `runtime/logs`. Docker logs remain available too:

```bash
docker compose --env-file compose.env logs -f collector-doge-baseline
docker compose --env-file compose.env logs -f strategy-doge-baseline
docker compose --env-file compose.env logs -f refresh-doge-baseline
```

Stop all services gracefully:

```bash
docker compose --env-file compose.env stop
```

## Weekly DOGE regime research

The deployment archive contains `run-doge-regime-research.sh` and user-level systemd
templates under `systemd/`. The weekly run leaves the collector active, stops the
strategy and refresh, applies the walk-forward regime profile, then starts those
two services again even when the research command fails. It normally takes 4–6
hours with the Compose CPU limit of one core and requires at least 1,200 eligible
DOGE frames.

Install the timer after extracting the archive in the standard location
`~/pm-bot/pm-bot-docker-linux-amd64`:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/pm-bot-doge-regime-research.* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pm-bot-doge-regime-research.timer
loginctl enable-linger "$USER"
```

It runs every Sunday at 03:15 in the server time zone. It does not catch up after
a server outage. Inspect the schedule and the last run with:

```bash
systemctl --user list-timers pm-bot-doge-regime-research.timer
journalctl --user -u pm-bot-doge-regime-research.service
```

Run one scheduled cycle manually when needed:

```bash
systemctl --user start pm-bot-doge-regime-research.service
```

## Native Linux x64 archive

The existing native deployment remains available:

```bash
npm run deploy -- --tiny
npm run deploy -- --full
```

The native executable and npm application commands use a 6 GiB V8 old-space limit.
