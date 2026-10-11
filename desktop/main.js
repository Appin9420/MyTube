/**
 * MyTube desktop shell (Electron main process).
 *
 * Architecture: the existing Express backend keeps running as a plain Node.js
 * child process (bundled node.exe in packaged builds), serving both the API and
 * the built frontend. This shell only:
 *   1. prepares a writable "server home" directory (cwd of the backend) where
 *      data/, uploads/, drizzle migrations etc. live, mirroring the Docker
 *      layout (see backend/src/config/paths.ts: ROOT_DIR = process.cwd());
 *   2. spawns the backend and waits for its TCP port;
 *   3. opens a BrowserWindow pointing at the local server.
 *
 * Modes:
 *   - packaged:  app.isPackaged -> resources/server (backend) + resources/bin (node.exe, yt-dlp, ffmpeg)
 *   - staging:   not packaged, but desktop/build/staging exists (fast local test of the
 *                packaged layout without a full installer build); pass --dev to bypass.
 *   - dev:       otherwise; expects `npm run dev` (backend 5551 + vite 5556) to be
 *                already running (`npm run desktop:dev` from the repo root).
 */

const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
} = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");

const lockStore = require("./lockStore.cjs");

const DEFAULT_PORT = 5551;
const DEV_VITE_PORT = 5556;
const BACKEND_START_TIMEOUT_MS = 90_000;

const ROOT_DIR = path.resolve(__dirname, "..");
const STAGING_DIR = path.join(__dirname, "build", "staging");

const isDevMode =
  process.argv.includes("--dev") || process.env.MYTUBE_FORCE_DEV === "1";

// ---------------------------------------------------------------------------
// Resource resolution
// ---------------------------------------------------------------------------

function resolveResources() {
  if (app.isPackaged) {
    return {
      mode: "packaged",
      appRoot: path.join(process.resourcesPath, "server"),
      binDir: path.join(process.resourcesPath, "bin"),
      backendEntry: path.join(
        process.resourcesPath,
        "server",
        "dist",
        "src",
        "server.js"
      ),
    };
  }

  const stagingRoot = process.env.MYTUBE_STAGING_DIR
    ? path.resolve(process.env.MYTUBE_STAGING_DIR)
    : STAGING_DIR;
  const stagingBackendEntry = path.join(
    stagingRoot,
    "app",
    "dist",
    "src",
    "server.js"
  );
  if (!isDevMode && fs.existsSync(stagingBackendEntry)) {
    return {
      mode: "staging",
      appRoot: path.join(stagingRoot, "app"),
      binDir: path.join(stagingRoot, "bin"),
      backendEntry: stagingBackendEntry,
    };
  }

  return { mode: "dev" };
}

// ---------------------------------------------------------------------------
// Server home directory (backend cwd)
// ---------------------------------------------------------------------------

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyDirSync(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Copy cwd-relative code resources (drizzle migrations, bgutil provider) from
 * the packaged app into the writable server home. A version marker file makes
 * the copy refresh whenever the app version changes, while user data
 * (data/, uploads/) is never touched.
 */
function syncCodeResourceIntoHome(appRoot, homeDir, resourceDirName, version) {
  const src = path.join(appRoot, resourceDirName);
  if (!fs.existsSync(src)) {
    return false;
  }
  const dest = path.join(homeDir, resourceDirName);
  const markerPath = path.join(dest, ".desktop-synced-version");
  const marker = `${resourceDirName}:${version}`;
  if (fs.existsSync(markerPath)) {
    try {
      if (fs.readFileSync(markerPath, "utf8").trim() === marker) {
        return false; // already current
      }
    } catch {
      // fall through to re-sync
    }
  }
  copyDirSync(src, dest);
  fs.writeFileSync(markerPath, `${marker}\n`, "utf8");
  return true;
}

function prepareServerHome(appRoot, homeDir, version) {
  ensureDir(homeDir);
  ensureDir(path.join(homeDir, "data"));
  ensureDir(path.join(homeDir, "temp_metadata"));
  for (const uploadDir of [
    "uploads",
    "uploads/videos",
    "uploads/images",
    "uploads/images-small",
    "uploads/subtitles",
    "uploads/avatars",
    "uploads/cloud-thumbnail-cache",
  ]) {
    ensureDir(path.join(homeDir, uploadDir));
  }
  syncCodeResourceIntoHome(appRoot, homeDir, "drizzle", version);
  syncCodeResourceIntoHome(
    appRoot,
    homeDir,
    "bgutil-ytdlp-pot-provider",
    version
  );
}

function loadOrCreateJwtSecret(homeDir) {
  const secretPath = path.join(homeDir, ".jwt-secret");
  try {
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (existing.length >= 32) {
      return existing;
    }
  } catch {
    // first run
  }
  const secret = crypto.randomBytes(48).toString("hex");
  fs.writeFileSync(secretPath, secret, "utf8");
  return secret;
}

// ---------------------------------------------------------------------------
// Port selection & readiness probing
// ---------------------------------------------------------------------------

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, "127.0.0.1");
  });
}

async function pickBackendPort() {
  if (await isPortFree(DEFAULT_PORT)) {
    return DEFAULT_PORT;
  }
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.once("listening", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
    probe.listen(0, "127.0.0.1");
  });
}

function waitForPort(port, timeoutMs, onRetry) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(
            new Error(
              `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for MyTube backend on port ${port}`
            )
          );
          return;
        }
        if (onRetry) {
          onRetry(Date.now() - startedAt);
        }
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

// ---------------------------------------------------------------------------
// Backend process management (packaged / staging modes)
// ---------------------------------------------------------------------------

let backendProcess = null;
let isQuitting = false;

function findPuppeteerExecutable() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function buildBackendEnv(homeDir, binDir) {
  const env = { ...process.env };
  // Strip Electron-specific variables so they cannot leak into the Node child.
  for (const key of Object.keys(env)) {
    if (key.startsWith("ELECTRON_")) {
      delete env[key];
    }
  }
  env.NODE_ENV = "production";
  env.MYTUBE_ADMIN_TRUST_LEVEL = env.MYTUBE_ADMIN_TRUST_LEVEL || "application";
  env.JWT_SECRET = loadOrCreateJwtSecret(homeDir);

  // Bundle-located helpers first on PATH so yt-dlp/ffmpeg/cloudflared resolve
  // to the shipped versions (backend/src/utils/ytdlp/pathResolver.ts scans PATH).
  if (binDir && fs.existsSync(binDir)) {
    env.PATH = `${binDir}${path.delimiter}${env.PATH || ""}`;
    const bundledYtDlp = path.join(binDir, "yt-dlp.exe");
    if (fs.existsSync(bundledYtDlp)) {
      env.YT_DLP_PATH = bundledYtDlp;
    }
    // yt-dlp needs a JS runtime for YouTube challenge solving; prefer bundled
    // deno, fall back to the bundled node.exe (it is on PATH via binDir).
    env.YT_DLP_JS_RUNTIME = fs.existsSync(path.join(binDir, "deno.exe"))
      ? "deno"
      : "node";
  }

  const chromeLike = findPuppeteerExecutable();
  if (chromeLike) {
    env.PUPPETEER_EXECUTABLE_PATH = env.PUPPETEER_EXECUTABLE_PATH || chromeLike;
  }
  return env;
}

function readLogTail(logFilePath, lines = 20) {
  try {
    return fs
      .readFileSync(logFilePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-lines)
      .join("\n");
  } catch {
    return "";
  }
}

/**
 * Auto-repair missing covers on startup: runs the idempotent backfill script
 * (download stored thumbnail_url, ffmpeg frame fallback) with the bundled
 * node.exe; logs the outcome to desktop.log. Fire-and-forget - it must never
 * delay or block startup.
 */
function runThumbnailBackfill(homeDir, resources, nodeExe) {
  try {
    const scriptPath = app.isPackaged
      ? path.join(process.resourcesPath, "scripts", "backfill-thumbnails.cjs")
      : path.join(__dirname, "scripts", "backfill-thumbnails.cjs");
    if (!fs.existsSync(scriptPath)) {
      return;
    }
    const { spawn } = require("child_process");
    const childArgs = [scriptPath, "--home", homeDir];
    if (resources.mode === "packaged") {
      childArgs.push(
        "--sqlite", path.join(resources.appRoot, "node_modules", "better-sqlite3"),
        "--ffmpeg", path.join(resources.binDir, "ffmpeg.exe")
      );
    }
    const child = spawn(nodeExe, childArgs, { windowsHide: true, stdio: "ignore" });
    child.on("exit", (code) => appendDesktopLog(`thumbnail backfill: exit ${code}`));
    child.on("error", (error) =>
      appendDesktopLog(`thumbnail backfill: failed to start: ${error.message}`)
    );
  } catch (error) {
    appendDesktopLog(`thumbnail backfill: skipped (${error.message})`);
  }
}

function killBackendTree() {
  if (!backendProcess || backendProcess.killed || backendProcess.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    // taskkill /T takes down yt-dlp/ffmpeg grandchildren as well.
    const { spawn } = require("child_process");
    spawn("taskkill", ["/pid", String(backendProcess.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    backendProcess.kill("SIGTERM");
  }
}

function resolveNodeExecutable(resources) {
  const bundledNode = path.join(resources.binDir, "node.exe");
  return resources.mode === "packaged" || fs.existsSync(bundledNode)
    ? bundledNode
    : "node"; // staging fallback when bin/node.exe was not staged
}

function spawnBackend(resources, homeDir, port) {
  const { spawn } = require("child_process");
  const resolvedNode = resolveNodeExecutable(resources);

  backendProcess = spawn(resolvedNode, [resources.backendEntry], {
    cwd: homeDir,
    env: buildBackendEnv(homeDir, resources.binDir),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const logFilePath = path.join(homeDir, "backend.log");
  const logStream = fs.createWriteStream(logFilePath, { flags: "a" });
  logStream.write(`\n--- launch ${new Date().toISOString()} (port ${port}) ---\n`);
  backendProcess.stdout.pipe(logStream, { end: false });
  backendProcess.stderr.pipe(logStream, { end: false });

  backendProcess.once("exit", (code, signal) => {
    logStream.end();
    backendProcess = null;
    if (!isQuitting && BrowserWindow.getAllWindows().length > 0) {
      dialog.showErrorBox(
        "MyTube 后端已退出",
        `后端进程意外退出(code: ${code ?? signal})。\n日志: ${logFilePath}\n\n${readLogTail(logFilePath, 15)}`
      );
      app.quit();
    }
  });
}

// ---------------------------------------------------------------------------
// Startup lock (optional password gate before the app UI)
// ---------------------------------------------------------------------------

let pendingLockResolve = null;
let failedUnlockAttempts = 0;
let lockoutUntil = 0;
// True while the lock gate owns the only window; window-all-closed must not
// tear the app down during the destroy-lock-then-create-main transition.
let lockGateActive = false;

function registerLockIpc() {
  ipcMain.handle("lock:unlock", (_event, password) => {
    const now = Date.now();
    if (now < lockoutUntil) {
      return { ok: false, lockoutMs: lockoutUntil - now };
    }
    const record = lockStore.readRecord(LOCK_FILE_PATH);
    if (lockStore.verifyPassword(record, password)) {
      failedUnlockAttempts = 0;
      appendDesktopLog("lock: unlock succeeded");
      const resolve = pendingLockResolve;
      pendingLockResolve = null;
      if (resolve) {
        resolve({ action: "unlock" });
      }
      return { ok: true };
    }
    failedUnlockAttempts += 1;
    appendDesktopLog(`lock: unlock failed (attempt ${failedUnlockAttempts})`);
    if (failedUnlockAttempts >= UNLOCK_MAX_ATTEMPTS) {
      lockoutUntil = Date.now() + UNLOCK_LOCKOUT_MS;
      return { ok: false, lockoutMs: UNLOCK_LOCKOUT_MS };
    }
    return { ok: false, lockoutMs: 0 };
  });

  ipcMain.handle("lock:setup", (_event, password) => {
    try {
      const record = lockStore.createRecord(password);
      lockStore.writeRecord(LOCK_FILE_PATH, record);
      appendDesktopLog("lock: startup password set");
      const resolve = pendingLockResolve;
      pendingLockResolve = null;
      if (resolve) {
        resolve({ action: "unlock" });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle("lock:skip", () => {
    appendDesktopLog("lock: skipped (no startup password set)");
    const resolve = pendingLockResolve;
    pendingLockResolve = null;
    if (resolve) {
      resolve({ action: "skip" });
    }
    return { ok: true };
  });
}

function lockPageHtml(isSetup) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  html, body { height: 100%; margin: 0; background: #0f1115; color: #e6e6e6;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    display: flex; align-items: center; justify-content: center; }
  .card { width: 320px; background: #171a21; border: 1px solid #2a2f3a;
    border-radius: 12px; padding: 28px 26px; }
  h1 { font-size: 19px; font-weight: 600; margin: 0 0 6px; text-align: center; }
  .sub { font-size: 12.5px; color: #9aa0a6; text-align: center; margin: 0 0 18px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; margin-bottom: 12px;
    background: #0f1115; border: 1px solid #2a2f3a; border-radius: 8px;
    color: #e6e6e6; font-size: 14px; outline: none; }
  input:focus { border-color: #4f9cf9; }
  button { width: 100%; padding: 10px 12px; border: none; border-radius: 8px;
    font-size: 14px; cursor: pointer; margin-bottom: 10px;
    background: #4f9cf9; color: #fff; font-weight: 600; }
  button:disabled { opacity: .55; cursor: default; }
  #skip { background: transparent; color: #9aa0a6; border: 1px solid #2a2f3a; font-weight: 400; }
  #error { min-height: 18px; font-size: 12.5px; color: #ff6b6b; margin: 0 0 8px; text-align: center; }
</style>
</head>
<body>
  <div class="card">
    <h1>MyTube</h1>
    <p class="sub" id="subtitle"></p>
    <form id="form">
      <input id="pw1" type="password" placeholder="输入密码" autofocus autocomplete="off" />
      <input id="pw2" type="password" placeholder="再输入一遍" style="display:none" autocomplete="off" />
      <div id="error"></div>
      <button id="primary" type="submit">解锁</button>
      <button id="skip" type="button" style="display:none">暂不设置，直接进入</button>
    </form>
  </div>
  <script>
    const isSetup = ${isSetup ? "true" : "false"};
    const title = document.getElementById('title');
    const subtitle = document.getElementById('subtitle');
    const pw1 = document.getElementById('pw1');
    const pw2 = document.getElementById('pw2');
    const errorEl = document.getElementById('error');
    const primary = document.getElementById('primary');
    const skip = document.getElementById('skip');
    let countdown = null;

    if (isSetup) {
      subtitle.textContent = '首次设置：为桌面版设置一个启动密码';
      pw2.style.display = 'block';
      primary.textContent = '设置并进入';
      skip.style.display = 'block';
    } else {
      subtitle.textContent = '请输入启动密码解锁';
    }

    function showError(text) { errorEl.textContent = text; }
    function startCountdown(ms) {
      const end = Date.now() + ms;
      primary.disabled = true;
      clearInterval(countdown);
      countdown = setInterval(() => {
        const left = Math.ceil((end - Date.now()) / 1000);
        if (left <= 0) { clearInterval(countdown); primary.disabled = false; errorEl.textContent = ''; }
        else { showError('尝试次数过多，' + left + ' 秒后再试'); }
      }, 250);
    }

    document.getElementById('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      errorEl.textContent = '';
      if (isSetup) {
        if (pw1.value !== pw2.value) { showError('两次输入的密码不一致'); return; }
        console.log('[lock] setup submit, pw length=' + pw1.value.length);
        primary.disabled = true;
        const res = await window.desktopLock.submitSetup(pw1.value);
        console.log('[lock] setup result: ' + JSON.stringify(res));
        if (res.ok) { primary.textContent = '已设置，进入…'; }
        else { primary.disabled = false; showError(res.error || '设置失败'); }
      } else {
        console.log('[lock] unlock submit, pw length=' + pw1.value.length);
        primary.disabled = true;
        const res = await window.desktopLock.submitUnlock(pw1.value);
        console.log('[lock] unlock result: ' + JSON.stringify(res));
        if (res.ok) { primary.textContent = '解锁中…'; }
        else if (res.lockoutMs > 0) { startCountdown(res.lockoutMs); }
        else { primary.disabled = false; showError('密码不正确'); pw1.select(); }
      }
    });

    skip.addEventListener('click', () => { window.desktopLock.skip(); });
  </script>
</body>
</html>`;
}

function showLockWindow(mode) {
  return new Promise((resolve) => {
    pendingLockResolve = resolve;
    const win = new BrowserWindow({
      width: 440,
      height: mode === "setup" ? 480 : 380,
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      title: "MyTube",
      backgroundColor: "#0f1115",
      webPreferences: {
        preload: path.join(__dirname, "preload-lock.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // A real file (not a data: URL) guarantees the preload/contextBridge runs.
    const lockPagePath = path.join(app.getPath("userData"), "lock-window.html");
    try {
      fs.writeFileSync(lockPagePath, lockPageHtml(mode === "setup"), "utf8");
    } catch (error) {
      appendDesktopLog(`lock: failed to write lock page: ${error.message}`);
    }
    win.webContents.on("console-message", (_event, _level, message) => {
      appendDesktopLog(`lock-window: ${message}`);
    });
    win.loadFile(lockPagePath);
    win.on("closed", () => {
      if (pendingLockResolve) {
        const resolve = pendingLockResolve;
        pendingLockResolve = null;
        resolve({ action: "quit" });
      }
    });
  });
}

/**
 * Show the lock gate and wait for unlock/setup/skip. Returns false when the
 * app should quit (lock window closed without resolving).
 */
async function runLockGate() {
  const hasRecord = Boolean(lockStore.readRecord(LOCK_FILE_PATH));
  appendDesktopLog(`lock gate: ${hasRecord ? "unlock required" : "no password set, setup screen"}`);
  lockGateActive = true;
  const result = await showLockWindow(hasRecord ? "unlock" : "setup");
  appendDesktopLog(`lock flow result: ${result.action}`);
  if (result.action === "quit") {
    lockGateActive = false;
    return false;
  }
  // Destroying the lock window leaves zero windows for a moment, which fires
  // window-all-closed; lockGateActive stays true until the caller has created
  // the main/loading window (see whenReady) so the app is not torn down.
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.destroy();
    } catch {
      /* already closing */
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

const LOADING_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  html, body { height: 100%; margin: 0; background: #0f1115; color: #e6e6e6;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    display: flex; align-items: center; justify-content: center; }
  .box { text-align: center; }
  .spinner { width: 42px; height: 42px; margin: 0 auto 18px;
    border: 4px solid rgba(255,255,255,.15); border-top-color: #4f9cf9;
    border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  p { font-size: 13px; color: #9aa0a6; margin: 0; }
</style>
</head>
<body>
  <div class="box">
    <div class="spinner"></div>
    <h1>MyTube 启动中</h1>
    <p id="status">正在启动本地服务…</p>
  </div>
</body>
</html>`;

function createLoadingWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: "#0f1115",
    title: "MyTube",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent(LOADING_PAGE_HTML)
  );
  return win;
}

function applyWindowGuards(win, appOrigin) {
  // Any link that wants a new window (target=_blank, window.open) opens in the
  // user's default browser instead of spawning an Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Keep the main window on the app origin; external navigations go to the browser.
  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(appOrigin)) {
      return;
    }
    event.preventDefault();
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// Electron derives the userData path from package.json "name" ("mytube-desktop");
// pin it to the product name so data lives in %APPDATA%/MyTube as documented.
app.setName("MyTube");
app.setPath("userData", path.join(app.getPath("appData"), "MyTube"));

const LOCK_FILE_PATH = path.join(app.getPath("userData"), "desktop-lock.json");
const DESKTOP_LOG_PATH = path.join(app.getPath("userData"), "desktop.log");
const UNLOCK_LOCKOUT_MS = 30_000;
const UNLOCK_MAX_ATTEMPTS = 5;

function appendDesktopLog(line) {
  try {
    fs.appendFileSync(DESKTOP_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* logging must never break startup */
  }
}

// ---------------------------------------------------------------------------
// Headless service task coexistence (scripts/headless-server.cmd, scheduled
// task "MyTubeHeadlessServer"): when that task serves the backend without the
// GUI, hand port ownership over on launch and hand it back on quit. Every
// schtasks call is a harmless no-op on machines without the task.
// ---------------------------------------------------------------------------
const HEADLESS_SERVICE_TASK =
  process.env.MYTUBE_HEADLESS_TASK || "MyTubeHeadlessServer";

function spawnSchtasks(action) {
  const { spawn } = require("child_process");
  try {
    spawn(
      "schtasks",
      [`/${action}`, "/tn", HEADLESS_SERVICE_TASK],
      { detached: true, stdio: "ignore", windowsHide: true }
    ).unref();
  } catch {
    /* task not configured on this machine */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Stop the headless service and wait until it releases the backend port so
// our own backend can bind it.
async function yieldPortToDesktop() {
  if (!HEADLESS_SERVICE_TASK) return;
  appendDesktopLog(`headless handover: stopping ${HEADLESS_SERVICE_TASK}`);
  spawnSchtasks("End");
  for (let i = 0; i < 16; i++) {
    if (await isPortFree(DEFAULT_PORT)) {
      return;
    }
    await sleep(500);
  }
}

function restartHeadlessService() {
  if (!HEADLESS_SERVICE_TASK) return;
  appendDesktopLog(`headless handover: restarting ${HEADLESS_SERVICE_TASK}`);
  // Detached so the restart survives this process exiting.
  spawnSchtasks("Run");
}

app.on("second-instance", () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    if (win.isMinimized()) {
      win.restore();
    }
    win.focus();
  }
});

app.whenReady().then(async () => {
  const resources = resolveResources();
  let appUrl;

  await yieldPortToDesktop();

  registerLockIpc();
  appendDesktopLog(`app launch: mode=${resources.mode} version=${app.getVersion()}`);

  if (resources.mode === "dev") {
    // Dev: `npm run dev` at the repo root provides backend + vite.
    if (!(await runLockGate())) {
      app.quit();
      return;
    }
    const loadingWin = createLoadingWindow();
    lockGateActive = false;
    try {
      await Promise.all([
        waitForPort(DEFAULT_PORT, BACKEND_START_TIMEOUT_MS),
        waitForPort(DEV_VITE_PORT, BACKEND_START_TIMEOUT_MS, () => {
          // Vite usually comes up last; the loading page covers the wait.
        }),
      ]);
      if (!loadingWin.isDestroyed()) {
        await loadingWin.loadURL(`http://127.0.0.1:${DEV_VITE_PORT}`);
      }
    } catch (error) {
      dialog.showErrorBox(
        "MyTube 开发模式启动失败",
        `未检测到开发服务器(${error.message})。\n请先在仓库根目录运行 npm run dev,或使用 npm run desktop:dev。`
      );
      app.quit();
    }
    return;
  }

  const homeDir = process.env.MYTUBE_HOME
    ? path.resolve(process.env.MYTUBE_HOME)
    : path.join(app.getPath("userData"), "server-home");
  prepareServerHome(resources.appRoot, homeDir, app.getVersion());
  const port = await pickBackendPort();
  spawnBackend(resources, homeDir, port);
  runThumbnailBackfill(homeDir, resources, resolveNodeExecutable(resources));

  // The backend boots in the background while the user unlocks the window.
  if (!(await runLockGate())) {
    app.quit();
    return;
  }

  const loadingWin = createLoadingWindow();
  lockGateActive = false;
  let lastLoggedProgress = 0;
  try {
    await waitForPort(port, BACKEND_START_TIMEOUT_MS, (elapsedMs) => {
      // The user may close the loading window (or quit) while we poll; never
      // touch a destroyed window from this callback.
      if (isQuitting || loadingWin.isDestroyed() || loadingWin.webContents.isDestroyed()) {
        return;
      }
      const seconds = Math.round(elapsedMs / 1000);
      if (seconds >= lastLoggedProgress + 5) {
        lastLoggedProgress = seconds;
        try {
          loadingWin.webContents
            .executeJavaScript(
              `document.getElementById('status').textContent = '正在启动本地服务… ${seconds}s';`
            )
            .catch(() => {});
        } catch {
          /* window died between the check and the call */
        }
      }
    });
    if (isQuitting) {
      return;
    }
    appUrl = `http://127.0.0.1:${port}`;
    if (!loadingWin.isDestroyed()) {
      await loadingWin.loadURL(appUrl);
    }
  } catch (error) {
    const logFilePath = path.join(homeDir, "backend.log");
    dialog.showErrorBox(
      "MyTube 启动失败",
      `本地服务未能启动: ${error.message}\n日志: ${logFilePath}\n\n${readLogTail(logFilePath, 15)}`
    );
    app.quit();
  }
});

Menu.setApplicationMenu(null);

app.on("before-quit", () => {
  isQuitting = true;
  killBackendTree();
  restartHeadlessService();
});

app.on("window-all-closed", () => {
  if (lockGateActive) {
    // The lock gate is transitioning between windows (or the user closed the
    // lock window, whose 'closed' handler already resolved the flow); do not
    // treat zero windows as "app finished".
    if (pendingLockResolve) {
      const resolve = pendingLockResolve;
      pendingLockResolve = null;
      resolve({ action: "quit" });
    }
    return;
  }
  isQuitting = true;
  killBackendTree();
  app.quit();
});

process.on("exit", () => {
  killBackendTree();
});
