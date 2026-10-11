import fs from "fs-extra";
import path from "path";
import { VIDEOS_DIR } from "../config/paths";
import { readdirDirentsSafe, resolveSafeChildPath } from "../utils/security";

/**
 * Keep only Unicode letters and digits, dropping every other character. The
 * download pipeline sanitizes titles when planning file names (spaces,
 * punctuation, separators etc. may be stripped or replaced), so matching the
 * raw title against a raw file name would miss. Normalizing both sides to
 * letters+digits only makes the comparison robust against that cleanup.
 */
function normalizeForTitleMatch(value: string): string {
  if (!value || typeof value !== "string") {
    return "";
  }
  const matches = value.match(/[\p{L}\p{N}]/gu);
  return matches ? matches.join("") : "";
}

/**
 * Pick the adoptable .part file among candidate absolute paths.
 *
 * A candidate matches when its base name (without the trailing ".part")
 * contains the normalized title as a substring. When several attempts left
 * multiple matching .part files for the same video, the largest file wins
 * because it holds the most downloaded bytes. Returns null when nothing
 * matches or the title is empty after normalization.
 *
 * The candidates are expected to come from a trusted traversal of VIDEOS_DIR
 * (see adoptOrphanResumePathByTitle); file sizes are read read-only.
 */
export function pickAdoptableResumePath(
  title: string,
  candidatePartPaths: string[],
): string | null {
  const normalizedTitle = normalizeForTitleMatch(title);
  if (!normalizedTitle) {
    return null;
  }

  let bestPath: string | null = null;
  let bestSize = -1;

  for (const candidate of candidatePartPaths) {
    if (!candidate || typeof candidate !== "string") {
      continue;
    }

    const baseName = path.basename(candidate);
    const withoutPartSuffix = baseName.endsWith(".part")
      ? baseName.slice(0, -".part".length)
      : baseName;
    const normalizedCandidate = normalizeForTitleMatch(withoutPartSuffix);
    if (!normalizedCandidate.includes(normalizedTitle)) {
      continue;
    }

    let size = 0;
    try {
      size = fs.statSync(candidate).size;
    } catch {
      // A candidate that cannot be stat'ed carries no bytes; it can still be
      // adopted if it is the only match.
      size = 0;
    }

    if (size > bestSize) {
      bestSize = size;
      bestPath = candidate;
    }
  }

  return bestPath;
}

/**
 * Recursively scan VIDEOS_DIR for orphan *.part files and adopt the best
 * match for the given title. This covers legacy paused downloads whose
 * snapshot stored the video title (not the output path) in `filename`, so
 * the planned path cannot be reconstructed - the .part file on disk is the
 * only remaining source of truth.
 *
 * Returns the adopted path relative to VIDEOS_DIR in posix form with the
 * ".part" suffix removed, or undefined when nothing matches. Read-only and
 * best-effort: any scan/stat error degrades to "nothing to adopt".
 */
export async function adoptOrphanResumePathByTitle(
  title: string,
): Promise<string | undefined> {
  if (!title || typeof title !== "string") {
    return undefined;
  }

  const partPaths: string[] = [];

  const scanDirectory = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdirDirentsSafe(dir, VIDEOS_DIR);
    } catch {
      // Unreadable directory - skip it, adoption is best-effort.
      return;
    }

    for (const entry of entries) {
      try {
        const fullPath = resolveSafeChildPath(dir, entry.name);
        if (entry.isDirectory()) {
          await scanDirectory(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".part")) {
          partPaths.push(fullPath);
        }
      } catch {
        // A single entry that fails the safe-path check must not abort the
        // whole scan.
      }
    }
  };

  await scanDirectory(VIDEOS_DIR);

  const adopted = pickAdoptableResumePath(title, partPaths);
  if (!adopted) {
    return undefined;
  }

  const relative = path.relative(VIDEOS_DIR, adopted);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }

  const posixRelative = relative.split(path.sep).join("/");
  return posixRelative.endsWith(".part")
    ? posixRelative.slice(0, -".part".length)
    : posixRelative;
}
