import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/paths", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TRASH_DIR: "/data/uploads/.trash",
}));

vi.mock("../../services/mediaServerExport", () => ({
  syncMediaServerArtifactsForVideo: vi.fn(),
}));

vi.mock("../../services/thumbnailMirrorService", () => ({
  deleteSmallThumbnailMirrorSync: vi.fn(),
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    renameSync: vi.fn(),
    rmSync: vi.fn(),
  },
}));

function buildChain() {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.values = vi.fn().mockReturnValue(chain);
  chain.set = vi.fn().mockReturnValue(chain);
  chain.all = vi.fn().mockReturnValue([]);
  chain.get = vi.fn().mockReturnValue(undefined);
  chain.run = vi.fn();
  return chain;
}

const dbState = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  all: vi.fn(),
}));

vi.mock("../../db", () => ({ db: dbState }));

import { syncMediaServerArtifactsForVideo } from "../../services/mediaServerExport";
import {
  listTrash,
  purgeExpiredTrash,
  purgeTrashItem,
  restoreFromTrash,
} from "../../services/storageService/videoTrash";

const trashRow = {
  id: "trash-1",
  videoId: "video-1",
  title: "Old Video",
  payload: JSON.stringify({
    id: "video-1",
    title: "Old Video",
    author: "Chan",
    fileSize: "1024",
    source: "YouTube",
    sourceUrl: "https://example.com/v1",
    thumbnailUrl: "/images/t.jpg",
  }),
  files: JSON.stringify([
    { from: "/data/uploads/videos/old.mp4", to: "/data/uploads/.trash/trash-1/video.mp4" },
    { from: "/data/uploads/videos/old.jpg", to: "/data/uploads/.trash/trash-1/thumbnail.jpg" },
  ]),
  deletedAt: 1_700_000_000_000,
};

function makeChain(...results: Array<"get" | "all" | "run">) {
  const chain = buildChain();
  for (const result of results) {
    if (result === "get") chain.get = vi.fn().mockReturnValue(trashRow);
    if (result === "all") chain.all = vi.fn().mockReturnValue([trashRow]);
  }
  return chain;
}

describe("videoTrash service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fs.existsSync as any).mockReturnValue(false);
  });

  describe("listTrash", () => {
    it("maps rows into items with expiry metadata", () => {
      const chain = makeChain("all");
      dbState.select.mockReturnValue(chain);

      const items = listTrash();

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: "trash-1",
        videoId: "video-1",
        title: "Old Video",
        author: "Chan",
        fileSize: 1024,
        deletedAt: trashRow.deletedAt,
      });
      // 7 days retention
      expect(items[0].expiresAt).toBe(trashRow.deletedAt + 7 * 86400000);
    });
  });

  describe("restoreFromTrash", () => {
    it("moves files back, re-inserts the row and re-links download tracking", () => {
      dbState.select.mockReturnValue(makeChain("get"));
      const insertChain = makeChain("run");
      dbState.insert.mockReturnValue(insertChain);
      const deleteChain = makeChain("run");
      dbState.delete.mockReturnValue(deleteChain);
      const updateChain = makeChain("run");
      dbState.update.mockReturnValue(updateChain);

      const { video } = restoreFromTrash("trash-1");

      expect(fs.renameSync).toHaveBeenCalledWith(
        "/data/uploads/.trash/trash-1/video.mp4",
        "/data/uploads/videos/old.mp4"
      );
      expect(fs.renameSync).toHaveBeenCalledWith(
        "/data/uploads/.trash/trash-1/thumbnail.jpg",
        "/data/uploads/videos/old.jpg"
      );
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ id: "video-1", title: "Old Video" })
      );
      expect(deleteChain.where).toHaveBeenCalled();
      // download tracking re-linked
      expect(updateChain.set).toHaveBeenCalledWith({
        videoId: "video-1",
        status: "exists",
        deletedAt: null,
      });
      expect(syncMediaServerArtifactsForVideo).toHaveBeenCalledWith("video-1");
      expect(video).toMatchObject({ id: "video-1" });
    });

    it("refuses the restore when a target path is occupied", () => {
      dbState.select.mockReturnValue(makeChain("get"));
      (fs.existsSync as any).mockImplementation((p: string) =>
        p === "/data/uploads/videos/old.mp4"
      );

      expect(() => restoreFromTrash("trash-1")).toThrow(
        /Restore conflict: \/data\/uploads\/videos\/old.mp4/
      );
      expect(fs.renameSync).not.toHaveBeenCalled();
    });
  });

  describe("purgeTrashItem", () => {
    it("removes the trash directory and the row", () => {
      dbState.select.mockReturnValue(makeChain("get"));
      const deleteChain = makeChain("run");
      dbState.delete.mockReturnValue(deleteChain);

      const removed = purgeTrashItem("trash-1");

      expect(removed).toBe(true);
      expect(fs.rmSync).toHaveBeenCalledWith(path.join("/data/uploads/.trash", "trash-1"), {
        recursive: true,
        force: true,
      });
      expect(deleteChain.where).toHaveBeenCalled();
    });

    it("returns false for unknown ids", () => {
      dbState.select.mockReturnValue(makeChain());

      expect(purgeTrashItem("missing")).toBe(false);
      expect(fs.rmSync).not.toHaveBeenCalled();
    });
  });

  describe("purgeExpiredTrash", () => {
    it("purges only rows past the retention window", () => {
      const oldRow = {
        ...trashRow,
        id: "old",
        deletedAt: Date.now() - 8 * 86400000,
      };
      const chain = buildChain();
      chain.all = vi.fn().mockReturnValue([oldRow]);
      dbState.select.mockReturnValue(chain);
      const deleteChain = makeChain("run");
      dbState.delete.mockReturnValue(deleteChain);

      const purged = purgeExpiredTrash();

      expect(purged).toBe(1);
      expect(fs.rmSync).toHaveBeenCalledWith(path.join("/data/uploads/.trash", "old"), {
        recursive: true,
        force: true,
      });
    });
  });
});
