import {
    DownloadCancelledError,
    DownloadPausedError,
    isCancelledError,
    type DownloadCancelCallback,
    type DownloadStopReason,
} from "../errors/DownloadErrors";
import { extractSourceVideoId } from "../utils/helpers";
import { logger, sanitizeLogMessage } from "../utils/logger";
import { abortPendingShutdown, notifyDownloadSettled } from "./autoShutdownService";
import { CloudStorageService } from "./CloudStorageService";
import { createDownloadTask } from "./downloadService";
import { adoptOrphanResumePathByTitle } from "./downloadResumeAdoption";
import {
  canRestoreDetachedTask,
  parseRetryMetadata,
  requiresRetryMetadata,
  serializeRetryMetadata,
  type DownloadRetryMetadata,
} from "./downloadRetryMetadata";
import { assertDownloadsAllowed } from "./filenameTemplate/renameLockService";
import { HookService } from "./hookService";
import {
  recordEvent,
  platformFromUrl,
  normalizeSourceKind,
  normalizeSurface,
} from "./statistics";
import type {
  ActorRole,
  CanonicalSourceKind,
  StatisticsSurface,
} from "./statistics";
import type {
  DownloadHistoryItem,
  DownloadInfo,
} from "./storageService";
import * as storageService from "./storageService";

interface StatisticsAttribution {
  actorRole: ActorRole;
  surface: StatisticsSurface;
  sourceKind: CanonicalSourceKind;
  relatedEventId: string | null;
  enqueuedEventId: string | null;
}

interface DownloadTask {
  downloadFn: (registerCancel: (cancel: DownloadCancelCallback) => void) => Promise<any>;
  id: string;
  title: string;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  cancelFn?: DownloadCancelCallback;
  sourceUrl?: string;
  type?: string;
  retryMetadata?: DownloadRetryMetadata;
  cancelled?: boolean;
  cancellationFinalized?: boolean;
  cancellationRejected?: boolean;
  paused?: boolean;
  pauseFinalized?: boolean;
  // Progress state snapshotted from the paused row, reapplied to the active
  // row when the task starts again so the UI continues from where it was.
  resumeSnapshot?: {
    progress?: number;
    downloadedSize?: string;
    totalSize?: string;
    filename?: string;
  };
  statistics?: StatisticsAttribution;
}

export interface AddDownloadStatisticsOptions {
  actorRole?: ActorRole;
  surface?: StatisticsSurface | string;
  sourceKind?: CanonicalSourceKind | string;
  relatedEventId?: string | null;
  enqueuedEventId?: string | null;
}

const TASK_FAIL_HOOK_WAIT_TIMEOUT_MS = 5000;
const CANCEL_TASK_WAIT_TIMEOUT_MS = 5000;
const DEFAULT_AUTO_RETRY_TIMES = 3;
const DEFAULT_AUTO_RETRY_INTERVAL_MINUTES = 5;
const AUTO_RETRY_INTERVAL_OPTIONS = new Set([1, 5, 10, 30, 60]);
const PENDING_RETRY_STATUS = "pending_retry";
const PARTIAL_STATUS = "partial";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStructuredDownloadResult(
  value: unknown,
): value is {
  success: boolean;
  partial?: boolean;
  error?: string;
} {
  return Boolean(value) && typeof value === "object" && "success" in (value as any);
}

function getStructuredDownloadResult(
  error: unknown,
): {
  success: boolean;
  partial?: boolean;
  error?: string;
} | undefined {
  if (!error || typeof error !== "object" || !("downloadResult" in error)) {
    return undefined;
  }

  const result = (error as { downloadResult?: unknown }).downloadResult;
  return isStructuredDownloadResult(result) ? result : undefined;
}

function normalizeAutoRetryTimes(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_AUTO_RETRY_TIMES;
  }

  return Math.min(10, Math.max(1, Math.floor(numeric)));
}

function normalizeAutoRetryIntervalMinutes(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_AUTO_RETRY_INTERVAL_MINUTES;
  }

  const normalized = Math.floor(numeric);
  return AUTO_RETRY_INTERVAL_OPTIONS.has(normalized)
    ? normalized
    : DEFAULT_AUTO_RETRY_INTERVAL_MINUTES;
}

async function awaitTaskFailHook(
  context: Record<string, string | undefined>,
): Promise<void> {
  let timeoutId: NodeJS.Timeout | null = null;

  try {
    await Promise.race([
      HookService.executeHook("task_fail", context),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          console.warn(
            `task_fail hook exceeded ${TASK_FAIL_HOOK_WAIT_TIMEOUT_MS}ms; continuing task failure handling.`
          );
          resolve();
        }, TASK_FAIL_HOOK_WAIT_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.error("task_fail hook failed:", error);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function awaitTaskCancellationHook(
  taskId: string,
  cancelFn: DownloadCancelCallback,
  reason?: DownloadStopReason,
): Promise<void> {
  let timeoutId: NodeJS.Timeout | null = null;

  try {
    await Promise.race([
      Promise.resolve().then(() => cancelFn(reason)),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          console.warn(
            `Cancel hook for download ${sanitizeLogMessage(taskId)} exceeded ${CANCEL_TASK_WAIT_TIMEOUT_MS}ms; finalizing cancellation anyway.`
          );
          resolve();
        }, CANCEL_TASK_WAIT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

class DownloadManager {
  private queue: DownloadTask[];
  private activeTasks: Map<string, DownloadTask>;
  private retryTimers: Map<string, NodeJS.Timeout>;
  private activeDownloads: number;
  private maxConcurrentDownloads: number;
  // Set while the app is shutting down: stops the queue from starting new
  // tasks (or re-enqueueing paused ones) after each pause finalization.
  private shuttingDown = false;

  constructor() {
    this.queue = [];
    this.activeTasks = new Map();
    this.retryTimers = new Map();
    this.activeDownloads = 0;
    this.maxConcurrentDownloads = 3; // Default
  }

  private async loadSettings() {
    try {
      const settings = storageService.getSettings();
      if (settings.maxConcurrentDownloads) {
        this.maxConcurrentDownloads = settings.maxConcurrentDownloads;
        console.log(
          `Loaded maxConcurrentDownloads from database: ${this.maxConcurrentDownloads}`
        );
      }
    } catch (error) {
      console.error("Error loading settings in DownloadManager:", error);
    }
  }

  private createDetachedTask(
    id: string,
    title: string,
    sourceUrl: string,
    type: string,
    retryMetadata?: DownloadRetryMetadata,
    rawRetryMetadata?: string | null,
    resumeOutputPath?: string,
  ): DownloadTask | null {
    if (!canRestoreDetachedTask(type, rawRetryMetadata)) {
      return null;
    }

    return {
      // The 5th argument is only appended when defined so restore paths
      // without resume state keep producing 4-argument calls.
      downloadFn: createDownloadTask(
        type,
        sourceUrl,
        id,
        retryMetadata,
        ...(resumeOutputPath !== undefined ? [resumeOutputPath] : []),
      ),
      id,
      title,
      sourceUrl,
      type,
      retryMetadata,
      resolve: (value) =>
        console.log("Restored task completed", sanitizeLogMessage(id), value),
      reject: (error) =>
        console.error("Restored task failed", sanitizeLogMessage(id), error),
    };
  }

  private finalizeUnrestorableRetry(
    id: string,
    errorMessage: string,
  ): void {
    storageService.finalizePendingRetryHistoryItem(id, errorMessage);
  }

  private hasTask(id: string): boolean {
    return this.activeTasks.has(id) || this.queue.some((task) => task.id === id);
  }

  private enqueueTask(task: DownloadTask, persistQueue = true): void {
    if (this.shuttingDown || this.hasTask(task.id)) {
      return;
    }

    this.queue.push(task);
    if (persistQueue) {
      this.updateQueuedDownloads();
    }
    this.processQueue();
  }

  private clearRetryTimer(id: string): void {
    const timer = this.retryTimers.get(id);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.retryTimers.delete(id);
  }

  private scheduleRetryTask(
    task: DownloadTask,
    historyItem: DownloadHistoryItem,
  ): void {
    if (!task.sourceUrl || !task.type) {
      storageService.finalizePendingRetryHistoryItem(
        task.id,
        historyItem.error ?? "Retry metadata missing"
      );
      return;
    }

    this.clearRetryTimer(task.id);

    const nextRetryAt = historyItem.nextRetryAt ?? Date.now();
    const delayMs = Math.max(nextRetryAt - Date.now(), 0);
    const timer = setTimeout(() => {
      this.retryTimers.delete(task.id);

      const latestHistory =
        storageService.getDownloadHistoryItem(task.id) ?? historyItem;
      if (latestHistory.status !== PENDING_RETRY_STATUS || this.hasTask(task.id)) {
        return;
      }

      this.enqueueTask(task);
    }, delayMs);

    this.retryTimers.set(task.id, timer);
  }

  private restorePendingRetries(): void {
    const pendingRetries = storageService.getPendingRetryHistoryItems();
    if (pendingRetries.length === 0) {
      return;
    }

    for (const item of pendingRetries) {
      if (this.hasTask(item.id)) {
        continue;
      }

      if (!item.sourceUrl || !item.downloadType) {
        storageService.finalizePendingRetryHistoryItem(
          item.id,
          item.error ?? "Retry metadata missing"
        );
        continue;
      }

      if (!canRestoreDetachedTask(item.downloadType, item.retryMetadata)) {
        this.finalizeUnrestorableRetry(
          item.id,
          "Bilibili retry could not be restored after restart. Please download again.",
        );
        continue;
      }

      const retryMetadata = parseRetryMetadata(item.retryMetadata);
      const task = this.createDetachedTask(
        item.id,
        item.title,
        item.sourceUrl,
        item.downloadType,
        retryMetadata,
        item.retryMetadata,
      );
      if (!task) {
        this.finalizeUnrestorableRetry(
          item.id,
          "Bilibili retry could not be restored after restart. Please download again.",
        );
        continue;
      }
      this.scheduleRetryTask(task, item);
    }
  }

  private maybeScheduleRetry(task: DownloadTask, error: unknown): boolean {
    if (!task.sourceUrl || !task.type) {
      return false;
    }

    const settings = storageService.getSettings();
    if (settings.autoRetryEnabled !== true) {
      return false;
    }

    const existingHistory = storageService.getDownloadHistoryItem(task.id);
    const retryLimit =
      existingHistory?.retryLimit ??
      normalizeAutoRetryTimes(settings.autoRetryTimes);
    const retryIntervalMinutes =
      existingHistory?.retryIntervalMinutes ??
      normalizeAutoRetryIntervalMinutes(settings.autoRetryIntervalMinutes);
    const retryCount = existingHistory?.retryCount ?? 0;

    if (retryCount >= retryLimit) {
      return false;
    }

    const historyItem: DownloadHistoryItem = {
      id: task.id,
      title: task.title,
      finishedAt: Date.now(),
      status: PENDING_RETRY_STATUS,
      error: getErrorMessage(error),
      sourceUrl: task.sourceUrl,
      platform: platformFromUrl(task.sourceUrl),
      sourceKind: task.statistics?.sourceKind ?? existingHistory?.sourceKind ?? "unknown",
      downloadType: task.type,
      retryCount: retryCount + 1,
      retryLimit,
      retryIntervalMinutes,
      nextRetryAt: Date.now() + retryIntervalMinutes * 60 * 1000,
      retryMetadata:
        task.retryMetadata && requiresRetryMetadata(task.retryMetadata)
          ? serializeRetryMetadata(task.retryMetadata)
          : existingHistory?.retryMetadata,
    };

    storageService.addDownloadHistoryItem(historyItem);
    this.scheduleRetryTask(task, historyItem);
    return true;
  }

  /**
   * Initialize the download manager and restore queued tasks
   */
  initialize(): void {
    try {
      console.log("Initializing DownloadManager...");
      this.loadSettings();
      const status = storageService.getDownloadStatus();
      const queuedDownloads = status.queuedDownloads;

      if (queuedDownloads && queuedDownloads.length > 0) {
        console.log("Restoring queued downloads...", queuedDownloads.length);

        for (const download of queuedDownloads) {
          if (download.sourceUrl && download.type) {
            console.log(
              "Restoring task:",
              sanitizeLogMessage(download.title),
              sanitizeLogMessage(download.id),
            );

            if (!canRestoreDetachedTask(download.type, download.retryMetadata)) {
              console.warn(
                `Skipping restoration of task ${download.id} due to unrestorable Bilibili retry metadata`,
              );
              continue;
            }

            const restoredTask = this.createDetachedTask(
              download.id,
              download.title,
              download.sourceUrl,
              download.type,
              parseRetryMetadata(download.retryMetadata),
              download.retryMetadata,
            );
            if (!restoredTask) {
              console.warn(
                `Skipping restoration of task ${download.id} due to invalid retry metadata`,
              );
              continue;
            }

            // A queued row that carries a paused snapshot (a resumed task that
            // was still waiting in the queue when the app stopped) must keep
            // it across the restart, or the resume would re-plan a fresh
            // output path and re-download from zero.
            if (
              download.progress !== undefined ||
              download.filename !== undefined
            ) {
              restoredTask.resumeSnapshot = {
                progress: download.progress,
                downloadedSize: download.downloadedSize,
                totalSize: download.totalSize,
                filename: download.filename,
              };
            }

            this.queue.push(restoredTask);
          } else {
            console.warn(
              `Skipping restoration of task ${download.id} due to missing sourceUrl or type`
            );
          }
        }
      }

      this.restorePendingRetries();
      this.processQueue();
    } catch (error) {
      console.error("Error initializing DownloadManager:", error);
    }
  }

  /**
   * Set the maximum number of concurrent downloads
   * @param limit - Maximum number of concurrent downloads
   */
  setMaxConcurrentDownloads(limit: number): void {
    this.maxConcurrentDownloads = limit;
    this.processQueue();
  }

  /**
   * Add a download task to the manager
   * @param downloadFn - Async function that performs the download
   * @param id - Unique ID for the download
   * @param title - Title of the video being downloaded
   * @param sourceUrl - Source URL of the video
   * @param type - Type of the download (youtube, bilibili, missav)
   * @returns - Resolves when the download is complete
   */
  async addDownload(
    downloadFn: (registerCancel: (cancel: DownloadCancelCallback) => void) => Promise<any>,
    id: string,
    title: string,
    sourceUrl?: string,
    type?: string,
    statistics?: AddDownloadStatisticsOptions,
    retryMetadata?: DownloadRetryMetadata,
  ): Promise<any> {
    assertDownloadsAllowed();
    return new Promise((resolve, reject) => {
      const task: DownloadTask = {
        downloadFn,
        id,
        title,
        resolve,
        reject,
        sourceUrl,
        type,
        retryMetadata,
        statistics: statistics
          ? {
              actorRole: statistics.actorRole ?? "admin",
              surface: normalizeSurface(statistics.surface ?? "web"),
              sourceKind: normalizeSourceKind(statistics.sourceKind ?? "manual"),
              relatedEventId: statistics.relatedEventId ?? null,
              enqueuedEventId: statistics.enqueuedEventId ?? null,
            }
          : undefined,
      };

      this.queue.push(task);
      this.updateQueuedDownloads();
      this.processQueue();
    });
  }

  /**
   * Update the title of a download task (queued or active)
   * @param id - ID of the download
   * @param title - New title
   */
  updateTaskTitle(id: string, title: string): void {
    // Check active tasks
    const activeTask = this.activeTasks.get(id);
    if (activeTask) {
      console.log(
        "Updating active task title:",
        sanitizeLogMessage(id),
        sanitizeLogMessage(title),
      );
      activeTask.title = title;
      storageService.updateActiveDownloadTitle(id, title);
    } else {
      // Check queued tasks
      const queuedTask = this.queue.find((t) => t.id === id);
      if (queuedTask) {
        console.log(
          "Updating queued task title:",
          sanitizeLogMessage(id),
          sanitizeLogMessage(title),
        );
        queuedTask.title = title;
        this.updateQueuedDownloads();
      }
    }
  }

  /**
   * Cancel an active download
   * @param id - ID of the download to cancel
   */
  private finalizeCancelledTask(
    task: DownloadTask,
    error: DownloadCancelledError = DownloadCancelledError.create(),
  ): void {
    if (!task.cancellationFinalized) {
      task.cancellationFinalized = true;
      this.clearRetryTimer(task.id);
      storageService.removeActiveDownload(task.id);
      storageService.addDownloadHistoryItem({
        id: task.id,
        title: task.title,
        finishedAt: Date.now(),
        status: "failed",
        error: "Download cancelled by user",
        sourceUrl: task.sourceUrl,
        platform: platformFromUrl(task.sourceUrl),
        sourceKind: task.statistics?.sourceKind ?? "unknown",
        downloadType: task.type,
      });

      HookService.executeHook("task_cancel", {
        taskId: task.id,
        taskTitle: task.title,
        sourceUrl: task.sourceUrl,
        status: "cancel",
      });
    }

    if (!task.cancellationRejected) {
      task.cancellationRejected = true;
      task.reject(error);
    }

    if (this.activeTasks.has(task.id)) {
      this.activeTasks.delete(task.id);
      this.activeDownloads = Math.max(0, this.activeDownloads - 1);
      this.processQueue();
    }
  }

  async cancelDownload(id: string): Promise<void> {
    const task = this.activeTasks.get(id);
    if (task) {
      console.log(
        "Cancelling active download:",
        sanitizeLogMessage(task.title),
        sanitizeLogMessage(id),
      );
      task.cancelled = true;

      // Call the cancel function if available
      if (task.cancelFn) {
        try {
          await awaitTaskCancellationHook(
            id,
            task.cancelFn,
            "cancel",
          );
        } catch (error) {
          console.error(
            "Error calling cancel function for download:",
            sanitizeLogMessage(id),
            error,
          );
        }
      }

      this.finalizeCancelledTask(task);
    } else {
      // Check if it's in the queue and remove it
      const inQueue = this.queue.some((t) => t.id === id);
      if (inQueue) {
        console.log("Removing queued download:", sanitizeLogMessage(id));
        this.removeFromQueue(id);
        return;
      }

      const pendingRetryItem = storageService.getDownloadHistoryItem(id);
      if (pendingRetryItem?.status === PENDING_RETRY_STATUS) {
        console.log("Cancelling pending retry:", sanitizeLogMessage(id));
        this.clearRetryTimer(id);
        storageService.finalizePendingRetryHistoryItem(
          id,
          "Retry cancelled by user"
        );
        return;
      }

      const pausedItem = storageService.getPausedDownload(id);
      if (pausedItem) {
        console.log("Cancelling paused download:", sanitizeLogMessage(id));
        storageService.removePausedDownload(id);
      }
    }
  }

  private toPausedDownloadInfo(task: DownloadTask): DownloadInfo {
    // Snapshot live progress before the active row is removed so a resume
    // continues from where the download left off.
    const active = storageService.getActiveDownload(task.id);
    return {
      id: task.id,
      title: active?.title || task.title,
      timestamp: Date.now(),
      sourceUrl: task.sourceUrl,
      type: task.type,
      retryMetadata:
        task.retryMetadata && requiresRetryMetadata(task.retryMetadata)
          ? serializeRetryMetadata(task.retryMetadata)
          : undefined,
      filename: active?.filename,
      progress: active?.progress,
      downloadedSize: active?.downloadedSize,
      totalSize: active?.totalSize,
    };
  }

  /**
   * Move a task into the paused store. Idempotent and safe to race with
   * cancellation: whichever finalizes first wins, the other becomes a no-op.
   */
  private finalizePausedTask(task: DownloadTask): void {
    if (task.pauseFinalized || task.cancelled || task.cancellationFinalized) {
      return;
    }
    task.pauseFinalized = true;
    this.clearRetryTimer(task.id);

    if (this.activeTasks.get(task.id) === task) {
      this.activeTasks.delete(task.id);
      this.activeDownloads = Math.max(0, this.activeDownloads - 1);
    }

    const pausedInfo = this.toPausedDownloadInfo(task);
    storageService.removeActiveDownload(task.id);
    storageService.addPausedDownload(pausedInfo);
    console.log(
      "Download paused:",
      sanitizeLogMessage(task.title),
      sanitizeLogMessage(task.id),
    );

    if (!task.cancellationRejected) {
      task.cancellationRejected = true;
      task.reject(DownloadPausedError.create());
    }

    this.processQueue();
  }

  /**
   * Pause a download: stop it if running, or pull it out of the queue.
   * Paused tasks are persisted and can be resumed with resumeDownload.
   * @param id - ID of the download to pause
   */
  async pauseDownload(id: string): Promise<void> {
    const queuedIndex = this.queue.findIndex((task) => task.id === id);
    if (queuedIndex !== -1) {
      const [task] = this.queue.splice(queuedIndex, 1);
      console.log(
        "Pausing queued download:",
        sanitizeLogMessage(task.title),
        sanitizeLogMessage(id),
      );
      this.clearRetryTimer(id);
      storageService.addPausedDownload(this.toPausedDownloadInfo(task));
      this.updateQueuedDownloads();
      return;
    }

    const activeTask = this.activeTasks.get(id);
    if (activeTask) {
      console.log(
        "Pausing active download:",
        sanitizeLogMessage(activeTask.title),
        sanitizeLogMessage(id),
      );
      activeTask.paused = true;

      if (activeTask.cancelFn) {
        try {
          await awaitTaskCancellationHook(
            id,
            activeTask.cancelFn,
            "pause",
          );
        } catch (error) {
          console.error(
            "Error calling cancel function for pause:",
            sanitizeLogMessage(id),
            error,
          );
        }
      }

      this.finalizePausedTask(activeTask);
      return;
    }

    console.log("Pause requested but download not found:", sanitizeLogMessage(id));
  }

  /**
   * Pause every active download and stop the queue. Called during app
   * shutdown: each task runs the normal pause flow (kill the yt-dlp process,
   * keep .part/.ytdl artifacts, snapshot progress into the paused store) so
   * nothing is lost when the process exits. Queued tasks are left as-is -
   * they are persisted and restored on next startup. Safe to call twice and
   * awaited with an overall timeout by the signal handler in server.ts.
   */
  async pauseAllActiveDownloadsForShutdown(): Promise<void> {
    this.shuttingDown = true;
    const activeIds = [...this.activeTasks.keys()];
    if (activeIds.length === 0) {
      return;
    }
    console.log(
      `Shutdown: pausing ${activeIds.length} active download(s) before exit...`,
    );
    await Promise.allSettled(
      activeIds.map((id) => this.pauseDownload(id)),
    );
  }

  /**
   * Resume a paused download by recreating its task and re-enqueueing it.
   * @param id - ID of the paused download to resume
   */
  async resumeDownload(id: string): Promise<void> {
    const pausedInfo = storageService.getPausedDownload(id);
    if (!pausedInfo) {
      console.log(
        "Resume requested but paused download not found:",
        sanitizeLogMessage(id),
      );
      return;
    }

    // Check before deleting the paused row: if a task with the same id is
    // already queued or active, deleting the row would make the entry vanish
    // without ever being restored.
    if (this.hasTask(id)) {
      console.log(
        "Resume requested but download already queued or active:",
        sanitizeLogMessage(id),
      );
      return;
    }

    storageService.removePausedDownload(id);

    if (
      !pausedInfo.sourceUrl ||
      !pausedInfo.type ||
      !canRestoreDetachedTask(pausedInfo.type, pausedInfo.retryMetadata)
    ) {
      console.warn(
        `Could not resume download ${sanitizeLogMessage(id)}: missing or unrestorable download metadata`,
      );
      storageService.addDownloadHistoryItem({
        id,
        title: pausedInfo.title,
        finishedAt: Date.now(),
        status: "failed",
        error:
          "Download could not be resumed after pausing. Please download again.",
        sourceUrl: pausedInfo.sourceUrl,
        platform: platformFromUrl(pausedInfo.sourceUrl),
        sourceKind: "unknown",
        downloadType: pausedInfo.type,
      });
      return;
    }

    // New-style pause snapshots store the real planned output path (relative
    // to VIDEOS_DIR) in `filename`, which never equals the title. Legacy
    // snapshots stored the title there instead, so the path is unknown and
    // we try to adopt an orphan .part file by title before re-planning.
    // When a valid path exists it is used as-is: the downloader verifies the
    // .part file on disk and falls back to normal planning without it.
    let resumeOutputPath: string | undefined;
    if (pausedInfo.filename && pausedInfo.filename !== pausedInfo.title) {
      resumeOutputPath = pausedInfo.filename;
    } else {
      resumeOutputPath = await adoptOrphanResumePathByTitle(pausedInfo.title);
      if (resumeOutputPath) {
        console.log(
          `Adopted orphan resume artifacts for ${sanitizeLogMessage(pausedInfo.title)}: ${sanitizeLogMessage(resumeOutputPath)}`,
        );
      }
    }

    const restoredTask = this.createDetachedTask(
      pausedInfo.id,
      pausedInfo.title,
      pausedInfo.sourceUrl,
      pausedInfo.type,
      parseRetryMetadata(pausedInfo.retryMetadata),
      pausedInfo.retryMetadata,
      resumeOutputPath,
    );
    if (!restoredTask) {
      storageService.addDownloadHistoryItem({
        id,
        title: pausedInfo.title,
        finishedAt: Date.now(),
        status: "failed",
        error:
          "Download could not be resumed after pausing. Please download again.",
        sourceUrl: pausedInfo.sourceUrl,
        platform: platformFromUrl(pausedInfo.sourceUrl),
        sourceKind: "unknown",
        downloadType: pausedInfo.type,
      });
      return;
    }

    // Carry the paused snapshot into the task so processQueue can restore the
    // visible progress as soon as the active row is recreated.
    restoredTask.resumeSnapshot = {
      progress: pausedInfo.progress,
      downloadedSize: pausedInfo.downloadedSize,
      totalSize: pausedInfo.totalSize,
      filename: pausedInfo.filename,
    };

    console.log(
      "Resuming paused download:",
      sanitizeLogMessage(pausedInfo.title),
      sanitizeLogMessage(id),
    );
    this.enqueueTask(restoredTask);
  }

  /**
   * Remove a download from the queue
   * @param id - ID of the download to remove
   */
  removeFromQueue(id: string): void {
    const removedTasks = this.queue.filter((task) => task.id === id);
    this.queue = this.queue.filter((task) => task.id !== id);
    this.clearRetryTimer(id);
    const pendingRetryItem = storageService.getDownloadHistoryItem(id);
    const isPendingRetry = pendingRetryItem?.status === PENDING_RETRY_STATUS;
    if (isPendingRetry) {
      storageService.finalizePendingRetryHistoryItem(
        id,
        "Retry removed from queue by user"
      );
    }
    for (const task of removedTasks) {
      if (isPendingRetry) {
        task.reject(new Error("Retry removed from queue by user"));
      }
    }
    this.updateQueuedDownloads();
  }

  /**
   * Clear the download queue
   */
  clearQueue(): void {
    const queuedTasks = [...this.queue];
    this.queue = [];
    for (const task of queuedTasks) {
      this.clearRetryTimer(task.id);
      const pendingRetryItem = storageService.getDownloadHistoryItem(task.id);
      if (pendingRetryItem?.status === PENDING_RETRY_STATUS) {
        storageService.finalizePendingRetryHistoryItem(
          task.id,
          "Retry removed from queue by user"
        );
        task.reject(new Error("Retry removed from queue by user"));
      }
    }
    this.updateQueuedDownloads();
  }

  /**
   * Update the queued downloads in storage
   */
  private updateQueuedDownloads(): void {
    const queuedDownloads = this.queue.map((task) => ({
      id: task.id,
      title: task.title,
      timestamp: Date.now(),
      sourceUrl: task.sourceUrl,
      type: task.type,
      retryMetadata:
        task.retryMetadata && requiresRetryMetadata(task.retryMetadata)
          ? serializeRetryMetadata(task.retryMetadata)
          : undefined,
      // A resumed task keeps its paused snapshot while it waits in the queue;
      // persisting it here (instead of only in memory) means a restart cannot
      // discard the breakpoint the user is resuming onto.
      ...(task.resumeSnapshot ?? {}),
    }));
    storageService.setQueuedDownloads(queuedDownloads);
  }

  /**
   * Process the download queue
   */
  private async processQueue(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    if (
      this.activeDownloads >= this.maxConcurrentDownloads ||
      this.queue.length === 0
    ) {
      return;
    }

    const task = this.queue.shift();
    if (!task) return;

    this.updateQueuedDownloads();
    this.activeDownloads++;
    // A newly started download cancels any pending shutdown countdown
    abortPendingShutdown("new download started");
    this.activeTasks.set(task.id, task);

    // Update status in storage
    storageService.addActiveDownload(task.id, task.title);
    // Update with extra info if available
    if (task.sourceUrl || task.type) {
      storageService.updateActiveDownload(task.id, {
        sourceUrl: task.sourceUrl,
        type: task.type,
      });
    }

    // Restore the paused snapshot so the UI continues from the paused
    // progress instead of dropping to 0. Only fields that actually have a
    // value are written back.
    if (task.resumeSnapshot) {
      const snapshotUpdates: NonNullable<DownloadTask["resumeSnapshot"]> = {};
      if (task.resumeSnapshot.progress !== undefined) {
        snapshotUpdates.progress = task.resumeSnapshot.progress;
      }
      if (task.resumeSnapshot.downloadedSize !== undefined) {
        snapshotUpdates.downloadedSize = task.resumeSnapshot.downloadedSize;
      }
      if (task.resumeSnapshot.totalSize !== undefined) {
        snapshotUpdates.totalSize = task.resumeSnapshot.totalSize;
      }
      if (task.resumeSnapshot.filename !== undefined) {
        snapshotUpdates.filename = task.resumeSnapshot.filename;
      }
      if (Object.keys(snapshotUpdates).length > 0) {
        storageService.updateActiveDownload(task.id, snapshotUpdates);
      }
    }

    // download_started: pair with download_enqueued via relatedEventId so the
    // queue-wait percentile rollups can match the two without write-time joins.
    try {
      const stats = task.statistics;
      const platform = platformFromUrl(task.sourceUrl);
      recordEvent({
        eventType: "download_started",
        actorRole: stats?.actorRole ?? "system",
        surface: stats?.surface ?? "background",
        sessionId: null,
        relatedEventId: stats?.enqueuedEventId ?? stats?.relatedEventId ?? null,
        platform,
        sourceKind: stats?.sourceKind ?? "unknown",
        payload: { downloadId: task.id },
      });
    } catch {
      // statistics is best-effort
    }

    try {
      console.log(
        "Starting download:",
        sanitizeLogMessage(task.title),
        sanitizeLogMessage(task.id),
      );

      // Execute hook
      await HookService.executeHook("task_before_start", {
        taskId: task.id,
        taskTitle: task.title,
        sourceUrl: task.sourceUrl,
        status: "start",
      });

      const result = await task.downloadFn((cancel) => {
        task.cancelFn = cancel;
        // If a stop request arrived before this registration, fire the hook
        // immediately so the downloader stops on the spot instead of running
        // until the next DB checkpoint. Reason "pause" makes the downloader
        // skip .part cleanup, which is safe even for a cancel - the next DB
        // checkpoint will raise the corresponding error anyway.
        if (task.paused) {
          void Promise.resolve()
            .then(() => cancel("pause"))
            .catch((error) => console.error("Late pause hook failed:", error));
        } else if (task.cancelled) {
          void Promise.resolve()
            .then(() => cancel("cancel"))
            .catch((error) => console.error("Late cancel hook failed:", error));
        }
      });
      if (task.cancelled) {
        throw DownloadCancelledError.create();
      }
      if (task.paused) {
        throw DownloadPausedError.create();
      }

      if (isStructuredDownloadResult(result)) {
        if (result.success === false || result.partial === true) {
          throw Object.assign(
            new Error(result.error || "Download did not complete successfully"),
            { downloadResult: result },
          );
        }
      }

      // Extract video data from result
      // videoController returns { success: true, video: ... }
      // But some downloaders might return the video object directly or different structure
      const videoData = result.video || result.videoData || result;
      storageService.removeActiveDownload(task.id);

      console.log(
        "Download finished for task",
        sanitizeLogMessage(task.title),
        sanitizeLogMessage(videoData.title),
      );

      // Determine best title
      let finalTitle = videoData.title;
      const genericTitles = [
        "YouTube Video",
        "Bilibili Video",
        "MissAV Video",
        "Video",
      ];
      if (!finalTitle || genericTitles.includes(finalTitle)) {
        if (task.title && !genericTitles.includes(task.title)) {
          finalTitle = task.title;
        }
      }

      // Add to history
      if (!task.cancelled) {
        this.clearRetryTimer(task.id);
        const historySourceUrl = videoData.sourceUrl || task.sourceUrl;
        const historyTotalSize =
          typeof videoData.fileSize === "string" || typeof videoData.fileSize === "number"
            ? String(videoData.fileSize)
            : undefined;
        storageService.addDownloadHistoryItem({
          id: task.id,
          title: finalTitle || task.title,
          finishedAt: Date.now(),
          status: "success",
          videoPath: videoData.videoPath,
          thumbnailPath: videoData.thumbnailPath,
          sourceUrl: historySourceUrl,
          author: videoData.author,
          videoId: videoData.id,
          totalSize: historyTotalSize,
          platform: platformFromUrl(historySourceUrl),
          sourceKind: task.statistics?.sourceKind ?? "manual",
          downloadType: task.type,
          retryMetadata:
            task.retryMetadata && requiresRetryMetadata(task.retryMetadata)
              ? serializeRetryMetadata(task.retryMetadata)
              : undefined,
        });

        // Record video download for future duplicate detection
        const sourceUrl = videoData.sourceUrl || task.sourceUrl;
        if (sourceUrl && videoData.id) {
          const { id: sourceVideoId, platform } =
            extractSourceVideoId(sourceUrl);
          if (sourceVideoId) {
            // Check if this is a re-download of previously deleted video
            const existingRecord =
              storageService.checkVideoDownloadBySourceId(
                sourceVideoId,
                platform
              );
            if (existingRecord.found && existingRecord.status === "deleted") {
              // Update existing record
              storageService.updateVideoDownloadRecord(
                sourceVideoId,
                videoData.id,
                finalTitle || task.title,
                videoData.author,
                platform
              );
            } else if (!existingRecord.found) {
              // New download, create record
              storageService.recordVideoDownload(
                sourceVideoId,
                sourceUrl,
                platform,
                videoData.id,
                finalTitle || task.title,
                videoData.author
              );
            }
          }
        }
      }



      // Execute hook - Await this so user script can process local file before cloud upload/delete
      await HookService.executeHook("task_success", {
        taskId: task.id,
        taskTitle: finalTitle || task.title,
        sourceUrl: task.sourceUrl,
        status: "success",
        videoPath: videoData.videoPath,
        thumbnailPath: videoData.thumbnailPath,
      });

      import("./telegramService").then(({ TelegramService }) =>
        TelegramService.notifyTaskComplete({
          taskTitle: finalTitle || task.title,
          status: "success",
          sourceUrl: task.sourceUrl,
        })
      ).catch(() => {});

      // Trigger Cloud Upload (Async, don't await to block queue processing?)
      // Actually, we might want to await it if we want to ensure it's done before resolving,
      // but that would block the download queue.
      // Let's run it in background but log it.
      CloudStorageService.uploadVideo({
        ...videoData,
        title: finalTitle || task.title,
        sourceUrl: task.sourceUrl,
      }).catch((err) => console.error("Background cloud upload failed:", err));

      task.resolve(result);
    } catch (error) {
      // A paused task is stopped like a cancelled one, but it must not write
      // failure history or fire cancel/fail hooks - it goes to the paused
      // store so it can be resumed later.
      if (task.paused) {
        this.finalizePausedTask(task);
        return;
      }

      // Check if this is a cancellation - handle differently
      if (isCancelledError(error) || task.cancelled) {
        console.log("Download cancelled:", sanitizeLogMessage(task.title));
        task.cancelled = true;
        this.finalizeCancelledTask(
          task,
          isCancelledError(error) ? error : DownloadCancelledError.create(),
        );
        return;
      } else {
        console.error(
          "Error downloading task:",
          sanitizeLogMessage(task.title),
          error,
        );
      }

      // Download failed
      storageService.removeActiveDownload(task.id);

      // Add to history (unless already added by cancelDownload)
      let retryScheduled = false;
      if (!task.cancelled) {
        retryScheduled = this.maybeScheduleRetry(task, error);
      }

      if (!task.cancelled && !retryScheduled) {
        this.clearRetryTimer(task.id);
        const structuredResult = getStructuredDownloadResult(error);
        storageService.addDownloadHistoryItem({
          id: task.id,
          title: task.title,
          finishedAt: Date.now(),
          status: structuredResult?.partial === true ? PARTIAL_STATUS : "failed",
          error: getErrorMessage(error),
          sourceUrl: task.sourceUrl,
          platform: platformFromUrl(task.sourceUrl),
          sourceKind: task.statistics?.sourceKind ?? "unknown",
          downloadType: task.type,
          retryMetadata:
            task.retryMetadata && requiresRetryMetadata(task.retryMetadata)
              ? serializeRetryMetadata(task.retryMetadata)
              : undefined,
        });
      }

      if (!retryScheduled) {
        // Await failure hooks so notifications and other side effects complete
        // before the task rejection propagates to callers.
        await awaitTaskFailHook({
          taskId: task.id,
          taskTitle: task.title,
          sourceUrl: task.sourceUrl,
          status: "fail",
          error: getErrorMessage(error),
        });

        import("./telegramService").then(({ TelegramService }) =>
          TelegramService.notifyTaskComplete({
            taskTitle: task.title,
            status: "fail",
            sourceUrl: task.sourceUrl,
            error: getErrorMessage(error),
          })
        ).catch(() => {});

        task.reject(error);
      }
    } finally {
      // Only clean up if the task wasn't already cleaned up by cancelDownload
      if (this.activeTasks.has(task.id)) {
        this.activeTasks.delete(task.id);
        this.activeDownloads--;
      }
      // Process next item in queue
      this.processQueue();
      // Fires the pending auto-shutdown when this was the last task
      notifyDownloadSettled(this.activeDownloads, this.queue.length);
    }
  }

  /**
   * Get current status
   */
  getStatus(): { active: number; queued: number } {
    return {
      active: this.activeDownloads,
      queued: this.queue.length,
    };
  }
}

// Export a singleton instance
export default new DownloadManager();
