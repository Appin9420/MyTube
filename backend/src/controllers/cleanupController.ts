import { Request, Response } from "express";
import path from "path";
import { VIDEOS_DIR } from "../config/paths";
import { ValidationError } from "../errors/DownloadErrors";
import * as storageService from "../services/storageService";
import { logger } from "../utils/logger";
import {
  readdirDirentsSafe,
  removeSafe,
  resolveSafeChildPath,
} from "../utils/security";

function getFilenameStem(filename: string): string {
  const base = path.basename(filename);
  const lastDot = base.lastIndexOf(".");
  // "Video.mp4" -> "Video"; a leading-dot name like ".mp4" has no stem
  return lastDot > 0 ? base.slice(0, lastDot) : base;
}

/**
 * Clean up temporary download files (.ytdl, .part)
 * Errors are automatically handled by asyncHandler middleware
 */
export const cleanupTempFiles = async (
  req: Request,
  res: Response
): Promise<void> => {
  // Check if there are active downloads
  const downloadStatus = storageService.getDownloadStatus();
  if (downloadStatus.activeDownloads.length > 0) {
    throw new ValidationError(
      `Cannot clean up while downloads are active (${downloadStatus.activeDownloads.length} active)`,
      "activeDownloads"
    );
  }

  // Paused downloads keep resumable artifacts on disk: bilibili uses a
  // `temp_download_<id>` directory keyed by download id, and youtube/missav
  // leave `<stem>.part`, `.ytdl` and intermediate stream files in VIDEOS_DIR.
  // Deleting them would force the next resume to start from zero, so they are
  // protected here. When in doubt an entry is protected rather than deleted.
  const pausedDownloads = downloadStatus.pausedDownloads ?? [];
  const protectedDirNames = new Set<string>();
  const protectedStems = new Set<string>();
  for (const paused of pausedDownloads) {
    // bilibiliFileManager sanitizes the id into the directory name; protect
    // the sanitized variant too so one differing character cannot orphan the
    // resume artifacts.
    protectedDirNames.add(`temp_download_${paused.id}`);
    protectedDirNames.add(
      `temp_download_${paused.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`
    );
    if (paused.filename) {
      const stem = getFilenameStem(paused.filename);
      if (stem) {
        protectedStems.add(stem);
      }
    }
  }

  const isProtectedEntryName = (name: string): boolean => {
    if (protectedDirNames.has(name)) {
      return true;
    }
    for (const stem of protectedStems) {
      if (name.startsWith(stem)) {
        return true;
      }
    }
    return false;
  };

  let deletedCount = 0;
  let skippedCount = 0;
  const errors: string[] = [];

  // Recursively find and delete .ytdl and .part files
  const cleanupDirectory = async (dir: string) => {
    try {
      const entries = await readdirDirentsSafe(dir, VIDEOS_DIR);

      for (const entry of entries) {
        const fullPath = resolveSafeChildPath(dir, entry.name);

        if (entry.isDirectory()) {
          // Check for temp_ folder
          if (entry.name.startsWith("temp_")) {
            if (isProtectedEntryName(entry.name)) {
              skippedCount++;
              logger.debug(
                `Skipped temp directory of a paused download: ${fullPath}`
              );
              continue;
            }
            try {
              await removeSafe(fullPath, VIDEOS_DIR);
              deletedCount++;
              logger.debug(`Deleted temp directory: ${fullPath}`);
            } catch (error) {
              const errorMsg = `Failed to delete directory ${fullPath}: ${
                error instanceof Error ? error.message : String(error)
              }`;
              logger.warn(errorMsg);
              errors.push(errorMsg);
            }
          } else {
            // Recursively clean subdirectories
            await cleanupDirectory(fullPath);
          }
        } else if (entry.isFile()) {
          // Check if file has .ytdl or .part extension
          if (entry.name.endsWith(".ytdl") || entry.name.endsWith(".part")) {
            if (isProtectedEntryName(entry.name)) {
              skippedCount++;
              logger.debug(
                `Skipped partial file of a paused download: ${fullPath}`
              );
              continue;
            }
            try {
              await removeSafe(fullPath, VIDEOS_DIR);
              deletedCount++;
              logger.debug(`Deleted temp file: ${fullPath}`);
            } catch (error) {
              const errorMsg = `Failed to delete ${fullPath}: ${
                error instanceof Error ? error.message : String(error)
              }`;
              logger.warn(errorMsg);
              errors.push(errorMsg);
            }
          }
        }
      }
    } catch (error) {
      const errorMsg = `Failed to read directory ${dir}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      logger.error(errorMsg);
      errors.push(errorMsg);
    }
  };

  // Start cleanup from VIDEOS_DIR
  await cleanupDirectory(VIDEOS_DIR);

  // Return format expected by frontend: { deletedCount, errors? }
  res.status(200).json({
    deletedCount,
    skippedCount,
    ...(errors.length > 0 && { errors }),
  });
};
