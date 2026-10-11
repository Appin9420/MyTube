/**
 * Recycle bin service: lists, restores and permanently purges videos that
 * were moved to the trash directory by videoDeletion.moveToTrash().
 *
 * Trash layout: TRASH_DIR/<entryId>/ holds the moved video/thumbnail/subtitle
 * files; the video_trash row keeps the full video row payload plus the
 * original absolute paths so restore can put everything back exactly.
 */

import { and, eq, getTableColumns, isNull, lt } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { TRASH_DIR } from "../../config/paths";
import { db } from "../../db";
import { videoDownloads, videoTrash, videos } from "../../db/schema";
import { DatabaseError } from "../../errors/DownloadErrors";
import { syncMediaServerArtifactsForVideo } from "../mediaServerExport";
import { deleteSmallThumbnailMirrorSync } from "../thumbnailMirrorService";

const TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type TrashFileMove = { from: string; to: string };

type TrashRow = {
  id: string;
  videoId: string;
  title: string;
  payload: string;
  files: string;
  deletedAt: number;
};

export type TrashItem = {
  id: string;
  videoId: string;
  title: string;
  author: string | null;
  fileSize: number | null;
  source: string | null;
  thumbnailUrl: string | null;
  deletedAt: number;
  expiresAt: number;
};

function rowToItem(row: TrashRow): TrashItem {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    videoId: row.videoId,
    title: row.title,
    author: typeof payload.author === "string" ? payload.author : null,
    fileSize:
      typeof payload.fileSize === "number" || typeof payload.fileSize === "string"
        ? Number(payload.fileSize) || null
        : null,
    source: typeof payload.source === "string" ? payload.source : null,
    thumbnailUrl: typeof payload.thumbnailUrl === "string" ? payload.thumbnailUrl : null,
    deletedAt: row.deletedAt,
    expiresAt: row.deletedAt + TRASH_RETENTION_MS,
  };
}

export function listTrash(): TrashItem[] {
  return db
    .select()
    .from(videoTrash)
    .all()
    .map(rowToItem)
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

function getTrashRow(id: string): TrashRow | null {
  const row = db.select().from(videoTrash).where(eq(videoTrash.id, id)).get();
  return (row as TrashRow) ?? null;
}

export function restoreFromTrash(id: string): { video: Record<string, unknown> } {
  const row = getTrashRow(id);
  if (!row) {
    throw new DatabaseError(`Trash entry not found: ${id}`);
  }

  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  const moves = JSON.parse(row.files) as TrashFileMove[];

  // Refuse the restore when a target path is occupied by another file.
  for (const move of moves) {
    if (fs.existsSync(move.from)) {
      throw new DatabaseError(
        `Restore conflict: ${move.from} already exists`,
        undefined,
        "restoreFromTrash"
      );
    }
  }

  for (const move of moves) {
    fs.mkdirSync(path.dirname(move.from), { recursive: true });
    fs.renameSync(move.to, move.from);
  }

  // Normalize the payload against the videos table's column keys so the
  // INSERT binds every placeholder (a missing/undefined binding would throw
  // "Too few parameter values" mid-restore and strand the restored files).
  // getTableColumns() keys are the camelCase property names the payload uses;
  // raw DB column names (pragma table_info) are snake_case and would not match.
  const columnNames = Object.keys(getTableColumns(videos));
  const normalized: Record<string, unknown> = {};
  for (const col of columnNames) {
    const v = payload[col];
    // Arrays/objects (e.g. subtitles) must be stored as JSON text - binding
    // an array makes better-sqlite3 expand it as a nested bind list and
    // throw "Too few parameter values".
    normalized[col] =
      v !== undefined ? (typeof v === "object" && v !== null ? JSON.stringify(v) : v) : null;
  }

  db.insert(videos)
    .values(normalized as typeof videos.$inferInsert)
    .run();
  db.delete(videoTrash).where(eq(videoTrash.id, id)).run();

  // Re-link download tracking so re-downloading the same URL sees the video
  // as existing again (markVideoDownloadDeleted cleared the link on delete).
  // Rows already re-linked to a re-downloaded copy are left alone.
  const sourceUrl =
    typeof payload.sourceUrl === "string" ? payload.sourceUrl : null;
  if (sourceUrl) {
    db.update(videoDownloads)
      .set({ videoId: row.videoId, status: "exists", deletedAt: null })
      .where(
        and(
          eq(videoDownloads.sourceUrl, sourceUrl),
          eq(videoDownloads.status, "deleted"),
          isNull(videoDownloads.videoId)
        )
      )
      .run();
  }

  // The delete flow removed media server artifacts (NFO, posters); rebuild
  // them now that the video is back. No-ops when export is off.
  syncMediaServerArtifactsForVideo(row.videoId);

  return { video: payload };
}

// Permanently deletes a trash entry's files. The video/thumbnail files live in
// the trash entry dir; the small thumbnail mirror lives outside it, so it is
// removed separately using the payload's thumbnail web path.
function purgeTrashEntryFiles(row: TrashRow): void {
  try {
    fs.rmSync(path.join(TRASH_DIR, row.id), { recursive: true, force: true });
  } catch { }
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    if (typeof payload.thumbnailPath === "string") {
      deleteSmallThumbnailMirrorSync(payload.thumbnailPath);
    }
  } catch { /* best effort */ }
}

export function purgeTrashItem(id: string): boolean {
  const row = getTrashRow(id);
  if (!row) return false;

  purgeTrashEntryFiles(row);
  db.delete(videoTrash).where(eq(videoTrash.id, id)).run();
  return true;
}

// Permanently removes recycle-bin entries older than the retention window.
// Called on backend startup; returns the number of purged entries.
export function purgeExpiredTrash(): number {
  const cutoff = Date.now() - TRASH_RETENTION_MS;
  const rows = db
    .select()
    .from(videoTrash)
    .where(lt(videoTrash.deletedAt, cutoff))
    .all() as TrashRow[];

  for (const row of rows) {
    purgeTrashEntryFiles(row);
    db.delete(videoTrash).where(eq(videoTrash.id, row.id)).run();
  }
  return rows.length;
}
