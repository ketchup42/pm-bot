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

Upload and unpack the selected archive on the server, then load its image:

```bash
7z x pm-bot-docker-linux-amd64-tiny.7z
cd pm-bot-docker-linux-amd64
sudo docker load -i image.tar
```

Create `runtime/.env` manually. It is mounted read-only into containers and is
never included in an archive. The full archive additionally contains
`runtime/models` and `runtime/history`; the tiny archive requires those to be
copied separately before strategy or refresh can use them.

Start a contour. These commands do not require adding the user to the `docker`
group: Docker runs through `sudo`, while `PUID` and `PGID` ensure that runtime
files remain owned by the current user.

```bash
sudo PUID="$(id -u)" PGID="$(id -g)" \
  docker compose up -d collector-doge-baseline

sudo PUID="$(id -u)" PGID="$(id -g)" \
  docker compose up -d strategy-doge-baseline

sudo PUID="$(id -u)" PGID="$(id -g)" \
  docker compose up -d refresh-doge-baseline
```

The three services share `runtime/history` and `runtime/models`. Their separate
file logs are written to `runtime/logs`; Docker logs remain available too:

```bash
sudo docker compose logs -f collector-doge-baseline
sudo docker compose logs -f strategy-doge-baseline
sudo docker compose logs -f refresh-doge-baseline
```

Stop all services gracefully:

```bash
sudo docker compose stop
```

## Native Linux x64 archive

The existing native deployment remains available:

```bash
npm run deploy -- --tiny
npm run deploy -- --full
```

It embeds a 6 GiB V8 old-space limit.
