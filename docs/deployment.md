# Deployment

## Docker archive

Build a Linux x86-64 archive locally:

```bash
npm run deploy:docker -- --tiny --sudo
```

Use `--full` when the archive must include the current DOGE model and collected
history. Upload, unpack, and enter the resulting directory on the server.

The installer creates `runtime/.env` from `runtime.env.example` when it is
absent. Replace the live API placeholders in Application settings before live
trading. The completed file is mounted read-only and is never included in Git or
deployment archives.

Start the guided setup:

```bash
bash install.sh
```

The installer validates the package, creates missing runtime directories, creates
`compose.env` when needed, and opens the interactive menu. It skips `docker load`
when the loaded image already matches `release-manifest.json`. Existing settings,
history, models, logs, and WireGuard configuration remain unchanged.

Open the same menu later with:

```bash
bash menu.sh
```

Docker Engine, Docker Compose v2, an x86-64 CPU, and a server user allowed to
run Docker are required.

## Menu guide

The main menu begins with `Account`, then lists available trading contours.
`Account` shows the masked account address, Polygon pUSD balance, public
mark-to-market position data, and read-only CLOB open orders. It never submits,
cancels, or synchronizes orders.

`DOGE Baseline` currently provides the following actions:

| Menu item | Purpose |
| --- | --- |
| Status | Show validated artifacts, trading permission, recent refresh, history, disk, VPN, and package version. |
| Start / Stop / Restart | Manage the complete DOGE contour. Start checks required artifacts first. |
| VPN | Configure a supported VPN profile. |
| Settings | Edit DOGE service settings and manage weekly research. |
| Services | Start, stop, restart, follow, filter, or inspect one service log. |

The global `Settings` menu edits application settings and force-loads a new Docker
image. DOGE `Settings`, `Service settings` opens only the marked
`DOGE_BASELINE_*` block in `compose.env`. Other Compose settings remain untouched.

Use Up and Down to select an item, Enter to run it, and Esc to return. Long
lists, including archived log files, show ten entries at a time and scroll with
the same arrow keys.

`Services` lists the ten newest logs per page with size and modification
time. The selected log can open at its end, follow in `less`, show only
warnings and errors, or show its final N lines. WireGuard has no application file
log, therefore its entry follows its Docker log stream instead. Leave every log
viewer with `q`.

The `status:account --json` and `status:doge-baseline --json` application
commands are the sources of account and DOGE status. The menu runs them through
an internal `console` container. It starts only from `menu.sh`, is recreated when
the loaded application image changes, and is not part of Start, Stop, or Restart
for a trading contour.

## History retention

The continuous collector retains the newest 2,400 complete frames for each coin in
`runtime/history/frames`. It moves incomplete frames to `runtime/history/diagnostics`
and retains the newest 1,000 there. Rotation runs only after a new complete frame
has been safely written. Configure both limits in `runtime/.env`.

## WireGuard

Choose `DOGE Baseline`, `VPN`, then `WireGuard`. The menu enables
the Compose override and creates an editable connection template with the
tunnel address, endpoint, routing, DNS, and MTU. It opens the template in your
editor, where you enter the client private key and server public key directly.
The scripts never print or inspect credentials.

`Enable WireGuard` and `Disable WireGuard` preserve the override configuration
and remind you to restart services before the network change takes effect.

`Create or edit draft` creates `runtime/wireguard/wg_confs/wg0.conf.new` from
the template and opens it in your editor. `Apply draft` validates it, saves the
current active profile as `wg0.conf.previous`, then atomically replaces
`wg0.conf`. Restart the WireGuard bridge and dependent services after applying
a new profile. The template already routes IPv4 through the tunnel and contains
the WireGuard kill switch.

## Weekly research

Use `DOGE Baseline`, `Settings`, then `Weekly research` to install or update the
systemd timer. Its settings are available in the same submenu.
Installation derives the current archive directory, so the package may be
unpacked anywhere under the user account.
The weekly run keeps collection active, pauses strategy and refresh while it
researches the regime profile, then waits for a successful refresh before
starting strategy again.
If it is interrupted, it uses the same refresh gate before it restores strategy.
