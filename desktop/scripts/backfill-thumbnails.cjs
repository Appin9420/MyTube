#!/usr/bin/env node
/**
 * Backfill missing video thumbnails for a MyTube server home directory.
 *
 * Fixes videos saved with no cover (e.g. downloaded while the network could
 * not reach the source site). For each video whose thumbnail_path is empty:
 *   1. try downloading the stored thumbnail_url (browser-ish headers);
 *   2. fall back to extracting a frame from the video file with ffmpeg.
 * The image is written next to the video file (<basename>.jpg) matching the
 * downloaders' convention, then the DB row is updated. The 480x270 small
 * mirror is generated lazily by the app itself on first request.
 *
 * Usage:
 *   node backfill-thumbnails.cjs [--home <server-home>] [--dry-run]
 *
 * Default home: %APPDATA%/MyTube/server-home (the desktop app's data dir).
 * Safe to re-run; only touches videos without a thumbnail.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const homeIdx = args.indexOf("--home");
const sqliteIdx = args.indexOf("--sqlite");
const ffmpegIdx = args.indexOf("--ffmpeg");
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const HOME = path.resolve(
  homeIdx >= 0 ? args[homeIdx + 1] : path.join(process.env.APPDATA || "", "MyTube", "server-home")
);
const UPLOADS_DIR = path.join(HOME, "uploads");
const DB_PATH = path.join(HOME, "data", "mytube.db");

const FFMPEG_CANDIDATES = [
  ...(ffmpegIdx >= 0 ? [args[ffmpegIdx + 1]] : []),
  path.join(REPO_ROOT, "desktop", "release", "win-unpacked", "resources", "bin", "ffmpeg.exe"),
  path.join(REPO_ROOT, "desktop", "build", "staging", "bin", "ffmpeg.exe"),
  "ffmpeg",
];
const SQLITE_CANDIDATES = [
  ...(sqliteIdx >= 0 ? [args[sqliteIdx + 1]] : []),
  path.join(REPO_ROOT, "desktop", "release", "win-unpacked", "resources", "server", "node_modules", "better-sqlite3"),
  path.join(REPO_ROOT, "desktop", "build", "staging", "app", "node_modules", "better-sqlite3"),
  path.join(REPO_ROOT, "backend", "node_modules", "better-sqlite3"),
];

function resolveFirst(candidates, label) {
  for (const candidate of candidates) {
    try {
      require.resolve(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  console.error(`[backfill] ERROR: cannot locate ${label}; tried:\n  ${candidates.join("\n  ")}`);
  process.exit(1);
}

const Database = require(resolveFirst(SQLITE_CANDIDATES, "better-sqlite3"));
const FFMPEG = FFMPEG_CANDIDATES.find((c) => {
  try {
    return fs.existsSync(c) || spawnSync(c, ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
});
if (!FFMPEG) {
  console.error("[backfill] ERROR: ffmpeg not found (bundled bin dir or PATH)");
  process.exit(1);
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function looksLikeImage(buffer) {
  if (!buffer || buffer.length < 1024) {
    return false;
  }
  const hex = buffer.subarray(0, 4).toString("hex").toUpperCase();
  return (
    hex.startsWith("FFD8") || // jpeg
    hex.startsWith("89504E47") || // png
    buffer.subarray(0, 3).toString("ascii") === "GIF" ||
    buffer.subarray(0, 4).toString("ascii") === "RIFF" // webp
  );
}

async function downloadThumbnail(url, referer, destFile) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        ...(referer ? { Referer: referer } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!looksLikeImage(buffer)) {
      throw new Error(`not an image (${buffer.length} bytes)`);
    }
    fs.writeFileSync(destFile, buffer);
    return buffer.length;
  } catch (fetchError) {
    // Node's fetch can be blocked where curl succeeds (TLS fingerprinting,
    // IPv6 issues); fall back to curl before giving up on the real cover.
    const result = spawnSync(
      "curl",
      [
        "-sL",
        "--max-time", "30",
        "--max-filesize", "20971520",
        "-A", BROWSER_UA,
        ...(referer ? ["-e", referer] : []),
        "-o", destFile,
        url,
      ],
      { timeout: 40_000 }
    );
    if (result.status === 0 && fs.existsSync(destFile) && looksLikeImage(fs.readFileSync(destFile))) {
      return fs.statSync(destFile).size;
    }
    throw fetchError;
  }
}

function extractFrame(videoAbs, destFile) {
  for (const seek of ["00:00:02", "00:00:00"]) {
    const result = spawnSync(
      FFMPEG,
      ["-nostdin", "-y", "-ss", seek, "-i", videoAbs, "-vframes", "1", "-update", "1", destFile],
      { timeout: 60_000, stdio: "ignore" }
    );
    if (result.status === 0 && fs.existsSync(destFile) && fs.statSync(destFile).size > 1024) {
      return seek;
    }
  }
  return null;
}

function webPathFor(absPath) {
  // uploads/videos/<...> is served at web path /videos/<...>
  const rel = path.relative(UPLOADS_DIR, absPath).split(path.sep).join("/");
  return "/" + rel;
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[backfill] ERROR: database not found at ${DB_PATH}`);
    process.exit(1);
  }
  const db = new Database(DB_PATH);
  db.pragma("busy_timeout = 15000");

  const rows = db
    .prepare(
      `SELECT id, title, video_path, video_filename, thumbnail_url, source, source_url
       FROM videos
       WHERE thumbnail_path IS NULL OR thumbnail_path = ''`
    )
    .all();
  console.log(`[backfill] ${rows.length} video(s) without a cover (home: ${HOME})${dryRun ? " [dry-run]" : ""}`);

  let fixed = 0;
  for (const row of rows) {
    const label = `"${(row.title || row.id).slice(0, 60)}"`;
    if (!row.video_path) {
      console.log(`[backfill] SKIP ${label}: no video_path`);
      continue;
    }
    const videoAbs = path.join(UPLOADS_DIR, row.video_path.replace(/^\//, ""));
    if (!fs.existsSync(videoAbs)) {
      console.log(`[backfill] SKIP ${label}: video file missing (${row.video_path})`);
      continue;
    }
    const thumbAbs = path.join(
      path.dirname(videoAbs),
      path.basename(videoAbs, path.extname(videoAbs)) + ".jpg"
    );
    if (fs.existsSync(thumbAbs) && fs.statSync(thumbAbs).size > 1024) {
      // file already there but DB not updated - just link it
      if (!dryRun) {
        db.prepare("UPDATE videos SET thumbnail_filename = ?, thumbnail_path = ? WHERE id = ?").run(
          path.basename(thumbAbs),
          webPathFor(thumbAbs),
          row.id
        );
      }
      console.log(`[backfill] FIXED ${label}: existing image linked`);
      fixed += 1;
      continue;
    }

    let how = null;
    if (row.thumbnail_url && !dryRun) {
      try {
        const bytes = await downloadThumbnail(row.thumbnail_url, row.source_url, thumbAbs);
        how = `downloaded (${Math.round(bytes / 1024)} KB)`;
      } catch (error) {
        console.log(`[backfill]   thumbnail_url failed: ${error.message}; falling back to ffmpeg frame`);
      }
    }
    if (!how && !dryRun) {
      const seek = extractFrame(videoAbs, thumbAbs);
      if (seek) {
        how = `ffmpeg frame @${seek}`;
      }
    }

    if (dryRun) {
      console.log(`[backfill] WOULD FIX ${label} (url: ${row.thumbnail_url ? "yes" : "no"})`);
      continue;
    }
    if (!how) {
      console.log(`[backfill] STILL MISSING ${label}`);
      continue;
    }
    db.prepare("UPDATE videos SET thumbnail_filename = ?, thumbnail_path = ? WHERE id = ?").run(
      path.basename(thumbAbs),
      webPathFor(thumbAbs),
      row.id
    );
    console.log(`[backfill] FIXED ${label}: ${how}`);
    fixed += 1;
  }

  db.close();
  console.log(`[backfill] done: ${fixed}/${rows.length} cover(s) backfilled${dryRun ? " (dry-run, nothing written)" : ""}`);
}

main().catch((error) => {
  console.error("[backfill] ERROR:", error.stack || error.message);
  process.exit(1);
});
