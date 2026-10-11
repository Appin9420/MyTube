import path from "path";
import { IMAGES_DIR, VIDEOS_DIR } from "../../../config/paths";
import { resolveResumableVideoPath } from "../../../utils/downloadUtils";
import { formatVideoFilename } from "../../../utils/helpers";
import { logger } from "../../../utils/logger";
import {
  ensureDirSafeSync,
  pathExistsSafeSync,
  resolveSafeChildPath,
} from "../../../utils/security";
import {
  applyDedupeToRelatedPaths,
  dedupeRelativePath,
} from "../../filenameTemplate/dedupe";
import { planVideoOutputPaths } from "../../filenameTemplate/renderer";
import { enrichSourceOptionsForDownload } from "../../filenameTemplate/sourceOptions";
import {
  FilenameTemplateContext,
  FilenameTemplateSourceOptions,
} from "../../filenameTemplate/types";

function stripTrailingExtension(value: string, extension: string): string {
  return value.endsWith(extension) ? value.slice(0, -extension.length) : value;
}

/**
 * Strip the final file extension from a (posix-style) path or filename,
 * e.g. "dir/Show - Title.mp4" -> "dir/Show - Title". A dot is only treated
 * as an extension separator when it sits inside the final path segment and
 * is not a leading dot.
 */
function stripLastExtension(value: string): string {
  const dotIndex = value.lastIndexOf(".");
  const slashIndex = value.lastIndexOf("/");
  return dotIndex > slashIndex && dotIndex > 0 ? value.slice(0, dotIndex) : value;
}

export interface MissAvOutputPaths {
  finalVideoFilename: string;
  finalThumbnailFilename: string;
  newVideoPath: string;
  newThumbnailPath: string;
  finalVideoWebPath: string;
  finalThumbnailWebPath: string | null;
}

/**
 * Compute the on-disk and web paths for a MissAV download, honoring the
 * configured filename preset (template planner vs. legacy formatter) and
 * deduplicating against existing files. Creates the destination directories.
 */
export function planMissAvOutputPaths(
  settings: ReturnType<typeof import("../../storageService").getSettings>,
  params: {
    videoTitle: string;
    videoAuthor: string;
    videoDate: string;
    url: string;
    mergeOutputFormat: string;
    filenameTemplateSourceOptions?: FilenameTemplateSourceOptions;
    resumeRelativePath?: string;
  },
): MissAvOutputPaths {
  const {
    videoTitle,
    videoAuthor,
    videoDate,
    url,
    mergeOutputFormat,
    filenameTemplateSourceOptions,
    resumeRelativePath,
  } = params;

  const moveThumbnailsToVideoFolder =
    settings.moveThumbnailsToVideoFolder || false;
  const presetId = settings.downloadFilenamePresetId || "legacy";

  let finalVideoFilename: string;
  let finalThumbnailFilename: string;
  let newVideoPath: string;
  let newThumbnailPath: string;
  let finalVideoWebPath: string;
  let finalThumbnailWebPath: string | null;

  // Resume fast-path: a paused snapshot stored this output path and yt-dlp
  // resume artifacts (.part/.ytdl or the final file) still exist on disk, so
  // the path must be reused verbatim. The planner and dedupe below MUST be
  // skipped: the episode counter in season-style templates increments on
  // every planning call, so re-planning would drift the filename and yt-dlp
  // would no longer find the old .part/.ytdl artifacts — restarting from zero.
  const resumed = resolveResumableVideoPath(resumeRelativePath);
  if (resumed) {
    finalVideoFilename = path.basename(resumed);
    newVideoPath = resumed;
    finalThumbnailFilename = `${stripLastExtension(finalVideoFilename)}.jpg`;

    const videoRelPosix = path
      .relative(VIDEOS_DIR, newVideoPath)
      .split(path.sep)
      .join("/");
    const thumbRelPosix = `${stripLastExtension(videoRelPosix)}.jpg`;

    const thumbnailDir = moveThumbnailsToVideoFolder ? VIDEOS_DIR : IMAGES_DIR;
    newThumbnailPath = resolveSafeChildPath(thumbnailDir, thumbRelPosix);
    finalVideoWebPath = `/videos/${videoRelPosix}`;
    finalThumbnailWebPath = moveThumbnailsToVideoFolder
      ? `/videos/${thumbRelPosix}`
      : `/images/${thumbRelPosix}`;

    ensureDirSafeSync(path.dirname(newVideoPath), VIDEOS_DIR);
    ensureDirSafeSync(path.dirname(newThumbnailPath), [IMAGES_DIR, VIDEOS_DIR]);

    logger.info(
      `Resuming download at existing output path: ${videoRelPosix}`,
    );

    return {
      finalVideoFilename,
      finalThumbnailFilename,
      newVideoPath,
      newThumbnailPath,
      finalVideoWebPath,
      finalThumbnailWebPath,
    };
  }

  if (presetId !== "legacy") {
    // Non-legacy: use path planner
    const uploadDateClean = videoDate.replace(/[^0-9]/g, "").slice(0, 8);
    const year = uploadDateClean.length >= 4 ? uploadDateClean.slice(0, 4) : String(new Date().getFullYear());
    const month = uploadDateClean.length >= 6 ? uploadDateClean.slice(4, 6) : String(new Date().getMonth() + 1).padStart(2, "0");
    const day = uploadDateClean.length >= 8 ? uploadDateClean.slice(6, 8) : String(new Date().getDate()).padStart(2, "0");

    const srcOpts = enrichSourceOptionsForDownload(
      filenameTemplateSourceOptions || {},
      {
        author: videoAuthor,
        uploadDate: videoDate,
      }
    );
    const ctx: FilenameTemplateContext = {
      title: videoTitle,
      id: "",
      ext: "",
      uploader: videoAuthor,
      channel: videoAuthor,
      uploadDate: uploadDateClean,
      uploadYear: year,
      uploadMonth: month,
      uploadDay: day,
      durationSeconds: undefined,
      durationString: "00-00",
      artistName: videoAuthor,
      sourceCustomName: srcOpts.sourceCustomName || videoAuthor,
      sourceCollectionName: srcOpts.sourceCollectionName || videoAuthor,
      sourceCollectionId: srcOpts.sourceCollectionId || "",
      sourceCollectionType: srcOpts.sourceCollectionType || "single",
      mediaPlaylistIndex: srcOpts.mediaPlaylistIndex,
      mediaPlaylistIndexWithinDate: srcOpts.mediaPlaylistIndexWithinDate,
      platform: "missav",
      sourceUrl: url,
    };

    const planned = planVideoOutputPaths({
      settings,
      context: ctx,
      videoExtension: mergeOutputFormat,
      thumbnailExtension: "jpg",
      moveThumbnailsToVideoFolder,
      moveSubtitlesToVideoFolder: settings.moveSubtitlesToVideoFolder || false,
    });

    const reserved = new Set<string>();
    const deduped = dedupeRelativePath(planned.video.relativePath, VIDEOS_DIR, reserved);
    const { thumbnail: dedupedThumb } = applyDedupeToRelatedPaths(
      planned.video.relativePath,
      deduped,
      planned.thumbnail.relativePath,
      planned.subtitle.baseNameWithoutLanguageOrExt,
    );

    finalVideoFilename = path.basename(deduped);
    newVideoPath = resolveSafeChildPath(VIDEOS_DIR, deduped);
    finalThumbnailFilename = path.basename(dedupedThumb);
    finalVideoWebPath = `/videos/${deduped}`;

    const thumbnailDir = moveThumbnailsToVideoFolder ? VIDEOS_DIR : IMAGES_DIR;
    newThumbnailPath = resolveSafeChildPath(thumbnailDir, dedupedThumb);
    finalThumbnailWebPath = moveThumbnailsToVideoFolder
      ? `/videos/${dedupedThumb}`
      : `/images/${dedupedThumb}`;

    ensureDirSafeSync(path.dirname(newVideoPath), VIDEOS_DIR);
    ensureDirSafeSync(path.dirname(newThumbnailPath), [IMAGES_DIR, VIDEOS_DIR]);
  } else {
    // Legacy mode: use formatVideoFilename
    const newSafeBaseFilename = formatVideoFilename(videoTitle, videoAuthor, videoDate);
    const newVideoFilename = `${newSafeBaseFilename}.${mergeOutputFormat}`;
    const newThumbnailFilename = `${newSafeBaseFilename}.jpg`;

    finalVideoFilename = newVideoFilename;
    finalThumbnailFilename = newThumbnailFilename;
    newVideoPath = resolveSafeChildPath(VIDEOS_DIR, finalVideoFilename);

    const thumbnailDir = moveThumbnailsToVideoFolder ? VIDEOS_DIR : IMAGES_DIR;

    // If file already exists (e.g. redownload), deduplicate the filename
    if (pathExistsSafeSync(newVideoPath, VIDEOS_DIR)) {
      let counter = 1;
      const ext = `.${mergeOutputFormat}`;
      const basePath = stripTrailingExtension(newVideoPath, ext);
      const baseName = newSafeBaseFilename;
      while (pathExistsSafeSync(`${basePath}_${counter}${ext}`, VIDEOS_DIR)) {
        counter++;
      }
      newVideoPath = `${basePath}_${counter}${ext}`;
      finalVideoFilename = `${baseName}_${counter}${ext}`;
      finalThumbnailFilename = `${baseName}_${counter}.jpg`;
      logger.info(`File exists, using deduplicated filename: ${finalVideoFilename}`);
    }

    newThumbnailPath = resolveSafeChildPath(thumbnailDir, finalThumbnailFilename);
    finalVideoWebPath = `/videos/${finalVideoFilename}`;
    finalThumbnailWebPath = moveThumbnailsToVideoFolder
      ? `/videos/${finalThumbnailFilename}`
      : `/images/${finalThumbnailFilename}`;
  }

  return {
    finalVideoFilename,
    finalThumbnailFilename,
    newVideoPath,
    newThumbnailPath,
    finalVideoWebPath,
    finalThumbnailWebPath,
  };
}
