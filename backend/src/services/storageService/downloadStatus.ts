import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../../db";
import { downloads } from "../../db/schema";
import { logger } from "../../utils/logger";
import { DownloadInfo, DownloadStatus } from "./types";

const ACTIVE_DOWNLOAD_STALE_MS = 24 * 60 * 60 * 1000;
const ACTIVE_DOWNLOAD_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

let lastActiveCleanupAt = 0;

type DownloadRow = {
  id: string;
  title: string;
  timestamp: number | null;
  filename: string | null;
  totalSize: string | null;
  downloadedSize: string | null;
  progress: number | null;
  speed: string | null;
  sourceUrl: string | null;
  type: string | null;
  retryMetadata: string | null;
  phase: string | null;
};

const MUTABLE_DOWNLOAD_FIELDS: Array<
  keyof Omit<DownloadInfo, "id" | "timestamp">
> = [
  "progress",
  "totalSize",
  "downloadedSize",
  "speed",
  "filename",
  "sourceUrl",
  "type",
  "title",
  "retryMetadata",
  "phase",
];

function toOptionalValue<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

function mapDownloadRow(download: DownloadRow): DownloadInfo {
  return {
    id: download.id,
    title: download.title,
    timestamp: download.timestamp ?? 0,
    filename: toOptionalValue(download.filename),
    totalSize: toOptionalValue(download.totalSize),
    downloadedSize: toOptionalValue(download.downloadedSize),
    progress: toOptionalValue(download.progress),
    speed: toOptionalValue(download.speed),
    sourceUrl: toOptionalValue(download.sourceUrl),
    type: toOptionalValue(download.type),
    retryMetadata: toOptionalValue(download.retryMetadata),
    phase: toOptionalValue(download.phase),
  };
}

function cleanupStaleActiveDownloadsIfNeeded(now: number): void {
  if (now - lastActiveCleanupAt < ACTIVE_DOWNLOAD_CLEANUP_INTERVAL_MS) {
    return;
  }

  lastActiveCleanupAt = now;
  const threshold = now - ACTIVE_DOWNLOAD_STALE_MS;
  db.delete(downloads)
    .where(and(lt(downloads.timestamp, threshold), eq(downloads.status, "active")))
    .run();
}

export function addActiveDownload(id: string, title: string): void {
  try {
    const now = Date.now();
    db.insert(downloads)
      .values({
        id,
        title,
        timestamp: now,
        status: "active",
      })
      .onConflictDoUpdate({
        target: downloads.id,
        set: {
          title,
          timestamp: now,
          status: "active",
        },
      })
      .run();
    logger.info(`Added/Updated active download: ${title} (${id})`);
  } catch (error) {
    logger.error("Error adding active download", error instanceof Error ? error : new Error(String(error)));
    // Don't throw - download tracking is non-critical
  }
}

export function updateActiveDownload(
  id: string,
  updates: Partial<DownloadInfo>
): void {
  try {
    const updateData: Record<string, unknown> = {
      timestamp: Date.now(),
    };

    for (const field of MUTABLE_DOWNLOAD_FIELDS) {
      const value = updates[field];
      if (value !== undefined) {
        updateData[field] = value;
      }
    }

    db.update(downloads).set(updateData).where(eq(downloads.id, id)).run();
  } catch (error) {
    logger.error("Error updating active download", error instanceof Error ? error : new Error(String(error)));
    // Don't throw - download tracking is non-critical
  }
}

export function removeActiveDownload(id: string): void {
  try {
    db.delete(downloads).where(eq(downloads.id, id)).run();
    logger.info(`Removed active download: ${id}`);
  } catch (error) {
    logger.error("Error removing active download", error instanceof Error ? error : new Error(String(error)));
    // Don't throw - download tracking is non-critical
  }
}

export function updateActiveDownloadTitle(id: string, title: string): void {
  updateActiveDownload(id, { title });
}

export function setQueuedDownloads(queuedDownloads: DownloadInfo[]): void {
  try {
    const latestQueuedById = new Map<string, DownloadInfo>();
    for (const queuedDownload of queuedDownloads) {
      latestQueuedById.set(queuedDownload.id, queuedDownload);
    }

    db.transaction(() => {
      const existingQueued = db
        .select({ id: downloads.id })
        .from(downloads)
        .where(eq(downloads.status, "queued"))
        .all();

      for (const download of latestQueuedById.values()) {
        // Queued rows may carry a paused snapshot (a resumed task waiting in
        // the queue). Tasks without one get their progress fields cleared so
        // stale values cannot linger on a reused row.
        const snapshotFields = {
          progress: download.progress ?? null,
          downloadedSize: download.downloadedSize ?? null,
          totalSize: download.totalSize ?? null,
          filename: download.filename ?? null,
        };
        db.insert(downloads)
          .values({
            id: download.id,
            title: download.title,
            timestamp: download.timestamp,
            status: "queued",
            sourceUrl: download.sourceUrl,
            type: download.type,
            retryMetadata: download.retryMetadata,
            ...snapshotFields,
          })
          .onConflictDoUpdate({
            target: downloads.id,
            set: {
              title: download.title,
              timestamp: download.timestamp,
              status: "queued",
              sourceUrl: download.sourceUrl,
              type: download.type,
              retryMetadata: download.retryMetadata,
              ...snapshotFields,
            },
          })
          .run();
      }

      const latestIds = new Set(latestQueuedById.keys());
      const staleQueuedIds = existingQueued
        .map((item) => item.id)
        .filter((id) => !latestIds.has(id));

      if (staleQueuedIds.length > 0) {
        db.delete(downloads)
          .where(
            and(
              eq(downloads.status, "queued"),
              inArray(downloads.id, staleQueuedIds)
            )
          )
          .run();
      }
    });
  } catch (error) {
    logger.error("Error setting queued downloads", error instanceof Error ? error : new Error(String(error)));
    // Don't throw - download tracking is non-critical
  }
}

export function addPausedDownload(info: DownloadInfo): void {
  try {
    db.insert(downloads)
      .values({
        id: info.id,
        title: info.title,
        timestamp: info.timestamp,
        status: "paused",
        sourceUrl: info.sourceUrl,
        type: info.type,
        retryMetadata: info.retryMetadata,
        filename: info.filename,
        progress: info.progress,
        downloadedSize: info.downloadedSize,
        totalSize: info.totalSize,
      })
      .onConflictDoUpdate({
        target: downloads.id,
        set: {
          title: info.title,
          timestamp: info.timestamp,
          status: "paused",
          sourceUrl: info.sourceUrl,
          type: info.type,
          retryMetadata: info.retryMetadata,
          filename: info.filename,
          progress: info.progress,
          downloadedSize: info.downloadedSize,
          totalSize: info.totalSize,
        },
      })
      .run();
  } catch (error) {
    logger.error("Error adding paused download", error instanceof Error ? error : new Error(String(error)));
    // Don't throw - download tracking is non-critical
  }
}

export function removePausedDownload(id: string): void {
  try {
    db.delete(downloads)
      .where(and(eq(downloads.id, id), eq(downloads.status, "paused")))
      .run();
  } catch (error) {
    logger.error("Error removing paused download", error instanceof Error ? error : new Error(String(error)));
    // Don't throw - download tracking is non-critical
  }
}

export function getPausedDownload(id: string): DownloadInfo | undefined {
  try {
    const download = db
      .select()
      .from(downloads)
      .where(and(eq(downloads.id, id), eq(downloads.status, "paused")))
      .get();

    if (download) {
      return mapDownloadRow(download);
    }

    return undefined;
  } catch (error) {
    logger.error(
      "Error getting paused download",
      error instanceof Error ? error : new Error(String(error))
    );
    return undefined;
  }
}

export function getDownloadStatus(): DownloadStatus {
  try {
    cleanupStaleActiveDownloadsIfNeeded(Date.now());

    const activeDownloads = db
      .select()
      .from(downloads)
      .where(eq(downloads.status, "active"))
      .all()
      .map(mapDownloadRow);

    const queuedDownloads = db
      .select()
      .from(downloads)
      .where(eq(downloads.status, "queued"))
      .all()
      .map(mapDownloadRow);

    const pausedDownloads = db
      .select()
      .from(downloads)
      .where(eq(downloads.status, "paused"))
      .all()
      .map(mapDownloadRow)
      .sort((a, b) => a.timestamp - b.timestamp);

    return { activeDownloads, queuedDownloads, pausedDownloads };
  } catch (error) {
    logger.error("Error reading download status", error instanceof Error ? error : new Error(String(error)));
    // Return empty arrays for backward compatibility
    return { activeDownloads: [], queuedDownloads: [], pausedDownloads: [] };
  }
}

export function getActiveDownload(id: string): DownloadInfo | undefined {
  try {
    const download = db
      .select()
      .from(downloads)
      .where(and(eq(downloads.id, id), eq(downloads.status, "active")))
      .get();

    if (download) {
      return mapDownloadRow(download);
    }

    return undefined;
  } catch (error) {
    logger.error(
      "Error getting active download",
      error instanceof Error ? error : new Error(String(error))
    );
    return undefined;
  }
}
