/**
 * ProgressTracker utility for parsing and tracking download progress
 * Centralizes progress parsing logic used across multiple downloaders
 */

import * as storageService from "../services/storageService";
import { calculateDownloadedSize, formatBytes, parseSize } from "./downloadUtils";

export interface ProgressUpdate {
  percentage: number;
  downloadedSize: string;
  totalSize: string;
  speed: string;
}

/** yt-dlp prints this line before it starts writing a new stream's file. */
const DESTINATION_MARKER = "[download] Destination: ";

/**
 * yt-dlp post-download processing lines (ffmpeg merge/remux/fixup/conversion).
 * No progress lines arrive while they run, so without this hint the UI would
 * freeze on the last percentage with no explanation.
 */
const PROCESSING_MARKER_RE =
  /\[(Merger|VideoRemuxer|VideoConvertor|ExtractAudio|Fixup)[\w ]*\]/;

/** Upper bound for the pending-line buffer so a pathological stream (no line
 * terminators) cannot grow it without bound. */
const MAX_LINE_BUFFER_LENGTH = 64 * 1024;

/**
 * Min interval between DB writes per download. yt-dlp reports a progress line
 * for every fragment across all concurrent workers (-N), so the raw line rate
 * is far higher than the UI's 2 s polling needs. The downloads table runs in
 * journal_mode=DELETE (exclusive lock per write), so unthrottled writes starve
 * every reader - including the /download-status endpoint the UI polls - and
 * freeze the whole app. Intermediate updates are simply dropped; the next
 * allowed write stores the latest value, and 100% completion always writes.
 */
const PROGRESS_WRITE_MIN_INTERVAL_MS = 700;

export class ProgressTracker {
  private downloadId?: string;

  // Trailing fragment of the last stdout chunk that did not end with a line
  // terminator. Chunks can split a line in half; only complete lines are parsed.
  private lineBuffer = "";

  // Bytes of all segments that already finished (e.g. the video stream before
  // the audio stream starts). Multi-stream downloads restart the reported
  // percentage at 0 for every new stream; carrying finished bytes keeps the
  // displayed progress monotonic across streams (and across resumed parts).
  private carriedBytes = 0;

  // Most recent total size parsed for the current segment. It is folded into
  // carriedBytes when the next "[download] Destination:" line appears.
  private lastSegmentTotalBytes = 0;

  // Whether lastSegmentTotalBytes has already been folded into carriedBytes.
  private lastSegmentCounted = false;

  // The active-download row (holding the paused snapshot on resume) is read at
  // most once, on the first byte-bearing update.
  private lazyInitDone = false;

  // Timestamp of the last DB write; intermediate progress updates between
  // writes are dropped (see PROGRESS_WRITE_MIN_INTERVAL_MS).
  private lastWriteAt = 0;

  // Current download stage reported to the UI ('merging' while yt-dlp runs
  // its post-download ffmpeg steps).
  private currentPhase?: "merging" | "downloading";

  // Throttle interval; injectable so tests can disable write coalescing.
  private writeMinIntervalMs: number;

  constructor(
    downloadId?: string,
    writeMinIntervalMs: number = PROGRESS_WRITE_MIN_INTERVAL_MS,
  ) {
    this.downloadId = downloadId;
    this.writeMinIntervalMs = writeMinIntervalMs;
  }

  /**
   * Parse yt-dlp progress output from stdout/stderr
   * Handles multiple formats:
   * - [download]  23.5% of 10.00MiB at  2.00MiB/s ETA 00:05
   * - [download] 55.8MiB of 123.45MiB at 5.67MiB/s ETA 00:12
   * - 23.5% of ~10.00MiB at 2.00MiB/s
   */
  parseYtDlpOutput(output: string): ProgressUpdate | null {
    // Try to match format with percentage: [download]  23.5% of 10.00MiB at  2.00MiB/s
    let progressMatch = output.match(
      /(\d+\.?\d*)%\s+of\s+~?\s*([~\d\w.]+)\s+at\s+([~\d\w.\/]+)/
    );

    if (progressMatch && progressMatch.length >= 4) {
      const percentage = parseFloat(progressMatch[1]);
      const totalSize = progressMatch[2].replace(/^~/, ""); // Remove ~ prefix if present
      const speed = progressMatch[3];

      // Check if the original output had ~ prefix
      const hasTilde =
        output.includes(`of ~ ${totalSize}`) ||
        output.includes(`of ~${totalSize}`);
      const formattedTotalSize = hasTilde ? `~${totalSize}` : totalSize;

      const downloadedSize = calculateDownloadedSize(
        percentage,
        formattedTotalSize
      );

      return {
        percentage,
        downloadedSize,
        totalSize: formattedTotalSize,
        speed,
      };
    }

    // Try to match format with explicit sizes: [download] 55.8MiB of 123.45MiB at 5.67MiB/s
    const progressWithSizeMatch = output.match(
      /([~\d\w.]+)\s+of\s+([~\d\w.]+)\s+at\s+([~\d\w.\/]+)/
    );

    if (progressWithSizeMatch && progressWithSizeMatch.length >= 4) {
      const downloadedSize = progressWithSizeMatch[1];
      const totalSize = progressWithSizeMatch[2];
      const speed = progressWithSizeMatch[3];

      // Calculate percentage from downloaded and total sizes
      const downloadedBytes = parseSize(downloadedSize);
      const totalBytes = parseSize(totalSize);
      const percentage = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;

      return {
        percentage,
        downloadedSize,
        totalSize,
        speed,
      };
    }

    // Try to match segment-based progress: [download] Downloading segment 5 of 10
    const segmentMatch = output.match(
      /\[download\]\s+Downloading\s+segment\s+(\d+)\s+of\s+(\d+)/
    );

    if (segmentMatch && segmentMatch.length >= 3) {
      const current = parseInt(segmentMatch[1]);
      const total = parseInt(segmentMatch[2]);
      const percentage = (current / total) * 100;

      return {
        percentage,
        downloadedSize: `${current}/${total} segments`,
        totalSize: `${total} segments`,
        speed: "0 B/s",
      };
    }

    return null;
  }

  /**
   * Update download progress in storage service.
   *
   * When previously finished segments exist (carriedBytes > 0), the raw
   * yt-dlp values only describe the CURRENT stream, so the stored progress is
   * aggregated over all finished bytes. With no carried bytes the update is
   * passed through unchanged.
   *
   * @param progress - Progress update to apply
   */
  update(progress: ProgressUpdate): void {
    if (!this.downloadId) {
      return;
    }

    const currentBytes = parseSize(progress.downloadedSize);
    const currentTotal = parseSize(progress.totalSize);

    // A line with a parseable total describes the current segment; its total
    // is folded into carriedBytes when the next segment starts. Segment-format
    // updates ("5/10 segments") parse as 0 bytes and never participate.
    // Segment tracking and carried-byte seeding must see EVERY line (only the
    // DB write below is throttled) or cross-stream totals drift.
    if (currentTotal > 0) {
      this.lastSegmentTotalBytes = currentTotal;
      this.lastSegmentCounted = false;
    }

    this.ensureCarriedBytesInitialized(currentBytes);

    const now = Date.now();
    const isFinal = progress.percentage >= 100;
    if (!isFinal && now - this.lastWriteAt < this.writeMinIntervalMs) {
      return;
    }
    this.lastWriteAt = now;

    // A progress line after a processing marker means downloading resumed
    // (e.g. the next stream/part) - clear the merging hint.
    let phase: string | undefined;
    if (this.currentPhase === "merging") {
      this.currentPhase = "downloading";
      phase = "downloading";
    }

    if (this.carriedBytes > 0 && currentTotal > 0) {
      const aggregatedBytes = this.carriedBytes + currentBytes;
      const aggregatedTotal = this.carriedBytes + currentTotal;
      const percentage = Math.min(
        100,
        Math.max(0, (aggregatedBytes / aggregatedTotal) * 100)
      );
      storageService.updateActiveDownload(this.downloadId, {
        progress: percentage,
        totalSize: formatBytes(aggregatedTotal),
        downloadedSize: formatBytes(aggregatedBytes),
        speed: progress.speed,
        phase,
      });
      return;
    }

    storageService.updateActiveDownload(this.downloadId, {
      progress: progress.percentage,
      totalSize: progress.totalSize,
      downloadedSize: progress.downloadedSize,
      speed: progress.speed,
      phase,
    });
  }

  /**
   * Parse output and update progress if valid progress data is found
   * @param output - Raw output string from download process
   */
  parseAndUpdate(output: string): void {
    this.lineBuffer += output;

    // yt-dlp rewrites the progress line with \r and terminates log lines with
    // \n; treat both as line terminators and only parse complete lines. The
    // trailing fragment stays buffered until its remainder arrives, so a chunk
    // boundary can no longer split a line into garbage halves.
    const lines = this.lineBuffer.split(/\r\n|\r|\n/);
    this.lineBuffer = lines.pop() ?? "";

    if (this.lineBuffer.length > MAX_LINE_BUFFER_LENGTH) {
      this.lineBuffer = this.lineBuffer.slice(-MAX_LINE_BUFFER_LENGTH);
    }

    for (const line of lines) {
      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    if (!line.trim()) {
      return;
    }

    if (line.includes(DESTINATION_MARKER)) {
      // A new stream begins: fold the finished previous segment's total into
      // carriedBytes exactly once.
      if (this.lastSegmentTotalBytes > 0 && !this.lastSegmentCounted) {
        this.carriedBytes += this.lastSegmentTotalBytes;
      }
      this.lastSegmentCounted = true;
    }

    if (PROCESSING_MARKER_RE.test(line) && this.currentPhase !== "merging") {
      this.currentPhase = "merging";
      if (this.downloadId) {
        // Written immediately (not throttled): it happens once per file and
        // tells the UI why the percentage stopped moving.
        storageService.updateActiveDownload(this.downloadId, {
          phase: "merging",
        });
      }
    }

    const progress = this.parseYtDlpOutput(line);
    if (progress) {
      this.update(progress);
    }
  }

  /**
   * On the first byte-bearing update, seed carriedBytes from the active row so
   * a resumed download continues from the paused snapshot's total progress.
   * Example: paused mid-second-stream with snapshot 40MiB (30MiB first stream
   * + 10MiB into the second). After resume the first progress line reports the
   * second stream only (10MiB), so carriedBytes = 40 - 10 restores the first
   * stream's 30MiB and the displayed progress stays seamless.
   */
  private ensureCarriedBytesInitialized(currentBytes: number): void {
    if (this.lazyInitDone || !this.downloadId) {
      return;
    }
    if (this.carriedBytes > 0 || currentBytes <= 0) {
      // Nothing to seed from, or the first update carries no byte info
      // (e.g. segment format) - retry on a later byte-bearing update.
      return;
    }

    this.lazyInitDone = true;

    const row = storageService.getActiveDownload(this.downloadId);
    const rowBytes = parseSize(row?.downloadedSize ?? "");
    if (rowBytes > 0) {
      this.carriedBytes = Math.max(0, rowBytes - currentBytes);
    }
  }
}
