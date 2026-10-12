// WorkTracker localhost launcher (CommonJS so it can be run directly by Node and
// from the Windows Startup entry).
//
// Run mode (default):  Express serves the API and the built frontend on one port
//                      (42780) -> http://localhost:42780
// Dev mode (--dev):    Vite serves the app on 42780 with hot reload and proxies
//                      /api + /socket.io to the API on 42781.
//
// Exit codes: 0 = stack exited/stopped, 1 = startup failed (e.g. MySQL unavailable).
const { spawn, execFileSync } = require('node:child_process');
const { connect } = require('node:net');
const { existsSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync, unlinkSync } = require('node:fs');
const { resolve, dirname, join } = require('node:path');
const { randomBytes } = require('node:crypto');
const { exec } = require('node:child_process');
const os = require('node:os');

const scriptDir = dirname(__filename);
// When packaged by pkg, __dirname points inside the virtual snapshot; derive the
// real project root from the .exe location instead.
const baseDir = process.pkg ? dirname(process.execPath) : scriptDir;
const root = process.env.WORKTRACKER_ROOT
  ? resolve(process.env.WORKTRACKER_ROOT)
  : resolve(baseDir, '..');

const APP_PORT = Number(process.env.WEB_PORT || 42780);
const DEV_API_PORT = Number(process.env.VITE_API_PORT || 42781);
const MYSQL_PORT = Number(process.env.WORKTRACKER_MYSQL_PORT || 3306);
const IS_DEV = process.argv.includes('--dev');
// --tunnel exposes the app through a temporary Cloudflare quick tunnel. The URL is
// public and unlisted: anyone holding it can reach the login page.
const IS_TUNNEL = process.argv.includes('--tunnel');
const APP_URL = `http://localhost:${APP_PORT}`;

// Stability knobs (env-overridable so they can be tested).
const MAX_RESTARTS = Number(process.env.WT_MAX_RESTARTS || 5);
const BACKOFF_MS = (Number(process.env.WT_BACKOFF_MS || 2000));
const WATCHDOG_INTERVAL_MS = Number(process.env.WT_WATCHDOG_MS || 30000);
const WATCHDOG_FAILS = Number(process.env.WT_WATCHDOG_FAILS || 6);
const MYSQL_WAIT_SECONDS = Number(process.env.WT_MYSQL_WAIT_SECONDS || 60);
const DAILY_BACKUP = process.env.WT_DAILY_BACKUP !== 'false';

const LOG_FILE = join(os.tmpdir(), 'wt-api.log');
const PID_FILE = join(os.tmpdir(), 'worktracker.pid');
const TOKEN_FILE = join(os.tmpdir(), 'worktracker.token');

function log(m) { console.log(`[WorkTracker] ${m}`); }

// Appends to the persistent log so crashes are still visible after the window closes.
function logFile(m) {
  const line = `[${new Date().toISOString()}] ${m}\n`;
  try { appendFileSync(LOG_FILE, line); } catch {}
  return m;
}

function firstExisting(paths, label) {
  const found = paths.find((p) => existsSync(p));
  if (!found) {
    log(`Cannot find ${label}. Run "npm install" in ${root} first.`);
    process.exit(1);
  }
  return found;
}

const TSX_CLI = firstExisting([
  join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
  join(root, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
], 'tsx');
const VITE_CLI = firstExisting([
  join(root, 'web', 'node_modules', 'vite', 'bin', 'vite.js'),
  join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
], 'vite');

// Inside a pkg bundle process.execPath is the executable itself, so the Node
// runtime on PATH is used (Node is required by this project anyway).
const NODE_CMD = process.pkg ? 'node' : process.execPath;

// Starts a child and mirrors its output to the console and the persistent log file.
function run(script, args, opts) {
  const options = Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts);
  const p = spawn(NODE_CMD, [script].concat(args), options);
  const tee = (stream) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => { try { appendFileSync(LOG_FILE, chunk); } catch {} });
    if (options.inheritOutput) stream.pipe(process.stdout);
  };
  if (p.stdout) tee(p.stdout);
  if (p.stderr) tee(p.stderr);
  p.on('error', (e) => log(`failed to start ${NODE_CMD}: ${e.message}`));
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function probePort(port, timeout) {
  const limit = timeout || 1500;
  return new Promise((resolvePort) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok) => { socket.destroy(); resolvePort(ok); };
    socket.setTimeout(limit, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function getJson(url, timeout) {
  const limit = timeout || 2500;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(limit) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return { status: 0, body: {} };
  }
}

async function openBrowser(url) {
  try {
    const open = require('open');
    const fn = typeof open === 'function' ? open : open && open.default;
    if (typeof fn === 'function') { await fn(url); return true; }
  } catch {}
  return false;
}

// Instead of leaving the user with ERR_CONNECTION_REFUSED, show a status page that
// explains what is wrong and reloads into the app automatically once it is ready.
function openStatusPage(title, detail, hint) {
  const file = join(os.tmpdir(), 'worktracker-status.html');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WorkTracker — ${title}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #0a0a0f; color: #e5e7eb;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { max-width: 620px; padding: 40px; background: #14141c; border: 1px solid #262633; border-radius: 14px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .sub { color: #9ca3af; font-size: 14px; margin-bottom: 22px; }
  pre { background: #0d0d13; border: 1px solid #262633; border-radius: 8px; padding: 14px;
        color: #a7f3d0; font-size: 13px; overflow-x: auto; }
  .dots { color: #9ca3af; font-size: 13px; margin-top: 20px; }
  .dot { animation: blink 1.2s infinite; }
  @keyframes blink { 0%,100% { opacity: .25 } 50% { opacity: 1 } }
</style>
</head>
<body>
  <div class="card">
    <h1>WorkTracker — ${title}</h1>
    <div class="sub">${detail}</div>
    ${hint ? `<pre>${hint}</pre>` : ''}
    <div class="dots">Waiting for http://localhost:${APP_PORT} <span class="dot">...</span></div>
  </div>
<script>
  // Reload into the app as soon as it answers on the app port.
  setInterval(async () => {
    try {
      const res = await fetch('http://localhost:${APP_PORT}/ready', { cache: 'no-store' });
      if (res.ok) location.replace('http://localhost:${APP_PORT}');
    } catch {}
  }, 2000);
</script>
</body>
</html>`;
  try { writeFileSync(file, html); } catch {}
  openBrowser('file:///' + file.replace(/\\/g, '/'));
  log('Opened a status page in the browser instead of a connection error.');
}

function newestMtime(dir, depth) {
  const level = depth || 2;
  let newest = 0;
  const walk = (current, remaining) => {
    let entries = [];
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (remaining > 0 && entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(full, remaining - 1);
      } else {
        try { newest = Math.max(newest, statSync(full).mtimeMs); } catch {}
      }
    }
  };
  walk(dir, level);
  return newest;
}

// Warn when the built frontend is older than the sources (run mode serves web/dist).
function checkWebBuild() {
  const distIndex = join(root, 'web', 'dist', 'index.html');
  if (!existsSync(distIndex)) {
    log('No frontend build found — building now (first run only, please wait) ...');
    try {
      execFileSync(process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', 'npm run build -w web'],
        { cwd: root, stdio: 'inherit' });
    } catch {
      log('Frontend build failed — run "npm run build -w web" manually.');
    }
    return;
  }
  const built = statSync(distIndex).mtimeMs;
  const source = Math.max(newestMtime(join(root, 'web', 'src')), newestMtime(join(root, 'web', 'index.html')));
  if (source > built) {
    log('NOTE: web/src changed since the last build. Run "npm run build -w web" to see your changes on ' + APP_URL);
  }
}

async function ensureMysql() {
  if (await probePort(MYSQL_PORT)) {
    if (MYSQL_PORT !== 3306) log(`MySQL is running on 127.0.0.1:${MYSQL_PORT}`);
    return true;
  }
  log(`MySQL is not running on port ${MYSQL_PORT} - trying to start the MYSQL80 service ...`);
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Service MYSQL80 -ErrorAction Stop'], { stdio: 'ignore' });
  } catch {}

  // Windows may still be starting services at login: wait patiently before failing.
  for (let i = 0; i < MYSQL_WAIT_SECONDS; i++) {
    if (await probePort(MYSQL_PORT)) { log('MySQL80 service started'); return true; }
    if (i > 0 && i % 15 === 0) log(`still waiting for MySQL... (${i}s)`);
    await sleep(1000);
  }
  log(`START FAILED: MySQL is not running on 127.0.0.1:${MYSQL_PORT}`);
  log('');
  log('Start it once, as Administrator, in a terminal:   net start MYSQL80');
  log('or open services.msc and start "MySQL80".');
  log('Then start WorkTracker again.');
  openStatusPage(
    'MySQL is not running',
    'The database service (MySQL80) must be running before WorkTracker can start.',
    'net start MySQL80',
  );
  return false;
}

// If the app is already serving, just open it (avoids EADDRINUSE from the
// Startup entry racing a manual double-click).
async function alreadyRunning() {
  const ready = await getJson(`${APP_URL}/ready`, 1500);
  if (ready.status === 200) return true;
  const health = await getJson(`${APP_URL}/health`, 1500);
  return health.status === 200;
}

// ---------------------------------------------------------------------------
// Supervisor: restarts the API if it crashes, detects hangs, never restarts
// after a deliberate stop (window close / Ctrl+C / STOP.bat).
// ---------------------------------------------------------------------------
const state = {
  stopping: false,
  api: null,
  restarts: 0,
  hung: false,
  stopToken: randomBytes(24).toString('hex'),
  tunnel: null,
  tunnelUrl: null,
  tunnelRestarts: 0,
};

// Resolves cloudflared: explicit override, then the standard install locations.
function resolveCloudflared() {
  const override = process.env.WT_CLOUDFLARED;
  if (override) {
    if (!existsSync(override)) {
      log(logFile(`cloudflared not found at WT_CLOUDFLARED=${override}`));
      return null;
    }
    return override;
  }
  const candidates = [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// Starts a Cloudflare quick tunnel to the app port and resolves the public URL.
// Runs BEFORE the API so APP_URL can point at the tunnel (password-reset links).
function startTunnel() {
  const exe = resolveCloudflared();
  if (!exe) {
    log('cloudflared was not found. Install it from https://developers.cloudflare.com/cloudflare-one/');
    log('or set WT_CLOUDFLARED to the full path of cloudflared.exe.');
    return null;
  }

  const child = spawn(exe, ['tunnel', '--url', APP_URL, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const scan = (chunk) => {
    if (state.tunnelUrl) return;
    const match = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!match) return;
    state.tunnelUrl = match[0];
    log(logFile(`Tunnel URL: ${state.tunnelUrl}`));
    log(`Share link:  ${state.tunnelUrl}`);
    log('This link is PUBLIC and unlisted - anyone with it can reach the login page.');
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', scan);
  child.stderr?.on('data', scan);

  child.on('error', (e) => log(`cloudflared failed to start: ${e.message}`));
  child.on('exit', (code) => {
    if (state.stopping) return;
    state.tunnel = null;
    state.tunnelRestarts += 1;
    if (state.tunnelRestarts > 2) {
      log(logFile(`Tunnel exited (code ${code}) and could not be restarted - the share link is gone.`));
      openStatusPage('The share link went down',
        'cloudflared stopped and could not be restarted automatically.',
        'Close this window and start WorkTracker again with --tunnel.');
      return;
    }
    log(logFile(`Tunnel exited (code ${code}) - restarting (${state.tunnelRestarts}/2)`));
    setTimeout(() => { if (!state.stopping) state.tunnel = startTunnel(); }, 3000);
  });

  state.tunnel = child;
  return child;
}

async function waitForTunnelUrl(timeoutSeconds) {
  for (let i = 0; i < timeoutSeconds; i++) {
    if (state.tunnelUrl) return state.tunnelUrl;
    if (!state.tunnel) return null;            // start failed
    await sleep(1000);
  }
  return null;
}

function apiEnv() {
  const env = Object.assign({}, process.env, {
    PORT: String(APP_PORT),
    SERVE_STATIC: 'true',
    STOP_TOKEN: state.stopToken,
  });
  if (state.tunnelUrl) {
    // cloudflared sets X-Forwarded-For. Without TRUST_PROXY every visitor sharing the
    // link would collapse into one 127.0.0.1 rate-limit bucket and audit-log entry.
    env.TRUST_PROXY = '1';
    // Password-reset links must reach the shared site, not this machine.
    env.APP_URL = state.tunnelUrl;
  }
  return env;
}

function startApi() {
  state.hung = false;
  const child = run(TSX_CLI, ['src/server.ts'], { cwd: join(root, 'server'), env: apiEnv(), inheritOutput: true });
  state.api = child;

  child.on('exit', (code, signal) => {
    state.api = null;
    if (state.stopping) return;                    // deliberate stop — never restart
    if (code === 0) { logFile('API exited cleanly (code 0) — not restarting.'); return; }
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    state.restarts += 1;
    const delay = Math.min(BACKOFF_MS * 2 ** (state.restarts - 1), 30000);
    log(logFile(`API stopped unexpectedly (${reason}) — restart ${state.restarts}/${MAX_RESTARTS} in ${delay / 1000}s`));
    if (state.restarts > MAX_RESTARTS) {
      log(logFile(`API keeps failing — giving up. Last output is in ${LOG_FILE}`));
      openStatusPage('The server keeps crashing',
        `WorkTracker restarted the server ${MAX_RESTARTS} times without success.`,
        LOG_FILE);
      return;
    }
    setTimeout(() => { if (!state.stopping) startApi(); }, delay);
  });
  return child;
}

// A process that is alive but not answering is a hang, not a crash — replace it.
function startWatchdog() {
  let fails = 0;
  setInterval(async () => {
    if (state.stopping || !state.api || state.hung) return;
    const health = await getJson(`${APP_URL}/health`, 4000);
    if (health.status === 200) { fails = 0; return; }
    fails += 1;
    if (fails < WATCHDOG_FAILS) return;
    state.hung = true;
    log(logFile(`No health response ${fails}x in a row — treating the server as hung and restarting it`));
    const dead = state.api;
    state.api = null;
    state.restarts = 0;
    killTree(dead);
  }, WATCHDOG_INTERVAL_MS).unref?.();
}

// Take one database backup per day; backup.ts already rotates to the newest 7 files.
function maybeDailyBackup() {
  if (!DAILY_BACKUP) return;
  const backupDir = join(root, 'server', 'backup');
  const today = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD, matches backup.ts
  let hasToday = false;
  try {
    hasToday = readdirSync(backupDir).some((f) => f.startsWith(`employee-tracker-${today}`) && statSync(join(backupDir, f)).size > 0);
  } catch {}
  if (hasToday) return;
  log('Taking the daily database backup ...');
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run backup'], {
    cwd: root, stdio: 'ignore', windowsHide: true,
  });
  child.on('exit', (code) => {
    if (code === 0) logFile('Daily backup completed');
    else logFile(`Daily backup failed (code ${code}) — run "npm run backup" to check`);
  });
}

async function main() {
  log('Project root: ' + root);

  if (IS_DEV && IS_TUNNEL) {
    log('--dev and --tunnel cannot be combined: dev mode has no single origin to expose.');
    log('Run either "node desktop/launcher.cjs --tunnel" or "node desktop/launcher.cjs --dev".');
    process.exitCode = 1;
    return;
  }

  if (await alreadyRunning()) {
    if (IS_TUNNEL) {
      // Starting the API with TRUST_PROXY/APP_URL for the link is impossible while an
      // instance is already up, so say so instead of half-applying the settings.
      log('WorkTracker is already running on ' + APP_URL + '.');
      log('Stop it first, then start with --tunnel:   STOP.bat   then   WorkTracker.cmd --tunnel');
      process.exitCode = 1;
      return;
    }
    log('WorkTracker is already running on ' + APP_URL + ' - opening it.');
    await openBrowser(APP_URL);
    return;
  }

  if (!(await ensureMysql())) {
    process.exitCode = 1;
    return;
  }

  if (IS_DEV) {
    log(`Dev mode: Vite on ${APP_PORT} (live reload) + API on ${DEV_API_PORT}`);
    const api = run(TSX_CLI, ['watch', 'src/server.ts'], {
      cwd: join(root, 'server'),
      env: Object.assign({}, process.env, { PORT: String(DEV_API_PORT), API_PORT: String(DEV_API_PORT), SERVE_STATIC: 'false' }),
    });
    const web = run(VITE_CLI, [], { cwd: join(root, 'web'), env: Object.assign({}, process.env, { WEB_PORT: String(APP_PORT), VITE_API_PORT: String(DEV_API_PORT) }) });
    await waitForLoop(async () => (await probePort(APP_PORT)) && (await getJson(`http://localhost:${DEV_API_PORT}/health`)).status === 200);
    await openBrowser(APP_URL);
    log(`App: ${APP_URL} (edits in web/src or server/src apply instantly)`);
    log('Close this window (or press Ctrl+C) to stop the stack.');
    wireCleanup([api, web]);
    return;
  }

  checkWebBuild();
  try { appendFileSync(LOG_FILE, `\n===== WorkTracker start ${new Date().toISOString()} =====\n`); } catch {}
  logFile(`Starting WorkTracker on ${APP_PORT} (log: ${LOG_FILE})`);
  writeFileSync(TOKEN_FILE, state.stopToken);
  writeFileSync(PID_FILE, String(process.pid));

  // Tunnel first: the API needs the public URL for APP_URL (password-reset links).
  if (IS_TUNNEL) {
    log('Starting a temporary Cloudflare tunnel ...');
    startTunnel();
    const url = await waitForTunnelUrl(30);
    if (!url) {
      log('The tunnel did not produce a URL - check your internet connection.');
      killTree(state.tunnel);
      for (const f of [PID_FILE, TOKEN_FILE]) { try { unlinkSync(f); } catch {} }
      process.exitCode = 1;
      return;
    }
  }

  const api = startApi();
  startWatchdog();

  const ok = await waitForLoop(async () => (await getJson(`${APP_URL}/ready`)).status === 200, 90);
  if (!ok) {
    const health = await getJson(`${APP_URL}/health`);
    if (health.status === 200) {
      log('API is up but the database is not ready - check the MySQL credentials in server/.env');
      openStatusPage('Database not ready',
        'The API started, but MySQL rejected the credentials in server/.env.',
        'DATABASE_URL=mysql://root:YOUR_PASSWORD@localhost:3306/hr');
    } else {
      log(`The app did not start in time. Check that port ${APP_PORT} is free.`);
      openStatusPage('The app could not start',
        `Nothing is answering on port ${APP_PORT}. Check the log at %TEMP%\\wt-api.log and make sure the port is free.`);
      return;
    }
  }
  await openBrowser(state.tunnelUrl || APP_URL);
  maybeDailyBackup();
  log('');
  log(`App: ${state.tunnelUrl || APP_URL}`);
  log(`Local: ${APP_URL}`);
  log(`API: ${APP_URL}/health   Ready: ${APP_URL}/ready   Docs: ${APP_URL}/api-docs`);
  if (state.tunnelUrl) {
    log(`Share link: ${state.tunnelUrl}  (public, unlisted - close this window to revoke it)`);
  }
  log(`Server log: ${LOG_FILE}   (crashes are recorded there and restarted automatically)`);
  log('To show frontend changes on this port run: npm run build -w web');
  log('For live reload while editing use: node desktop/launcher.cjs --dev');
  log('Close this window (or press Ctrl+C) to stop the stack.');
  wireRunMode(api);
}

async function waitForLoop(check, attempts) {
  const total = attempts || 60;
  for (let i = 0; i < total; i++) {
    if (await check()) return true;
    await sleep(1000);
  }
  return false;
}

// tsx/vite run child processes, so kill the whole tree (Windows) instead of
// leaving the real server holding the port.
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      return;
    }
  } catch {}
  try { child.kill(); } catch {}
}

function wireCleanup(children) {
  const cleanup = () => {
    for (const child of children) killTree(child);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  children[0].on('exit', () => { for (const child of children.slice(1)) killTree(child); process.exit(0); });
}

// Run mode: a deliberate stop must not be treated as a crash, so mark the state first
// and only then tear the server down. Restart logic stays in the supervisor.
function wireRunMode(api) {
  let cleaning = false;
  // The tunnel has to die with the launcher, otherwise the public link would keep
  // serving (or 502-ing) after the app is gone.
  const killAll = () => {
    killTree(state.tunnel);
    killTree(state.api || api);
  };
  const stop = (reason) => {
    if (cleaning) return;
    cleaning = true;
    state.stopping = true;
    logFile(`Stopping (${reason})`);
    killAll();
    for (const f of [PID_FILE, TOKEN_FILE]) { try { unlinkSync(f); } catch {} }
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGHUP', () => stop('window closed'));
  // If the launcher itself is killed, take the server and the tunnel down with it.
  process.on('exit', () => { if (!state.stopping) killAll(); });
  // A clean API exit (e.g. STOP.bat asked it to stop) also ends the launcher;
  // a crash (non-zero) must not, because the supervisor restarts it.
  api && api.on('exit', (code) => { if (!state.stopping && code === 0) stop('server stopped'); });
}

main().catch((e) => {
  log('Fatal: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
