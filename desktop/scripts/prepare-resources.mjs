#!/usr/bin/env node
/**
 * Stages everything the packaged MyTube desktop app needs at runtime into
 * desktop/build/staging/:
 *
 *   staging/app/                 -> backend cwd equivalent of the Docker /app layout
 *     dist/                        compiled backend (node dist/src/server.js)
 *     frontend/dist/               built SPA (served by the backend itself)
 *     node_modules/                production deps only (npm ci --omit=dev)
 *     drizzle/                     DB migrations (backend reads them from its cwd)
 *     vendor/, scripts/, package.json, package-lock.json   needed by npm ci / postinstall
 *     bgutil-ytdlp-pot-provider/   yt-dlp POT provider (cwd-relative, optional at runtime)
 *   staging/bin/                 node.exe (copied from the Node running this script, so
 *                                better-sqlite3's ABI always matches) + yt-dlp.exe,
 *                                ffmpeg/ffprobe, cloudflared (best-effort downloads; yt-dlp
 *                                JS challenges fall back to the bundled node runtime)
 *
 * electron-builder then maps staging/app -> resources/server and staging/bin -> resources/bin
 * (see desktop/package.json "build.extraResources").
 *
 * External binaries are cached in desktop/build/cache/ and only downloaded when missing.
 * Any failed download is a warning, not an error: the app runs, affected features degrade
 * until the user provides the binary.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const DESKTOP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");
const FRONTEND_DIR = path.join(REPO_ROOT, "frontend");
const STAGING_DIR = path.join(DESKTOP_DIR, "build", "staging");
const STAGING_APP = path.join(STAGING_DIR, "app");
const STAGING_BIN = path.join(STAGING_DIR, "bin");
const CACHE_DIR = path.join(DESKTOP_DIR, "build", "cache");

const isWindows = process.platform === "win32";

function log(message) {
  console.log(`[prepare] ${message}`);
}

function warn(message) {
  console.warn(`[prepare] WARNING: ${message}`);
}

function die(message) {
  console.error(`[prepare] ERROR: ${message}`);
  process.exit(1);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function rmRf(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

function copyDir(src, dest, { skipDirNames = [] } = {}) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory() && skipDirNames.includes(entry.name)) {
      continue;
    }
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, { skipDirNames });
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function run(command, options = {}) {
  log(`$ ${command}  (cwd: ${options.cwd || process.cwd()})`);
  execSync(command, {
    stdio: "inherit",
    shell: isWindows ? true : "/bin/bash",
    ...options,
  });
}

function dirSizeMB(target) {
  let total = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* file vanished mid-walk */
        }
      }
    }
  };
  walk(target);
  return Math.round(total / 1024 / 1024);
}

// ---------------------------------------------------------------------------
// 1. Sync desktop version with the repo version
// ---------------------------------------------------------------------------

function syncVersion() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const desktopPkgPath = path.join(DESKTOP_DIR, "package.json");
  const desktopPkg = JSON.parse(fs.readFileSync(desktopPkgPath, "utf8"));
  if (desktopPkg.version !== rootPkg.version) {
    desktopPkg.version = rootPkg.version;
    fs.writeFileSync(desktopPkgPath, JSON.stringify(desktopPkg, null, 2) + "\n", "utf8");
    log(`Synced desktop version -> ${rootPkg.version}`);
  }
  return rootPkg.version;
}

// ---------------------------------------------------------------------------
// 2. Build backend (tsc) and frontend (vite build)
// ---------------------------------------------------------------------------

function buildApps() {
  run("npm run build", { cwd: BACKEND_DIR });
  run("npm run build", { cwd: FRONTEND_DIR });

  const backendEntry = path.join(BACKEND_DIR, "dist", "src", "server.js");
  const frontendIndex = path.join(FRONTEND_DIR, "dist", "index.html");
  if (!fs.existsSync(backendEntry)) {
    die(`backend build output missing: ${backendEntry}`);
  }
  if (!fs.existsSync(frontendIndex)) {
    die(`frontend build output missing: ${frontendIndex}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Assemble staging/app (Docker /app equivalent)
// ---------------------------------------------------------------------------

function stageApp() {
  rmRf(STAGING_DIR);
  ensureDir(STAGING_APP);
  ensureDir(STAGING_BIN);

  copyDir(path.join(BACKEND_DIR, "dist"), path.join(STAGING_APP, "dist"));
  copyDir(path.join(FRONTEND_DIR, "dist"), path.join(STAGING_APP, "frontend", "dist"));
  copyDir(path.join(BACKEND_DIR, "drizzle"), path.join(STAGING_APP, "drizzle"));
  copyDir(path.join(BACKEND_DIR, "vendor"), path.join(STAGING_APP, "vendor"));
  copyDir(path.join(BACKEND_DIR, "scripts"), path.join(STAGING_APP, "scripts"));
  for (const file of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(path.join(BACKEND_DIR, file), path.join(STAGING_APP, file));
  }

  const providerDir = path.join(BACKEND_DIR, "bgutil-ytdlp-pot-provider");
  if (fs.existsSync(providerDir)) {
    copyDir(providerDir, path.join(STAGING_APP, "bgutil-ytdlp-pot-provider"), {
      skipDirNames: ["node_modules"],
    });
  } else {
    warn("bgutil-ytdlp-pot-provider not found in backend; skipping.");
  }
  log(`Staged app skeleton: ${dirSizeMB(STAGING_APP)} MB (without node_modules)`);
}

// ---------------------------------------------------------------------------
// 4. Install production dependencies into staging/app
// ---------------------------------------------------------------------------

function installBackendProdDeps() {
  const env = {
    ...process.env,
    // Mirror the Docker build: no Chromium download, no provider/ffmpeg side effects.
    PUPPETEER_SKIP_DOWNLOAD: "1",
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD: "1",
    SKIP_PROVIDER_BUILD: "1",
    SKIP_FFMPEG_AUTO_INSTALL: "1",
  };
  run("npm ci --omit=dev", { cwd: STAGING_APP, env });
  log(`Installed production deps: ${dirSizeMB(path.join(STAGING_APP, "node_modules"))} MB`);

  const sqliteNative = path.join(
    STAGING_APP,
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node"
  );
  if (!fs.existsSync(sqliteNative)) {
    die("better-sqlite3 native module missing after npm ci - packaged backend would not start.");
  }
}

// ---------------------------------------------------------------------------
// 5. Bundle node.exe (same binary that ran npm ci, so native ABIs match)
// ---------------------------------------------------------------------------

function bundleNode() {
  if (!isWindows) {
    warn("Non-Windows build: skipping node.exe bundling (system node will be used).");
    return;
  }
  if (!process.execPath.toLowerCase().endsWith("node.exe")) {
    die(`process.execPath is not node.exe: ${process.execPath}`);
  }
  const dest = path.join(STAGING_BIN, "node.exe");
  fs.copyFileSync(process.execPath, dest);
  log(`Bundled node runtime: ${process.version} (${dirSizeMB(STAGING_BIN)} MB)`);
}

// ---------------------------------------------------------------------------
// 6. Download external binaries (best-effort, cached, multi-source fallback)
// ---------------------------------------------------------------------------

// Machines without direct GitHub access (some CN networks) can set
// MYTUBE_GH_PROXY to a prefix such as https://gh-proxy.com , which gets
// prepended to the raw github.com URLs below.
const GH_PROXY = (process.env.MYTUBE_GH_PROXY || "").replace(/\/+$/, "");

function githubUrl(repoPath) {
  return GH_PROXY
    ? `${GH_PROXY}/https://github.com/${repoPath}`
    : `https://github.com/${repoPath}`;
}

async function downloadBuffer(url, timeoutMs = 10 * 60_000) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function writeMaybeGzip(buffer, destFile) {
  const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  fs.writeFileSync(destFile, isGzip ? zlib.gunzipSync(buffer) : buffer);
}

/**
 * Resolve the newest mirrored binary of an ffmpeg-static style category on
 * npmmirror (https://registry.npmmirror.com/-/binary/<category>/). Returns the
 * file URL or null when the mirror has nothing usable.
 */
async function npmmirrorLatestBinary(category, filePattern) {
  const base = `https://registry.npmmirror.com/-/binary/${category}/`;
  try {
    const listing = await (
      await fetch(base, { signal: AbortSignal.timeout(20_000) })
    ).json();
    const dirs = (Array.isArray(listing) ? listing : [])
      .filter((entry) => entry.type === "dir")
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    for (const dir of dirs.slice(0, 3)) {
      const files = await (
        await fetch(dir.url, { signal: AbortSignal.timeout(20_000) })
      ).json();
      const match = (Array.isArray(files) ? files : []).find(
        (entry) => entry.type === "file" && filePattern.test(entry.name)
      );
      if (match) {
        return match.url;
      }
    }
  } catch (error) {
    warn(`npmmirror listing for "${category}" unavailable: ${error.message}`);
  }
  return null;
}

/**
 * curl-based download fallback. Node's fetch cannot use an HTTP proxy, and on
 * networks where GitHub is blocked a local proxy client (Clash etc.) is often
 * running; try it before giving up on a source.
 */
const LOCAL_PROXY_CANDIDATES = [
  "http://127.0.0.1:7892",
  "http://127.0.0.1:7890",
  "http://127.0.0.1:1080",
  "http://127.0.0.1:10809",
];

function downloadViaCurl(url, destFile, proxy) {
  const result = spawnSync(
    "curl",
    [
      "-sL",
      "--max-time", "300",
      "--max-filesize", "524288000",
      ...(proxy ? ["-x", proxy] : []),
      "-o", destFile,
      url,
    ],
    { timeout: 320_000 }
  );
  if (result.status !== 0 || !fs.existsSync(destFile) || fs.statSync(destFile).size < 1024) {
    throw new Error(`curl failed${proxy ? ` via ${proxy}` : ""}`);
  }
}

async function fetchBinary(label, destFile, urls) {
  if (fs.existsSync(destFile)) {
    log(`${label}: already bundled`);
    return true;
  }
  const cacheFile = path.join(
    CACHE_DIR,
    `${label.replace(/\W+/g, "-")}.bin`
  );
  for (const url of urls) {
    let downloaded = false;
    try {
      ensureDir(CACHE_DIR);
      if (!fs.existsSync(cacheFile)) {
        log(`${label}: downloading ${url} ...`);
        const bytes = await downloadBuffer(url);
        writeMaybeGzip(bytes, cacheFile);
        log(`${label}: saved ${Math.round(bytes.length / 1024 / 1024)} MB`);
      } else {
        log(`${label}: using cached download`);
      }
      downloaded = true;
    } catch (fetchError) {
      warn(`${label}: fetch failed (${fetchError.message}); trying curl fallbacks...`);
      for (const proxy of [null, ...LOCAL_PROXY_CANDIDATES]) {
        try {
          downloadViaCurl(url, cacheFile, proxy);
          log(`${label}: curl ok${proxy ? ` (proxy ${proxy})` : " (direct)"}`);
          downloaded = true;
          break;
        } catch (curlError) {
          warn(`${label}: ${curlError.message}`);
        }
      }
    }
    if (downloaded) {
      fs.copyFileSync(cacheFile, destFile);
      return true;
    }
  }
  warn(`${label}: NOT bundled - the app still runs, the related feature degrades.`);
  return false;
}

async function fetchFfmpeg() {
  const dest = path.join(STAGING_BIN, "ffmpeg.exe");
  const mirrorUrl = await npmmirrorLatestBinary(
    "ffmpeg-static",
    /^ffmpeg-win32-x64(\.gz)?$/
  );
  const sources = [
    ...(mirrorUrl ? [mirrorUrl] : []),
    githubUrl("eugeneware/ffmpeg-static/releases/latest/download/ffmpeg-windows-x64.exe"),
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
  ];
  const ok = await fetchBinary("ffmpeg", dest, sources);
  if (ok) {
    try {
      const header = fs.readFileSync(dest).subarray(0, 2);
      if (header[0] === 0x1f && header[1] === 0x8b) {
        // cached copy was stored gzipped
        fs.writeFileSync(dest, zlib.gunzipSync(fs.readFileSync(dest)));
      }
      if (fs.readFileSync(dest).subarray(0, 2).toString() !== "MZ") {
        throw new Error("not a Windows executable");
      }
    } catch (error) {
      warn(`ffmpeg.exe failed validation (${error.message}); removing it.`);
      fs.rmSync(dest, { force: true });
      return false;
    }
  }
  return ok;
}

async function fetchFfprobe() {
  const dest = path.join(STAGING_BIN, "ffprobe.exe");
  const mirrorUrl = await npmmirrorLatestBinary(
    "ffprobe-static",
    /^ffprobe-win32-x64(\.gz)?$/
  );
  if (!mirrorUrl) {
    log("ffprobe: no mirror source; skipping (ffmpeg alone covers yt-dlp merging).");
    return false;
  }
  const ok = await fetchBinary("ffprobe", dest, [mirrorUrl]);
  if (ok) {
    try {
      if (fs.readFileSync(dest).subarray(0, 2).toString() !== "MZ") {
        throw new Error("not a Windows executable");
      }
    } catch (error) {
      warn(`ffprobe.exe failed validation (${error.message}); removing it.`);
      fs.rmSync(dest, { force: true });
      return false;
    }
  }
  return ok;
}

/**
 * Fallback when the standalone yt-dlp.exe cannot be downloaded (e.g. GitHub
 * unreachable): install via pip and bundle the generated launcher. The
 * launcher embeds the absolute python.exe path of THIS machine, so the
 * packaged app keeps working here, but a machine without that exact Python
 * install needs the official standalone exe dropped into resources/bin.
 */
function installYtDlpViaPip() {
  try {
    const pythonCmd = isWindows ? "py" : "python3";
    log("yt-dlp: trying pip fallback (uses local Python)...");
    execSync(
      `${pythonCmd} -m pip install --no-cache-dir yt-dlp bgutil-ytdlp-pot-provider curl-cffi`,
      { stdio: "inherit", timeout: 10 * 60_000 }
    );
    const scriptsDir = execSync(
      `${pythonCmd} -c "import sysconfig;print(sysconfig.get_path('scripts'))"`,
      { encoding: "utf8" }
    ).trim();
    const exeName = isWindows ? "yt-dlp.exe" : "yt-dlp";
    const exe = path.join(scriptsDir, exeName);
    if (fs.existsSync(exe)) {
      fs.copyFileSync(exe, path.join(STAGING_BIN, exeName));
      warn("yt-dlp bundled as a pip launcher bound to this machine's Python.");
      return true;
    }
    warn(`pip install reported success but ${exe} not found.`);
  } catch (error) {
    warn(`yt-dlp pip fallback failed: ${error.message}`);
  }
  return false;
}

async function fetchExternalBinaries() {
  ensureDir(STAGING_BIN);
  const results = {};

  results["yt-dlp.exe"] =
    (await fetchBinary(
      "yt-dlp",
      path.join(STAGING_BIN, "yt-dlp.exe"),
      [githubUrl("yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe")]
    )) || installYtDlpViaPip();
  results["ffmpeg.exe"] = await fetchFfmpeg();
  results["ffprobe.exe"] = await fetchFfprobe();
  results["cloudflared.exe"] = await fetchBinary(
    "cloudflared",
    path.join(STAGING_BIN, "cloudflared.exe"),
    [
      githubUrl(
        "cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
      ),
    ]
  );

  const wanted = ["yt-dlp.exe", "ffmpeg.exe", "ffprobe.exe", "cloudflared.exe"];
  const missing = wanted.filter((name) => !results[name]);
  if (missing.length) {
    warn(
      `Not bundled: ${missing.join(", ")}. Notes: yt-dlp auto-installs via pip at runtime ` +
        `when Python is available, or drop the .exe next to the app's node.exe; ` +
        `yt-dlp JS challenges fall back to the bundled node runtime.`
    );
  }
  log(`Bundled binaries: ${dirSizeMB(STAGING_BIN)} MB total`);
}

// ---------------------------------------------------------------------------

async function main() {
  if (!isWindows) {
    warn("This prepare script targets Windows; continuing anyway.");
  }
  syncVersion();
  log("Building backend (tsc) and frontend (vite)...");
  buildApps();
  log("Staging app layout...");
  stageApp();
  log("Installing production dependencies...");
  installBackendProdDeps();
  bundleNode();
  log("Fetching external binaries (yt-dlp / ffmpeg / cloudflared)...");
  await fetchExternalBinaries();
  log(`Done. Staging root: ${STAGING_DIR} (${dirSizeMB(STAGING_DIR)} MB)`);
}

main().catch((error) => {
  die(error.stack || error.message || String(error));
});
