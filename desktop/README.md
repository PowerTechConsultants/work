# WorkTracker Desktop Trigger

Runs the whole app on localhost from one double-click, on the single stable port **42780**.

## Use it

Double-click **WorkTracker** on your Desktop or in the Start Menu. If MySQL is not running
the launcher starts the `MYSQL80` service when permitted, otherwise it waits up to 60
seconds and then tells you what to do.

The launcher:
1. verifies MySQL on `127.0.0.1:3306`,
2. starts the API on **42780** serving the API **and** the built frontend (`web/dist`),
3. waits for `/ready` (database + migrations),
4. opens **http://localhost:42780**.

If the app is already running it just opens the browser (no duplicate instance).
Close the launcher window (or `Ctrl+C`) to stop, or use `STOP.bat`.

## Stopping the app

WorkTracker only stops when you stop it. Nothing else ends it — no OS watchdog, no
idle-killer, no auto-update:

| Action | Result |
|--------|--------|
| Close the launcher window | Graceful stop (server closes, DB pool released) |
| `Ctrl+C` in the launcher | Graceful stop |
| `STOP.bat` | Asks the server to shut down gracefully, then cleans up any leftovers |
| Sign out / shut down Windows | Normal Windows shutdown |

`STOP.bat` calls `POST /internal/stop` with the one-time token the launcher writes to
`%TEMP%\worktracker.token`, so the server can close in-flight work properly. It only falls
back to force-terminating the processes if the graceful path does not answer.

## Stability

| Feature | Behaviour |
|---------|-----------|
| **Crash recovery** | If the server dies, the launcher restarts it with backoff (2s → 30s, up to 5 attempts) and records the crash in `%TEMP%\wt-api.log`. After 5 failures it stops retrying and shows a status page instead of looping. |
| **Hang detection** | If `/health` fails 6 times in a row (~3 min) while the process is alive, the server is treated as hung and replaced. |
| **Server log** | Everything the server prints is mirrored to `%TEMP%\wt-api.log` (append), so crashes stay visible after the window closes. |
| **Daily backup** | On the first start of each day the launcher runs `npm run backup` (rotation keeps the newest 7 in `server/backup/`). |
| **Sleep / hibernate** | Pooled connections are pinged every 5 minutes and a dropped connection is retried once automatically, so the first request after waking works. |
| **Single instance** | A second launch only opens the browser; it never touches the running instance. |
| **Database down** | The launcher waits up to 60s for MySQL (covers boot races) and then shows a status page with the fix command, instead of a connection error. |

Tuning knobs (environment variables): `WT_MAX_RESTARTS`, `WT_BACKOFF_MS`,
`WT_WATCHDOG_MS`, `WT_WATCHDOG_FAILS`, `WT_DAILY_BACKUP`.

## Share a temporary link

```bash
WorkTracker.cmd --tunnel          # or: node desktop/launcher.cjs --tunnel
```

The app is stopped first, then a Cloudflare quick tunnel is started and the launcher
prints the public URL (for example `https://xxxx.trycloudflare.com`).

- The link is **public and unlisted** — anyone who has it can reach the login page.
- It disappears when you close the launcher window or run `STOP.bat` (the tunnel is
  stopped together with the app).
- `--tunnel` and `--dev` cannot be combined: dev mode has no single origin to expose.
- Run `STOP.bat` first if the app is already running, otherwise the launcher tells you
  to (it has to start the server to apply the tunnel settings).

While tunnelling, the launcher passes two extra settings to the server:

| Setting | Why |
|---------|-----|
| `TRUST_PROXY=1` | cloudflared sends `X-Forwarded-For`; without it every visitor would share one rate-limit bucket and audit logs would all show `127.0.0.1` |
| `APP_URL=<tunnel url>` | password-reset links reach the shared site instead of `localhost` |

`HOST` stays `127.0.0.1`, so nothing new is exposed on your LAN, and `CORS_ORIGIN` is
untouched — the app serves UI and API from one origin, so the browser makes same-origin
requests and CORS never applies. Nothing in `.env` is modified, so there is nothing to
revert afterwards.

If `cloudflared` is installed somewhere unusual, point the launcher at it with
`WT_CLOUDFLARED=C:\path\to\cloudflared.exe`.

## Live reload while editing

The normal URL serves the built frontend, so rebuild after UI changes:

```bash
npm run build -w web
```

For instant hot reload on the same URL, use dev mode — Vite keeps 42780 and proxies the
API to 42781:

```bash
node desktop/launcher.cjs --dev
# or
npm run dev
```

## Start automatically with Windows

`create-startup.ps1` creates the Desktop, Start Menu and Startup-folder shortcuts
(no admin needed):

```powershell
powershell -ExecutionPolicy Bypass -File desktop\create-startup.ps1
```

MySQL must also start with Windows (run once as Administrator):

```powershell
Set-Service -Name MYSQL80 -StartupType Automatic
```

## Files

| File | Purpose |
|------|---------|
| `WorkTracker.cmd` | Double-click entry (what the shortcuts point to) |
| `launcher.cjs` | Implementation: MySQL check, API startup, readiness polling |
| `launcher.js` | ESM wrapper so `node desktop/launcher.js` also works |
| `create-startup.ps1` | Creates the Desktop / Start Menu / Startup shortcuts |

## Manual alternatives

```bash
START.bat                 # batch version (API + built app on 42780)
node desktop/launcher.cjs # same, from a terminal
node desktop/launcher.cjs --dev
STOP.bat                  # stops the stack and frees port 42780
```

## Notes

- Requires Node.js 22+, MySQL 8 on `127.0.0.1:3306`, and `server/.env` configured.
- Optional env var: `WORKTRACKER_ROOT` overrides project-root detection.
- The app binds `127.0.0.1` only. Set `HOST=0.0.0.0` in `server/.env` to expose it on
  your LAN.
- A packaged `.exe` was removed earlier: `pkg` intercepts child processes and cannot
  start the ESM-based `tsx` / `vite` CLIs. The `.cmd` trigger runs the real project with
  the system Node instead.
- Tauri (`src-tauri/`) is an optional scaffold and needs Rust installed; the config is
  Tauri 2 schema. It is not required for day-to-day use.
