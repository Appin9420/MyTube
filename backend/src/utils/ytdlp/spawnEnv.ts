import path from "path";
import { getProviderPluginPath } from "../../services/downloaders/ytdlp/ytdlpHelpers";

let providerPluginPathCache: string | null | undefined = undefined;

function getCachedProviderPluginPath(): string {
  if (providerPluginPathCache === undefined) {
    providerPluginPathCache = getProviderPluginPath() || null;
  }

  return providerPluginPathCache || "";
}

/**
 * Build the environment used to spawn yt-dlp, injecting the bgutil provider
 * plugin onto PYTHONPATH when one is configured.
 * Forces UTF-8 encoding for Python's stdout/stderr to prevent garbled titles
 * on Windows systems with non-UTF-8 code pages.
 */
export function getYtDlpSpawnEnv(): NodeJS.ProcessEnv {
  const providerPluginPath = getCachedProviderPluginPath();
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
  };

  if (!providerPluginPath) {
    return baseEnv;
  }

  const pythonPathEntries = (baseEnv.PYTHONPATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);

  if (!pythonPathEntries.includes(providerPluginPath)) {
    pythonPathEntries.unshift(providerPluginPath);
  }

  return {
    ...baseEnv,
    PYTHONPATH: pythonPathEntries.join(path.delimiter),
  };
}

export function resetProviderPluginCache(): void {
  providerPluginPathCache = undefined;
}
