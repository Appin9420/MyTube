import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as storageService from '../../services/storageService';
import { ProgressTracker } from '../../utils/progressTracker';

vi.mock('../../services/storageService');

describe('ProgressTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseYtDlpOutput', () => {
    it('should parse percentage-based progress', () => {
      const tracker = new ProgressTracker();
      const output = '[download]  23.5% of 10.00MiB at  2.00MiB/s ETA 00:05';

      const result = tracker.parseYtDlpOutput(output);

      expect(result).not.toBeNull();
      expect(result?.percentage).toBe(23.5);
      expect(result?.totalSize).toBe('10.00MiB');
      expect(result?.speed).toBe('2.00MiB/s');
    });

    it('should parse progress with tilde prefix', () => {
      const tracker = new ProgressTracker();
      const output = '[download]  50.0% of ~10.00MiB at  2.00MiB/s';

      const result = tracker.parseYtDlpOutput(output);

      expect(result).not.toBeNull();
      expect(result?.percentage).toBe(50.0);
      expect(result?.totalSize).toBe('~10.00MiB');
    });

    it('should parse size-based progress', () => {
      const tracker = new ProgressTracker();
      const output = '[download] 55.8MiB of 123.45MiB at 5.67MiB/s ETA 00:12';

      const result = tracker.parseYtDlpOutput(output);

      expect(result).not.toBeNull();
      expect(result?.downloadedSize).toBe('55.8MiB');
      expect(result?.totalSize).toBe('123.45MiB');
      expect(result?.speed).toBe('5.67MiB/s');
      expect(result?.percentage).toBeCloseTo(45.2, 1);
    });

    it('should parse segment-based progress', () => {
      const tracker = new ProgressTracker();
      const output = '[download] Downloading segment 5 of 10';

      const result = tracker.parseYtDlpOutput(output);

      expect(result).not.toBeNull();
      expect(result?.percentage).toBe(50);
      expect(result?.downloadedSize).toBe('5/10 segments');
      expect(result?.totalSize).toBe('10 segments');
      expect(result?.speed).toBe('0 B/s');
    });

    it('should return null for non-matching output', () => {
      const tracker = new ProgressTracker();
      const output = 'Some random text';

      const result = tracker.parseYtDlpOutput(output);

      expect(result).toBeNull();
    });

    it('should handle progress without ETA', () => {
      const tracker = new ProgressTracker();
      const output = '[download]  75.0% of 100.00MiB at  10.00MiB/s';

      const result = tracker.parseYtDlpOutput(output);

      expect(result).not.toBeNull();
      expect(result?.percentage).toBe(75.0);
    });

    it('should calculate percentage from sizes correctly', () => {
      const tracker = new ProgressTracker();
      const output = '[download] 25.0MiB of 100.0MiB at 5.0MiB/s';

      const result = tracker.parseYtDlpOutput(output);

      expect(result).not.toBeNull();
      expect(result?.percentage).toBe(25);
    });

    it('should handle zero total size gracefully', () => {
      const tracker = new ProgressTracker();
      const output = '[download] 0.0MiB of 0.0MiB at 0.0MiB/s';

      const result = tracker.parseYtDlpOutput(output);

      expect(result).not.toBeNull();
      expect(result?.percentage).toBe(0);
    });
  });

  describe('update', () => {
    it('should update download progress when downloadId is set', () => {
      (storageService.getActiveDownload as any).mockReturnValue(undefined);
    const tracker = new ProgressTracker('download-123', 0);
      const progress = {
        percentage: 50,
        downloadedSize: '50MiB',
        totalSize: '100MiB',
        speed: '5MiB/s',
      };

      tracker.update(progress);

      expect(storageService.updateActiveDownload).toHaveBeenCalledWith(
        'download-123',
        {
          progress: 50,
          totalSize: '100MiB',
          downloadedSize: '50MiB',
          speed: '5MiB/s',
        }
      );
    });

    it('should not update when downloadId is not set', () => {
      const tracker = new ProgressTracker();
      const progress = {
        percentage: 50,
        downloadedSize: '50MiB',
        totalSize: '100MiB',
        speed: '5MiB/s',
      };

      tracker.update(progress);

      expect(storageService.updateActiveDownload).not.toHaveBeenCalled();
    });
  });

  describe('parseAndUpdate', () => {
    it('should parse and update when valid progress is found', () => {
      const tracker = new ProgressTracker('download-123', 0);
      // A complete line must end with a terminator (\n or \r); without one it
      // stays in the pending-line buffer as a possible chunk-split fragment.
      const output = '[download]  50.0% of 100.00MiB at  5.00MiB/s\n';

      tracker.parseAndUpdate(output);

      expect(storageService.updateActiveDownload).toHaveBeenCalled();
    });

    it('should not update when no valid progress is found', () => {
      const tracker = new ProgressTracker('download-123', 0);
      const output = 'Some random text';

      tracker.parseAndUpdate(output);

      expect(storageService.updateActiveDownload).not.toHaveBeenCalled();
    });

    it('should not update when downloadId is not set', () => {
      const tracker = new ProgressTracker();
      const output = '[download]  50.0% of 100.00MiB at  5.00MiB/s\n';

      tracker.parseAndUpdate(output);

      expect(storageService.updateActiveDownload).not.toHaveBeenCalled();
    });

    it('buffers an unterminated trailing fragment until its remainder arrives', () => {
      const tracker = new ProgressTracker('download-123', 0);

      tracker.parseAndUpdate('[download]  50.0% of 100.00MiB at  5.00');
      expect(storageService.updateActiveDownload).not.toHaveBeenCalled();

      tracker.parseAndUpdate('MiB/s\n');
      expect(storageService.updateActiveDownload).toHaveBeenCalledTimes(1);
      expect(storageService.updateActiveDownload).toHaveBeenCalledWith(
        'download-123',
        expect.objectContaining({ progress: 50 })
      );
    });

    it('treats \\r as a line terminator like yt-dlp progress rewrites', () => {
      const tracker = new ProgressTracker('download-123', 0);
      const output =
        '[download]  10.0% of 10.00MiB at 1.00MiB/s\r[download]  20.0% of 10.00MiB at 1.00MiB/s\n';

      tracker.parseAndUpdate(output);

      expect(storageService.updateActiveDownload).toHaveBeenCalledTimes(2);
    });
  });

  describe('multi-stream aggregation', () => {
    it('aggregates a second stream on top of the finished first stream', () => {
      const tracker = new ProgressTracker('download-123', 0);
      const lines = [
        '[download] Destination: /videos/video.f137.mp4\n',
        '[download]  50.0% of 30.00MiB at  5.00MiB/s\n',
        '[download] 100.0% of 30.00MiB at  5.00MiB/s\n',
        '[download] Destination: /videos/video.f140.m4a\n',
        '[download]  25.0% of 10.00MiB at  2.00MiB/s\n',
      ];

      for (const line of lines) {
        tracker.parseAndUpdate(line);
      }

      // While the first stream runs there is nothing to carry yet: raw
      // pass-through, exactly as before this feature existed.
      expect(storageService.updateActiveDownload).toHaveBeenNthCalledWith(
        1,
        'download-123',
        expect.objectContaining({
          progress: 50,
          totalSize: '30.00MiB',
          downloadedSize: '15 MiB',
        })
      );

      // After the audio stream starts, the finished video stream's 30MiB is
      // carried: (30MiB + 2.5MiB) / (30MiB + 10MiB) = 81.25%.
      expect(storageService.updateActiveDownload).toHaveBeenLastCalledWith(
        'download-123',
        expect.objectContaining({
          progress: 81.25,
          totalSize: '40 MiB',
          downloadedSize: '32.5 MiB',
          speed: '2.00MiB/s',
        })
      );
    });

    it('keeps single-stream output pass-through when a Destination line was seen', () => {
      const tracker = new ProgressTracker('download-123', 0);

      tracker.parseAndUpdate('[download] Destination: /videos/video.mp4\n');
      tracker.parseAndUpdate('[download]  42.0% of 50.00MiB at 1.00MiB/s\n');

      expect(storageService.updateActiveDownload).toHaveBeenCalledWith(
        'download-123',
        expect.objectContaining({
          progress: 42,
          totalSize: '50.00MiB',
          downloadedSize: '21 MiB',
          speed: '1.00MiB/s',
        })
      );
    });

    it('seeds carried bytes from the paused snapshot on resume', () => {
      // The manager pre-writes the paused snapshot's totals into the active
      // row before the downloader restarts. The first line after resume only
      // describes the current (second) stream, so carried = snapshot - current.
      vi.mocked(storageService.getActiveDownload as any).mockReturnValue({
        id: 'download-123',
        downloadedSize: '40 MiB',
      });

      const tracker = new ProgressTracker('download-123', 0);
      tracker.parseAndUpdate('[download] 10.0MiB of 100.0MiB at 5.0MiB/s\n');

      // carried = 40MiB - 10MiB = 30MiB; (30MiB + 10MiB) / (30MiB + 100MiB)
      expect(storageService.updateActiveDownload).toHaveBeenCalledWith(
        'download-123',
        expect.objectContaining({
          progress: expect.closeTo(30.77, 2),
          totalSize: '130 MiB',
          downloadedSize: '40 MiB',
          speed: '5.0MiB/s',
        })
      );
    });

    it('does not aggregate segment-format progress', () => {
      vi.mocked(storageService.getActiveDownload as any).mockReturnValue({
        id: 'download-123',
        downloadedSize: '40 MiB',
      });

      const tracker = new ProgressTracker('download-123', 0);
      tracker.parseAndUpdate('[download] Downloading segment 5 of 10\n');

      // "5/10 segments" parses as 0 bytes and must pass through untouched.
      expect(storageService.updateActiveDownload).toHaveBeenCalledWith(
        'download-123',
        expect.objectContaining({
          progress: 50,
          totalSize: '10 segments',
          downloadedSize: '5/10 segments',
          speed: '0 B/s',
        })
      );
    });
  });
});


describe('ProgressTracker processing phase', () => {
  it('writes phase=merging on yt-dlp processing markers and clears it on the next progress line', () => {
    (storageService.getActiveDownload as any).mockReturnValue(undefined);
    const tracker = new ProgressTracker('download-123', 0);

    tracker.parseAndUpdate('[Merger] Merging formats into "/videos/out.mp4"\n');
    expect(storageService.updateActiveDownload).toHaveBeenCalledWith(
      'download-123',
      expect.objectContaining({ phase: 'merging' })
    );

    tracker.parseAndUpdate('[download]  12.5% of 10.00MiB at  1.00MiB/s\n');
    const calls = (storageService.updateActiveDownload as any).mock.calls;
    expect(calls[calls.length - 1][1]).toMatchObject({
      progress: 12.5,
      phase: 'downloading',
    });
  });

  it('does not write a phase for regular progress lines', () => {
    (storageService.getActiveDownload as any).mockReturnValue(undefined);
    const tracker = new ProgressTracker('download-456', 0);
    tracker.parseAndUpdate('[download]  10.0% of 10.00MiB at  1.00MiB/s\n');
    const calls = (storageService.updateActiveDownload as any).mock.calls;
    expect(calls[calls.length - 1][1].phase).toBeUndefined();
  });
});
