import { Request, Response } from "express";
import { NotFoundError, ValidationError } from "../errors/DownloadErrors";
import * as storageService from "../services/storageService";
import { Collection } from "../services/storageService";
import { getStringParam } from "../utils/paramUtils";
import { successMessage } from "../utils/response";

/**
 * Get all collections
 * Errors are automatically handled by asyncHandler middleware
 * Note: Returns array directly for backward compatibility with frontend
 */
export const getCollections = async (
  _req: Request,
  res: Response
): Promise<void> => {
  const collections = storageService.getCollections();
  // Return array directly for backward compatibility (frontend expects response.data to be Collection[])
  res.json(collections);
};

/**
 * Create a new collection
 * Errors are automatically handled by asyncHandler middleware
 * Note: Returns collection object directly for backward compatibility with frontend
 */
export const createCollection = async (
  req: Request,
  res: Response
): Promise<void> => {
  const { name, videoId } = req.body;

  if (!name) {
    throw new ValidationError("Collection name is required", "name");
  }

  // Create a new collection
  const newCollection: Collection = {
    id: Date.now().toString(),
    name,
    videos: [], // Initialize with empty videos
    origin: "manual",
    createdAt: new Date().toISOString(),
    title: name, // Ensure title is also set as it's required by the interface
  };

  // Save the new collection
  storageService.saveCollection(newCollection);

  // If videoId is provided, add it as an additional collection membership
  if (videoId) {
    const updatedCollection = storageService.addVideoToCollection(
      newCollection.id,
      videoId,
      { moveFiles: false }
    );
    if (updatedCollection) {
      // Return collection object directly for backward compatibility
      res.status(201).json(updatedCollection);
      return;
    }
  }

  // Return collection object directly for backward compatibility
  res.status(201).json(newCollection);
};

/**
 * Update a collection
 * Errors are automatically handled by asyncHandler middleware
 * Note: Returns collection object directly for backward compatibility with frontend
 */
export const updateCollection = async (
  req: Request,
  res: Response
): Promise<void> => {
  const id = getStringParam(req.params.id) ?? "";
  const { name, videoId, action } = req.body;

  let updatedCollection: Collection | null | undefined;

  // Handle name update first
  if (name) {
    updatedCollection = storageService.renameCollection(id, name);
  }

  // Handle video add/remove
  if (videoId) {
    if (action === "add") {
      updatedCollection = storageService.addVideoToCollection(id, videoId, {
        moveFiles: false,
      });
    } else if (action === "remove") {
      updatedCollection = storageService.removeVideoFromCollection(id, videoId, {
        moveFiles: false,
      });
    }
  }

  // If no changes requested but id exists, return current collection
  if (!name && !videoId) {
    updatedCollection = storageService.getCollectionById(id);
  }

  if (!updatedCollection) {
    throw new NotFoundError("Collection", id);
  }

  // Return collection object directly for backward compatibility
  res.json(updatedCollection);
};

/**
 * Delete a collection
 * Errors are automatically handled by asyncHandler middleware
 */
export const deleteCollection = async (
  req: Request,
  res: Response
): Promise<void> => {
  const id = getStringParam(req.params.id) ?? "";
  const deleteVideos = getStringParam(req.query.deleteVideos);

  let success = false;

  // If deleteVideos is true, delete all videos in the collection first
  if (deleteVideos === "true") {
    success = storageService.deleteCollectionAndVideos(id);
  } else {
    // Default: Move files back to root/other, then delete collection
    success = storageService.deleteCollectionWithFiles(id);
  }

  if (!success) {
    throw new NotFoundError("Collection", id);
  }

  res.json(successMessage("Collection deleted successfully"));
};

/**
 * Move multiple videos into this collection, removing them from every other
 * collection they currently belong to (files follow the video per the
 * author-organization settings). Body: { videoIds: string[] }
 */
export const moveVideosToCollection = async (
  req: Request,
  res: Response
): Promise<void> => {
  const id = getStringParam(req.params.id) ?? "";
  const collection = storageService.getCollectionById(id);
  if (!collection) {
    throw new NotFoundError("Collection", id);
  }

  const rawVideoIds = req.body?.videoIds;
  const videoIds = Array.isArray(rawVideoIds)
    ? rawVideoIds.map((videoId: unknown) => String(videoId)).filter(Boolean)
    : [];
  if (videoIds.length === 0) {
    throw new ValidationError("videoIds must be a non-empty array");
  }

  let moved = 0;
  for (const videoId of videoIds) {
    if (!storageService.getVideoById(videoId)) {
      continue;
    }
    const updated = storageService.moveVideoToExclusiveCollection(
      id,
      videoId
    );
    if (updated) {
      moved += 1;
    }
  }

  res.json(
    successMessage(
      `Moved ${moved} video(s) into "${collection.name || collection.title}"`
    )
  );
};

const COLLECTION_NUMERIC_SUFFIX_PATTERN = /\s+\(\d+\)\s*$/;

const stripNumericSuffix = (name: string): string =>
  (name || "").replace(COLLECTION_NUMERIC_SUFFIX_PATTERN, "").trim();

/**
 * Merge duplicate collections whose names differ only by a trailing " (n)"
 * counter (e.g. "合集", "合集 (1)", "合集 (2)") into the oldest unsuffixed
 * one. Videos keep their files (moved to the kept collection's folder).
 */
export const mergeDuplicateCollections = async (
  _req: Request,
  res: Response
): Promise<void> => {
  const collections = storageService.getCollections();
  const groups = new Map<string, Collection[]>();

  for (const collection of collections) {
    const baseName = stripNumericSuffix(collection.name || collection.title || "");
    const bucket = groups.get(baseName);
    if (bucket) {
      bucket.push(collection);
    } else {
      groups.set(baseName, [collection]);
    }
  }

  const merged: Array<{ from: string; into: string; movedVideos: number }> = [];
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const sorted = [...group].sort((a, b) => {
      const aSuffixed = COLLECTION_NUMERIC_SUFFIX_PATTERN.test(a.name || "");
      const bSuffixed = COLLECTION_NUMERIC_SUFFIX_PATTERN.test(b.name || "");
      if (aSuffixed !== bSuffixed) {
        return aSuffixed ? 1 : -1; // keep the unsuffixed original
      }
      return (a.createdAt || "").localeCompare(b.createdAt || "");
    });
    const keeper = sorted[0];

    for (const duplicate of sorted.slice(1)) {
      let movedVideos = 0;
      for (const videoId of [...duplicate.videos]) {
        const updated = storageService.moveVideoToExclusiveCollection(
          keeper.id,
          videoId
        );
        if (updated) {
          movedVideos += 1;
        }
      }
      storageService.deleteCollection(duplicate.id);
      merged.push({
        from: duplicate.name || duplicate.title || duplicate.id,
        into: keeper.name || keeper.title || keeper.id,
        movedVideos,
      });
    }
  }

  res.json({
    success: true,
    message:
      merged.length > 0
        ? `Merged ${merged.length} duplicate collection(s)`
        : "No duplicate collections found",
    merged,
  });
};
