import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { VIDEOS_DIR } from "../../config/paths";
import {
  adoptOrphanResumePathByTitle,
  pickAdoptableResumePath,
} from "../../services/downloadResumeAdoption";

// Redirect VIDEOS_DIR to a throwaway directory so the IO wrapper scans
// fixtures instead of the real videos folder.
vi.mock("../../config/paths", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../config/paths")>();
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "mytube-resume-adoption-"),
  );
  const videosDir = path.join(tempRoot, "videos");
  await fs.ensureDir(videosDir);
  return { ...actual, VIDEOS_DIR: videosDir };
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  createdTempDirs.push(dir);
  return dir;
}

const createdTempDirs: string[] = [];

async function writePartFile(
  dir: string,
  name: string,
  size: number,
): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, Buffer.alloc(size, 1));
  return filePath;
}

describe("pickAdoptableResumePath", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir("pick-part");
  });

  it("returns the single matching .part candidate", async () => {
    const match = await writePartFile(
      tempDir,
      "s2026e092501 - EYAN-094 上瘾的诅咒.mp4.part",
      100,
    );
    const unrelated = await writePartFile(
      tempDir,
      "s2026e092401 - Other Movie.mp4.part",
      900,
    );

    expect(
      pickAdoptableResumePath("EYAN-094 上瘾的诅咒", [unrelated, match]),
    ).toBe(match);
  });

  it("picks the largest file when multiple candidates match", async () => {
    const small = await writePartFile(
      tempDir,
      "s2026e092501 - EYAN-094 上瘾的诅咒.mp4.part",
      100,
    );
    const large = await writePartFile(
      tempDir,
      "s2026e092502 - EYAN-094 上瘾的诅咒.mp4.part",
      500,
    );

    expect(
      pickAdoptableResumePath("EYAN-094 上瘾的诅咒", [small, large]),
    ).toBe(large);
    expect(
      pickAdoptableResumePath("EYAN-094 上瘾的诅咒", [large, small]),
    ).toBe(large);
  });

  it("returns null when no candidate matches", async () => {
    const unrelated = await writePartFile(
      tempDir,
      "s2026e092401 - Other Movie.mp4.part",
      900,
    );

    expect(pickAdoptableResumePath("EYAN-094", [unrelated])).toBeNull();
    expect(pickAdoptableResumePath("EYAN-094", [])).toBeNull();
  });

  it("matches across sanitized characters via normalization", async () => {
    // Title as stored in the snapshot (raw, with punctuation and spaces) vs
    // a file name produced by filename cleaning.
    const candidate = await writePartFile(
      tempDir,
      "s2026e092501 - EYAN-094 上瘾的诅咒.mp4.part",
      100,
    );

    expect(
      pickAdoptableResumePath("E.Y.A.N 094：上瘾！的诅咒", [candidate]),
    ).toBe(candidate);
  });

  it("returns null for an empty or whitespace-only title", async () => {
    const candidate = await writePartFile(
      tempDir,
      "s2026e092501 - EYAN-094.mp4.part",
      100,
    );

    expect(pickAdoptableResumePath("", [candidate])).toBeNull();
    expect(pickAdoptableResumePath("   ", [candidate])).toBeNull();
  });
});

describe("adoptOrphanResumePathByTitle", () => {
  beforeEach(async () => {
    await fs.remove(VIDEOS_DIR);
    await fs.ensureDir(VIDEOS_DIR);
  });

  it("scans VIDEOS_DIR recursively and returns the largest match relative to VIDEOS_DIR without .part", async () => {
    await writePartFile(
      VIDEOS_DIR,
      "s2026e092501 - EYAN-094 上瘾的诅咒.mp4.part",
      100,
    );
    await fs.ensureDir(path.join(VIDEOS_DIR, "nested", "deeper"));
    await writePartFile(
      path.join(VIDEOS_DIR, "nested", "deeper"),
      "s2026e092502 - EYAN-094 上瘾的诅咒.mp4.part",
      300,
    );
    await writePartFile(VIDEOS_DIR, "unrelated.mp4.part", 5000);
    await fs.writeFile(path.join(VIDEOS_DIR, "notes.txt"), "not a part file");

    const adopted = await adoptOrphanResumePathByTitle("EYAN-094");

    expect(adopted).toBe(
      "nested/deeper/s2026e092502 - EYAN-094 上瘾的诅咒.mp4",
    );
  });

  it("returns undefined when nothing matches", async () => {
    await writePartFile(VIDEOS_DIR, "unrelated.mp4.part", 100);

    expect(await adoptOrphanResumePathByTitle("EYAN-094")).toBeUndefined();
  });

  it("returns undefined for an empty title", async () => {
    await writePartFile(
      VIDEOS_DIR,
      "s2026e092501 - EYAN-094.mp4.part",
      100,
    );

    expect(await adoptOrphanResumePathByTitle("")).toBeUndefined();
  });
});

afterAll(async () => {
  // VIDEOS_DIR lives inside a temp root created by the config/paths mock;
  // removing the mocked dir itself plus every scratch dir is enough.
  await Promise.all([
    fs.remove(VIDEOS_DIR).catch(() => {}),
    ...createdTempDirs.map((dir) => fs.remove(dir).catch(() => {})),
  ]);
});
