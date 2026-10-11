import { eq } from "drizzle-orm";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import {
  AVATARS_DIR,
  IMAGES_DIR,
  SUBTITLES_DIR,
  TRASH_DIR,
  UPLOADS_DIR,
  VIDEOS_DIR,
} from "../../config/paths";
import { db } from "../../db";
import { videoTrash, videos } from "../../db/schema";
import { DatabaseError } from "../../errors/DownloadErrors";
import { resolveManagedWebPath } from "../filenameTemplate/pathHelpers";
import { removeMediaServerArtifactsForVideo } from "../mediaServerExport";
import { logger } from "../../utils/logger";
import { getCollections } from "./collections";
import {
  buildStoragePath,
  findImageFile,
  findVideoFile,
  findVideoFilesByFilename,
  pathExists,
  removeEmptyDirectoryChain,
  removeFileIfExists,
} from "./fileHelpers";
import { markDownloadHistoryDeletedByVideoId } from "./downloadHistory";
import { markVideoDownloadDeleted } from "./videoDownloadTracking";
import {
  deleteSmallThumbnailMirrorSync,
  resolveManagedThumbnailWebPathFromAbsolutePath,
} from "../thumbnailMirrorService";
import { getVideoById, getVideos } from "./videoQueries";

export function deleteVideo(
  id: string,
  reason: "manual" | "retention" | "maintenance" = "manual"
): boolean {
  try {
    const videoToDelete = getVideoById(id);
    if (!videoToDelete) return false;

    const allCollections = getCollections();

    // Manual deletes go to the recycle bin: managed artifacts are moved to
    // the trash directory and the row leaves the library. Restoring brings
    // everything back. Automated cleanups stay permanent.
    if (reason === "manual" && isLocalManagedVideo(videoToDelete)) {
      const entryId = moveToTrash(videoToDelete, allCollections);
      if (entryId) {
        finalizeLibraryRemoval(id, videoToDelete, reason);
        return true;
      }
      // Trash move failed (or nothing was on disk) — fall through to the
      // permanent path so dead rows are still cleaned up.
    }

    // Remove video file
    deleteVideoFile(videoToDelete, allCollections);

    // Remove thumbnail file
    deleteThumbnailFile(videoToDelete, allCollections);

    // Remove author avatar file only if this is the last video from this author
    deleteAuthorAvatarIfNeeded(videoToDelete, id);

    // Remove subtitle files
    deleteSubtitleFiles(videoToDelete, allCollections);

    finalizeLibraryRemoval(id, videoToDelete, reason);
    return true;
  } catch (error) {
    logger.error(
      "Error deleting video",
      error instanceof Error ? error : new Error(String(error))
    );
    throw new DatabaseError(
      `Failed to delete video: ${id}`,
      error instanceof Error ? error : new Error(String(error)),
      "deleteVideo"
    );
  }
}

function finalizeLibraryRemoval(
  id: string,
  videoToDelete: import("./types").Video,
  reason: "manual" | "retention" | "maintenance"
): void {
  const deletedAt = Date.now();

  // Mark download tracking and history as deleted
  markVideoDownloadDeleted(id);
  markDownloadHistoryDeletedByVideoId(id, deletedAt);

  // Delete from DB
  db.delete(videos).where(eq(videos.id, id)).run();
  removeMediaServerArtifactsForVideo(videoToDelete, {
    libraryVideos: getVideos(),
  });

  // Statistics: emit library_video_deleted with the reason bucket and a size
  // snapshot if known. Best-effort; never blocks the delete.
  try {
    // Lazy require to avoid import cycles between storageService and statistics.
    const { recordEvent } = require("../statistics") as {
      recordEvent: (input: any) => string | null;
    };
    const fileSizeBytes =
      videoToDelete.fileSize !== undefined && videoToDelete.fileSize !== null
        ? Number(videoToDelete.fileSize) || 0
        : 0;
    recordEvent({
      eventType: "library_video_deleted",
      actorRole: reason === "retention" ? "system" : "system",
      surface: "background",
      videoId: id,
      platform:
        typeof videoToDelete.source === "string"
          ? videoToDelete.source.toLowerCase()
          : null,
      payload: {
        reason,
        videoTitle: videoToDelete.title,
        fileSizeBytes,
      },
    });
  } catch {
    // statistics is best-effort
  }
}

export type ResolvedManagedArtifacts = {
  videoPath: string | null;
  thumbnailPath: string | null;
  subtitlePaths: string[];
};

// Mirrors the resolution chains of deleteVideoFile / deleteThumbnailFile /
// deleteSubtitleFiles, but only LOCATES the managed artifacts without
// deleting anything. Used by the recycle bin (move to trash).
export function resolveExistingManagedArtifacts(
  video: import("./types").Video,
  allCollections: import("./types").Collection[]
): ResolvedManagedArtifacts {
  const artifacts: ResolvedManagedArtifacts = {
    videoPath: null,
    thumbnailPath: null,
    subtitlePaths: [],
  };

  if (isLocalManagedVideo(video)) {
    const resolved = video.videoPath
      ? resolveManagedWebPath(video.videoPath)
      : null;
    if (resolved && pathExists(resolved.absolutePath)) {
      artifacts.videoPath = resolved.absolutePath;
    } else if (video.videoFilename) {
      const matches = findVideoFilesByFilename(video.videoFilename);
      if (matches.length === 1 && pathExists(matches[0])) {
        artifacts.videoPath = matches[0];
      }
    }
    if (!artifacts.videoPath && video.videoFilename) {
      const legacy = findVideoFile(video.videoFilename, allCollections);
      if (legacy && pathExists(legacy)) {
        artifacts.videoPath = legacy;
      }
    }
  }

  if (
    video.thumbnailFilename &&
    !isThumbnailReferencedByOtherVideo(video, video.id)
  ) {
    let thumbnailPath: string | null = null;
    if (video.thumbnailPath) {
      if (video.thumbnailPath.startsWith("/videos/")) {
        const p = buildStoragePath(
          VIDEOS_DIR,
          video.thumbnailPath.replace(/^\/videos\//, "")
        );
        if (pathExists(p)) thumbnailPath = p;
      } else if (video.thumbnailPath.startsWith("/images/")) {
        const p = buildStoragePath(
          UPLOADS_DIR,
          video.thumbnailPath.replace(/^\//, "")
        );
        if (pathExists(p)) thumbnailPath = p;
      }
    }
    if ((!thumbnailPath || !pathExists(thumbnailPath)) && video.videoFilename) {
      const videoPath = findVideoFile(video.videoFilename, allCollections);
      if (videoPath) {
        const p = buildStoragePath(
          path.dirname(videoPath),
          video.thumbnailFilename
        );
        if (pathExists(p)) thumbnailPath = p;
      }
    }
    if ((!thumbnailPath || !pathExists(thumbnailPath)) && video.thumbnailFilename) {
      const p = findImageFile(video.thumbnailFilename, allCollections);
      if (p && pathExists(p)) thumbnailPath = p;
    }
    artifacts.thumbnailPath = thumbnailPath;
  }

  if (video.subtitles && video.subtitles.length > 0) {
    for (const subtitle of video.subtitles) {
      let subtitlePath =
        subtitle.path && typeof subtitle.path === "string"
          ? resolveManagedWebPath(subtitle.path)?.absolutePath ?? null
          : null;

      if ((!subtitlePath || !pathExists(subtitlePath)) && video.videoFilename) {
        const videoPath = findVideoFile(video.videoFilename, allCollections);
        if (videoPath) {
          const p = buildStoragePath(
            path.dirname(videoPath),
            subtitle.filename
          );
          if (pathExists(p)) subtitlePath = p;
        }
      }

      if ((!subtitlePath || !pathExists(subtitlePath)) && subtitle.filename) {
        const p = buildStoragePath(SUBTITLES_DIR, subtitle.filename);
        if (pathExists(p)) subtitlePath = p;
      }

      if (subtitlePath && pathExists(subtitlePath)) {
        artifacts.subtitlePaths.push(subtitlePath);
      }
    }
  }

  return artifacts;
}

export type TrashMove = { from: string; to: string };

// Moves the video's managed artifacts into the trash directory and records a
// video_trash row. Returns the trash entry id, or null when there was
// nothing on disk to move (the caller then falls back to permanent delete).
export function moveToTrash(
  video: import("./types").Video,
  allCollections: import("./types").Collection[]
): string | null {
  const artifacts = resolveExistingManagedArtifacts(video, allCollections);
  const moves: TrashMove[] = [];
  const entryId = randomUUID();
  const entryDir = path.join(TRASH_DIR, entryId);

  const targets: Array<[string | null, string]> = [
    [artifacts.videoPath, "video"],
    [artifacts.thumbnailPath, "thumbnail"],
    ...artifacts.subtitlePaths.map(
      (p, index) => [p, `subtitle-${index}`] as [string, string]
    ),
  ];

  fs.mkdirSync(entryDir, { recursive: true });
  for (const [from, kind] of targets) {
    if (!from || !pathExists(from)) continue;
    const to = path.join(entryDir, kind + path.extname(from));
    fs.renameSync(from, to);
    moves.push({ from, to });
  }

  if (moves.length === 0) {
    fs.rmdirSync(entryDir, { recursive: true });
    return null;
  }

  try {
    db.insert(videoTrash)
      .values({
        id: entryId,
        videoId: video.id,
        title: video.title,
        payload: JSON.stringify(video),
        files: JSON.stringify(moves),
        deletedAt: Date.now(),
      })
      .run();
  } catch (error) {
    // Roll the files back out of the trash so nothing is lost.
    for (const move of moves) {
      try {
        fs.mkdirSync(path.dirname(move.from), { recursive: true });
        fs.renameSync(move.to, move.from);
      } catch {
        /* best effort rollback */
      }
    }
    fs.rmSync(entryDir, { recursive: true, force: true });
    throw new DatabaseError(
      `Failed to record trash entry for video: ${video.id}`,
      error instanceof Error ? error : new Error(String(error)),
      "moveToTrash"
    );
  }

  logger.info(
    `Video moved to recycle bin: ${video.title} (trash entry ${entryId}, ${moves.length} file(s))`
  );
  return entryId;
}

function isLocalManagedVideo(
  video: import("./types").Video
): boolean {
  return !video.videoPath || video.videoPath.startsWith("/videos/");
}

export function isThumbnailReferencedByOtherVideo(
  video: import("./types").Video,
  exceptionId: string
): boolean {
  if (!video.thumbnailFilename && !video.thumbnailPath) {
    return false;
  }

  const allVideos = getVideos();

  return allVideos.some((candidate) => {
    if (candidate.id === exceptionId) {
      return false;
    }

    if (video.thumbnailPath && candidate.thumbnailPath === video.thumbnailPath) {
      return true;
    }

    return Boolean(
      video.thumbnailFilename &&
        candidate.thumbnailFilename === video.thumbnailFilename &&
        (!video.thumbnailPath ||
          !candidate.thumbnailPath ||
          candidate.thumbnailPath === video.thumbnailPath)
    );
  });
}

function deleteVideoFile(
  video: import("./types").Video,
  allCollections: import("./types").Collection[]
): void {
  if (!isLocalManagedVideo(video)) {
    return;
  }

  // Prefer videoPath so a templated nested path (e.g.
  // /videos/Channel/Season 2026/file.mp4) resolves to its real on-disk
  // location. Once template subdirectories are enabled identical basenames
  // can exist in different folders, and findVideoFile() (basename-only
  // lookup) could match the wrong file or miss the intended one entirely.
  const resolved = video.videoPath ? resolveManagedWebPath(video.videoPath) : null;
  if (resolved) {
    if (deleteLocalVideoPath(resolved.absolutePath, resolved.rootDir)) {
      return;
    }

    if (video.videoFilename) {
      const fallbackPath = findUnambiguousVideoFileFallback(video.videoFilename);
      if (fallbackPath) {
        deleteLocalVideoPath(fallbackPath, VIDEOS_DIR);
      }
    }
    return;
  }

  // Legacy fallback: only basename available (older rows pre-feature).
  if (video.videoFilename) {
    const actualPath = findVideoFile(video.videoFilename, allCollections);
    if (actualPath) {
      deleteLocalVideoPath(actualPath, VIDEOS_DIR);
    }
  }
}

function deleteLocalVideoPath(absolutePath: string, rootDir: string): boolean {
  if (!pathExists(absolutePath)) {
    return false;
  }

  removeFileIfExists(absolutePath);
  removeEmptyDirectoryChain(path.dirname(absolutePath), rootDir);
  return true;
}

function findUnambiguousVideoFileFallback(filename: string): string | null {
  const matches = findVideoFilesByFilename(filename);
  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    logger.warn(
      `Skipping stale-path video deletion because filename is ambiguous: ${filename}`,
      { matches }
    );
  }

  return null;
}

function deleteThumbnailFile(
  video: import("./types").Video,
  allCollections: import("./types").Collection[]
): void {
  if (video.thumbnailFilename) {
    const canUseLocalFallbacks = isLocalManagedVideo(video);
    let thumbnailPath: string | null = null;

    // Determine the actual file path based on thumbnailPath
    if (video.thumbnailPath) {
      if (video.thumbnailPath.startsWith("/videos/")) {
        // Thumbnail is stored alongside video file
        thumbnailPath = buildStoragePath(
          VIDEOS_DIR,
          video.thumbnailPath.replace(/^\/videos\//, "")
        );
      } else if (video.thumbnailPath.startsWith("/images/")) {
        // Thumbnail is in images directory (may be in collection subdirectory)
        thumbnailPath = buildStoragePath(
          UPLOADS_DIR,
          video.thumbnailPath.replace(/^\//, "")
        );
      }
    }

    // Fallback: try to find by filename if path-based lookup fails
    // nosemgrep: javascript.pathtraversal.rule-non-literal-fs-filename
    if (
      canUseLocalFallbacks &&
      (!thumbnailPath || !pathExists(thumbnailPath))
    ) {
      // Try alongside video file (when moveThumbnailsToVideoFolder is enabled)
      if (video.videoFilename) {
        const videoPath = findVideoFile(video.videoFilename, allCollections);
        if (videoPath) {
          const videoDir = path.dirname(videoPath);
          thumbnailPath = buildStoragePath(videoDir, video.thumbnailFilename);
          if (!pathExists(thumbnailPath)) {
            thumbnailPath = null;
          }
        }
      }
    }

    // Final fallback: try standard image locations
    if (
      canUseLocalFallbacks &&
      (!thumbnailPath || !pathExists(thumbnailPath))
    ) {
      thumbnailPath = findImageFile(video.thumbnailFilename, allCollections);
    }

    // Delete the thumbnail file if it exists
    if (thumbnailPath && pathExists(thumbnailPath)) {
      if (isThumbnailReferencedByOtherVideo(video, video.id)) {
        logger.info(
          `Skipping thumbnail deletion - another video still references it: ${thumbnailPath}`
        );
        return;
      }

      try {
        const thumbnailWebPath =
          resolveManagedThumbnailWebPathFromAbsolutePath(thumbnailPath) ||
          video.thumbnailPath ||
          null;
        removeFileIfExists(thumbnailPath);
        deleteSmallThumbnailMirrorSync(thumbnailWebPath);
        pruneManagedArtifactParentDirectories(thumbnailPath);
        logger.info(`Deleted thumbnail file: ${thumbnailPath}`);
      } catch (error) {
        logger.error(
          `Error deleting thumbnail file ${thumbnailPath}`,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
  }
}

function deleteAuthorAvatarIfNeeded(
  video: import("./types").Video,
  exceptionId: string
): void {
  if (video.authorAvatarFilename && video.author) {
    // Check if there are other videos from the same author
    const allVideos = getVideos();
    const otherVideosFromAuthor = allVideos.filter(
      (v) => v.id !== exceptionId && v.author === video.author
    );

    // Only delete avatar if this is the last video from this author
    if (otherVideosFromAuthor.length === 0) {
      let avatarPath: string | null = null;

      // Determine the actual file path based on authorAvatarPath
      if (video.authorAvatarPath) {
        if (video.authorAvatarPath.startsWith("/avatars/")) {
          // Avatar is in avatars directory
          avatarPath = buildStoragePath(
            UPLOADS_DIR,
            video.authorAvatarPath.replace(/^\//, "")
          );
        } else if (video.authorAvatarPath.startsWith("/images/")) {
          // Legacy: Avatar might be in images directory (for backward compatibility)
          avatarPath = buildStoragePath(
            UPLOADS_DIR,
            video.authorAvatarPath.replace(/^\//, "")
          );
        }
      }

      // Fallback: try to find by filename in avatars directory
      // nosemgrep: javascript.pathtraversal.rule-non-literal-fs-filename
      if (!avatarPath || !pathExists(avatarPath)) {
        const fallbackPath = buildStoragePath(
          AVATARS_DIR,
          video.authorAvatarFilename
        );
        if (pathExists(fallbackPath)) {
          avatarPath = fallbackPath;
        }
      }

      // Delete the avatar file if it exists
      if (avatarPath && pathExists(avatarPath)) {
        try {
          removeFileIfExists(avatarPath);
          removeEmptyDirectoryChain(path.dirname(avatarPath), AVATARS_DIR);
          logger.info(`Deleted author avatar file: ${avatarPath}`);
        } catch (error) {
          logger.error(
            `Error deleting author avatar file ${avatarPath}`,
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
    } else {
      logger.info(
        `Skipping avatar deletion - ${otherVideosFromAuthor.length} other video(s) from author "${video.author}" still exist`
      );
    }
  }
}

function deleteSubtitleFiles(
  video: import("./types").Video,
  allCollections: import("./types").Collection[]
): void {
  if (video.subtitles && video.subtitles.length > 0) {
    const canUseLocalFallbacks = isLocalManagedVideo(video);
    for (const subtitle of video.subtitles) {
      let subtitlePath =
        subtitle.path && typeof subtitle.path === "string"
          ? resolveManagedWebPath(subtitle.path)?.absolutePath ?? null
          : null;

      // Fallback: try to find by filename if path-based lookup fails
      // nosemgrep: javascript.pathtraversal.rule-non-literal-fs-filename
      if (
        canUseLocalFallbacks &&
        (!subtitlePath || !pathExists(subtitlePath))
      ) {
        // Try root subtitles directory
        subtitlePath = buildStoragePath(SUBTITLES_DIR, subtitle.filename);
        if (!pathExists(subtitlePath)) {
          // Try alongside video file
          if (video.videoFilename) {
            const videoPath = findVideoFile(
              video.videoFilename,
              allCollections
            );
            if (videoPath) {
              const videoDir = path.dirname(videoPath);
              subtitlePath = buildStoragePath(videoDir, subtitle.filename);
            }
          }
        }
      }

      // Delete the subtitle file if it exists
      if (subtitlePath && pathExists(subtitlePath)) {
        try {
          removeFileIfExists(subtitlePath);
          pruneManagedArtifactParentDirectories(subtitlePath);
          logger.info(`Deleted subtitle file: ${subtitlePath}`);
        } catch (error) {
          logger.error(
            `Error deleting subtitle file ${subtitlePath}`,
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
    }
  }
}

function pruneManagedArtifactParentDirectories(absolutePath: string): void {
  if (absolutePath.startsWith(VIDEOS_DIR + path.sep)) {
    removeEmptyDirectoryChain(path.dirname(absolutePath), VIDEOS_DIR);
    return;
  }

  if (absolutePath.startsWith(IMAGES_DIR + path.sep)) {
    removeEmptyDirectoryChain(path.dirname(absolutePath), IMAGES_DIR);
    return;
  }

  if (absolutePath.startsWith(SUBTITLES_DIR + path.sep)) {
    removeEmptyDirectoryChain(path.dirname(absolutePath), SUBTITLES_DIR);
    return;
  }
}
