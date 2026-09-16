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
`sudo`. Use the optional flag instead; only Docker receives elevated privileges
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
```

`runtime/.env` is mounted read-only and contains application settings and
secrets. It is never included in an archive. The full archive additionally
contains `runtime/models` and `runtime/history`; the tiny archive requires those
to be copied separately before strategy or refresh can use them. All archives
already contain the writable `runtime/history`, `runtime/models`, and
`runtime/logs` directories, so Docker does not create them as root.

Application environment variables such as `LOG_LEVEL`, log rotation, and
`HISTORY_SNAPSHOT_MS` belong in `runtime/.env`. Command parameters of the DOGE
Baseline contour belong in `compose.env`.

Start a contour:

```bash
export PUID=$(id -u)
export PGID=$(id -g)

docker compose --env-file compose.env up -d collector-doge-baseline

docker compose --env-file compose.env up -d strategy-doge-baseline

docker compose --env-file compose.env up -d refresh-doge-baseline
```

The three services share `runtime/history` and `runtime/models`. Their separate
file logs are written to `runtime/logs`; Docker logs remain available too:

```bash
docker compose --env-file compose.env logs -f collector-doge-baseline
docker compose --env-file compose.env logs -f strategy-doge-baseline
docker compose --env-file compose.env logs -f refresh-doge-baseline
```

Stop all services gracefully:

```bash
docker compose --env-file compose.env stop
```

## Native Linux x64 archive

The existing native deployment remains available:

```bash
npm run deploy -- --tiny
npm run deploy -- --full
```

It embeds a 6 GiB V8 old-space limit.
