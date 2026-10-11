import { Request, Response } from 'express';
import * as fs from 'fs-extra';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempFiles } from '../../controllers/cleanupController';
import * as storageService from '../../services/storageService';

// Mock config/paths to use a temp directory
vi.mock('../../config/paths', async () => {
  const path = await import('path');
  return {
    VIDEOS_DIR: path.default.join(process.cwd(), 'src', '__tests__', 'temp_cleanup_test_videos_dir')
  };
});

import { VIDEOS_DIR } from '../../config/paths';

// Mock storageService to simulate no active downloads
vi.mock('../../services/storageService', () => ({
  getDownloadStatus: vi.fn(() => ({ activeDownloads: [], queuedDownloads: [], pausedDownloads: [] }))
}));

describe('cleanupController', () => {
  const req = {} as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn()
  } as unknown as Response;

  beforeEach(async () => {
    // Ensure test directory exists
    await fs.ensureDir(VIDEOS_DIR);
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up test directory
    if (await fs.pathExists(VIDEOS_DIR)) {
      await fs.remove(VIDEOS_DIR);
    }
  });

  it('should delete directories starting with temp_ recursively', async () => {
    // Create structure:
    // videos/
    //   temp_folder1/ (should be deleted)
    //     file.txt
    //   normal_folder/ (should stay)
    //     temp_nested/ (should be deleted per current recursive logic)
    //     normal_nested/ (should stay)
    //   video.mp4 (should stay)
    //   video.mp4.part (should be deleted)

    const tempFolder1 = path.join(VIDEOS_DIR, 'temp_folder1');
    const normalFolder = path.join(VIDEOS_DIR, 'normal_folder');
    const nestedTemp = path.join(normalFolder, 'temp_nested');
    const nestedNormal = path.join(normalFolder, 'normal_nested');
    const partFile = path.join(VIDEOS_DIR, 'video.mp4.part');
    const normalFile = path.join(VIDEOS_DIR, 'video.mp4');

    await fs.ensureDir(tempFolder1);
    await fs.writeFile(path.join(tempFolder1, 'file.txt'), 'content');
    
    await fs.ensureDir(normalFolder);
    await fs.ensureDir(nestedTemp);
    await fs.ensureDir(nestedNormal);
    
    await fs.ensureFile(partFile);
    await fs.ensureFile(normalFile);

    await cleanupTempFiles(req, res);

    expect(await fs.pathExists(tempFolder1)).toBe(false);
    expect(await fs.pathExists(normalFolder)).toBe(true);
    expect(await fs.pathExists(nestedTemp)).toBe(false);
    expect(await fs.pathExists(nestedNormal)).toBe(true);
    expect(await fs.pathExists(partFile)).toBe(false);
    expect(await fs.pathExists(normalFile)).toBe(true);
  });

  it('should protect paused download artifacts and still delete other temp files', async () => {
    (storageService.getDownloadStatus as any).mockReturnValue({
      activeDownloads: [],
      queuedDownloads: [],
      pausedDownloads: [
        {
          id: 'paused-keep',
          title: 'Paused keep',
          timestamp: 1,
          filename: 'Bilibili Video.mp4',
        },
      ],
    });

    // Protected: the bilibili resume dir keyed by download id, plus the
    // .part/.ytdl artifacts whose basename starts with the paused stem.
    const protectedTempDir = path.join(VIDEOS_DIR, 'temp_download_paused-keep');
    const protectedDirFile = path.join(protectedTempDir, 'video.m4s.part');
    const protectedPart = path.join(VIDEOS_DIR, 'Bilibili Video.mp4.part');
    const protectedIntermediatePart = path.join(VIDEOS_DIR, 'Bilibili Video.f137.mp4.part');
    const protectedYtdl = path.join(VIDEOS_DIR, 'Bilibili Video.mp4.ytdl');

    // Not protected: legacy temp dir naming and another download's partial.
    const legacyTempDir = path.join(VIDEOS_DIR, 'temp_1690000000_legacy');
    const otherPart = path.join(VIDEOS_DIR, 'Other Video.mp4.part');

    await fs.ensureDir(protectedTempDir);
    await fs.ensureFile(protectedDirFile);
    await fs.ensureFile(protectedPart);
    await fs.ensureFile(protectedIntermediatePart);
    await fs.ensureFile(protectedYtdl);
    await fs.ensureDir(legacyTempDir);
    await fs.ensureFile(otherPart);

    await cleanupTempFiles(req, res);

    expect(await fs.pathExists(protectedTempDir)).toBe(true);
    expect(await fs.pathExists(protectedDirFile)).toBe(true);
    expect(await fs.pathExists(protectedPart)).toBe(true);
    expect(await fs.pathExists(protectedIntermediatePart)).toBe(true);
    expect(await fs.pathExists(protectedYtdl)).toBe(true);
    expect(await fs.pathExists(legacyTempDir)).toBe(false);
    expect(await fs.pathExists(otherPart)).toBe(false);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ deletedCount: 2, skippedCount: 4 })
    );
  });

  it('should delete everything when there are no paused downloads', async () => {
    const tempDir = path.join(VIDEOS_DIR, 'temp_download_orphaned-id');
    const partFile = path.join(VIDEOS_DIR, 'Orphan.mp4.part');

    await fs.ensureDir(tempDir);
    await fs.ensureFile(partFile);

    await cleanupTempFiles(req, res);

    expect(await fs.pathExists(tempDir)).toBe(false);
    expect(await fs.pathExists(partFile)).toBe(false);
  });
});
