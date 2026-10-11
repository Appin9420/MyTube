import { spawn } from "child_process";
import { logger } from "../utils/logger";

const SHUTDOWN_DELAY_SECONDS = 60;
let shutdownIssued = false;
let autoShutdownEnabled = false;

const isWindows = process.platform === "win32";

/**
 * Keeps the "shut down when all downloads finish" feature state. The flag
 * is refreshed from saved settings at boot and on every settings update;
 * notifyDownloadSettled fires from the download manager whenever a task
 * leaves the active set.
 */
export function setAutoShutdownEnabled(enabled: boolean): void {
  const next = enabled === true;
  if (autoShutdownEnabled === next) {
    return;
  }
  autoShutdownEnabled = next;
  logger.info(`Auto shutdown: ${next ? "enabled" : "disabled"}`);
  if (!next) {
    abortPendingShutdown("setting disabled");
  }
}

export function abortPendingShutdown(reason: string): void {
  if (!shutdownIssued) {
    return;
  }
  if (isWindows) {
    spawn("shutdown", ["/a"], { stdio: "ignore", windowsHide: true });
  }
  shutdownIssued = false;
  logger.info(`Auto shutdown: aborted (${reason})`);
}

export function notifyDownloadSettled(active: number, queued: number): void {
  if (shutdownIssued || !autoShutdownEnabled) {
    return;
  }
  if (active > 0 || queued > 0) {
    return;
  }
  shutdownIssued = true;
  logger.warn(
    `Auto shutdown: all downloads finished - shutting down in ${SHUTDOWN_DELAY_SECONDS}s (toggle the setting off to cancel)`,
  );
  if (isWindows) {
    spawn("shutdown", ["/s", "/t", String(SHUTDOWN_DELAY_SECONDS)], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    spawn("shutdown", ["-h", `+${Math.max(1, Math.ceil(SHUTDOWN_DELAY_SECONDS / 60))}`], {
      stdio: "ignore",
    });
  }
}
