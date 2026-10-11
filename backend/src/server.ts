// Load environment variables from .env file
import dotenv from "dotenv";
dotenv.config();

import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import fs from "fs-extra";
import type { Server as HttpServer } from "http";
import path from "path";
import { DATA_DIR } from "./config/paths";
import { runMigrations } from "./db/migrate";
import { errorHandler } from "./middleware/errorHandler";
import { rssManagementNoStoreHeaders } from "./middleware/rssManagementNoStoreHeaders";
import { statisticsEventsJsonParser } from "./controllers/statisticsController";
import downloadManager from "./services/downloadManager";
import * as storageService from "./services/storageService";
import { logger } from "./utils/logger";
import { VERSION } from "./version";
import { csrfProtection, csrfTokenProvider } from "./middleware/csrfMiddleware";
import { registerApiRoutes, registerFeedRoute } from "./server/apiRoutes";
import { buildCorsOptionsDelegate } from "./server/cors";
import { registerCloudRoutes } from "./server/cloudRoutes";
import { configureRateLimiting } from "./server/rateLimit";
import { registerSpaFallback, registerStaticRoutes } from "./server/staticRoutes";
import { startBackgroundJobs } from "./server/startupJobs";
import { registerLiveTranslationSocket } from "./server/liveTranslationSocket";

VERSION.displayVersion();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 5551;

// Bound the in-memory JSON/urlencoded body parsers. File uploads (videos,
// thumbnails, subtitles, cookies.txt, DB restores) stream to disk via multer
// and are unaffected by this limit, so a generous-but-sane ceiling protects
// against memory-exhaustion DoS without breaking any metadata/settings payload.
const JSON_BODY_LIMIT = process.env.MYTUBE_JSON_BODY_LIMIT || "10mb";

app.set("trust proxy", 1);
app.disable("x-powered-by");

const authLimiters = configureRateLimiting(app);
app.use(cors(buildCorsOptionsDelegate()));
app.use(cookieParser());
app.use(rssManagementNoStoreHeaders);
app.use("/api/statistics/events", statisticsEventsJsonParser);
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));
app.use(csrfProtection);
app.use(csrfTokenProvider);

const configureProcessCrashReports = (): void => {
  if (!process.report) {
    return;
  }

  try {
    const reportDir = path.join(DATA_DIR, "crash-reports");
    fs.ensureDirSync(reportDir);
    process.report.directory = reportDir;
    process.report.compact = true;
    process.report.reportOnFatalError = true;
    process.report.reportOnUncaughtException = true;
    process.report.reportOnSignal = false;
    logger.info(`Node crash reports enabled: ${reportDir}`);
  } catch (error) {
    logger.warn("Failed to configure Node crash reports", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// On SIGINT/SIGTERM/SIGBREAK, pause every active download (kills the yt-dlp
// subprocesses, keeps .part/.ytdl artifacts, snapshots progress into the
// paused store) before the process exits, so no download loses its progress.
// A second signal forces an immediate exit.
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 8000;
const FORCE_EXIT_TIMEOUT_MS = 3000;

const registerGracefulShutdown = (server: HttpServer): void => {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    logger.info(`Received ${signal}; pausing active downloads before exit...`);
    Promise.race([
      downloadManager.pauseAllActiveDownloadsForShutdown(),
      new Promise<void>((resolve) =>
        setTimeout(resolve, GRACEFUL_SHUTDOWN_TIMEOUT_MS),
      ),
    ])
      .catch((error) => {
        logger.error(
          "Error while pausing downloads during shutdown:",
          error instanceof Error ? error : new Error(String(error)),
        );
      })
      .finally(() => {
        // Keep-alive sockets can hold server.close() open; force exit shortly
        // after so the process never hangs on shutdown.
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), FORCE_EXIT_TIMEOUT_MS).unref();
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGBREAK", () => shutdown("SIGBREAK"));
};

const startServer = async (): Promise<void> => {  try {
    configureProcessCrashReports();
    await runMigrations();

    storageService.initializeStorage();
    downloadManager.initialize();

    const frontendDist = path.join(__dirname, "../../frontend/dist");

    registerFeedRoute(app, authLimiters);
    registerStaticRoutes(app, frontendDist);
    registerCloudRoutes(app);
    registerApiRoutes(app, authLimiters, { includeFeedRoute: false });
    registerSpaFallback(app, frontendDist);

    // Global error middleware (must be registered after routes)
    app.use(errorHandler);

    const HOST = process.env.HOST || "0.0.0.0";
    const server = app.listen(PORT, HOST, () => {
      logger.info(`Server running on ${HOST}:${PORT}`);
      startBackgroundJobs(PORT);
    });
    // Register the live translation WebSocket on the same HTTP server (noServer
    // mode handles only the live translation upgrade path).
    registerLiveTranslationSocket(server);
    registerGracefulShutdown(server);
  } catch (error) {
    logger.error(
      "Failed to start server:",
      error instanceof Error ? error : new Error(String(error))
    );
    process.exit(1);
  }
};

void startServer();
