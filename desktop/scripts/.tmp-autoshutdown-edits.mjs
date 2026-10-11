import fs from 'fs';

const must = (cond, label) => { if (!cond) throw new Error('ANCHOR FAILED: ' + label); };
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const write = (p, s) => fs.writeFileSync(p, s.replace(/\n/g, '\r\n'));

// ============ backend ============

// 1. types/settings.ts: interface + default
{
  const p = 'D:/MyTube/backend/src/types/settings.ts';
  let s = read(p);
  const ifaceAnchor = '  pauseOnFocusLoss?: boolean;';
  must(s.includes(ifaceAnchor), 'settings iface');
  s = s.replace(ifaceAnchor, ifaceAnchor + '\n  autoShutdownEnabled?: boolean;');
  const defAnchor = '  pauseOnFocusLoss: false,';
  must(s.includes(defAnchor), 'settings default');
  s = s.replace(defAnchor, defAnchor + '\n  autoShutdownEnabled: false,');
  write(p, s);
  console.log('backend types ok');
}

// 2. storageService/settings.ts: whitelist
{
  const p = 'D:/MyTube/backend/src/services/storageService/settings.ts';
  let s = read(p);
  const anchor = '  "pauseOnFocusLoss",';
  must(s.includes(anchor), 'settings whitelist');
  s = s.replace(anchor, anchor + '\n  "autoShutdownEnabled",');
  write(p, s);
  console.log('settings whitelist ok');
}

// 3. autoShutdownService.ts (new)
fs.writeFileSync(
  'D:/MyTube/backend/src/services/autoShutdownService.ts',
  [
    'import { spawn } from "child_process";',
    'import { logger } from "../utils/logger";',
    '',
    'const SHUTDOWN_DELAY_SECONDS = 60;',
    'let shutdownIssued = false;',
    'let autoShutdownEnabled = false;',
    '',
    'const isWindows = process.platform === "win32";',
    '',
    '/**',
    ' * Keeps the "shut down when all downloads finish" feature state. The flag',
    ' * is refreshed from saved settings at boot and on every settings update;',
    ' * notifyDownloadSettled fires from the download manager whenever a task',
    ' * leaves the active set.',
    ' */',
    'export function setAutoShutdownEnabled(enabled: boolean): void {',
    '  const next = enabled === true;',
    '  if (autoShutdownEnabled === next) {',
    '    return;',
    '  }',
    '  autoShutdownEnabled = next;',
    '  logger.info(`Auto shutdown: ${next ? "enabled" : "disabled"}`);',
    '  if (!next) {',
    '    abortPendingShutdown("setting disabled");',
    '  }',
    '}',
    '',
    'export function abortPendingShutdown(reason: string): void {',
    '  if (!shutdownIssued) {',
    '    return;',
    '  }',
    '  if (isWindows) {',
    '    spawn("shutdown", ["/a"], { stdio: "ignore", windowsHide: true });',
    '  }',
    '  shutdownIssued = false;',
    '  logger.info(`Auto shutdown: aborted (${reason})`);',
    '}',
    '',
    'export function notifyDownloadSettled(active: number, queued: number): void {',
    '  if (shutdownIssued || !autoShutdownEnabled) {',
    '    return;',
    '  }',
    '  if (active > 0 || queued > 0) {',
    '    return;',
    '  }',
    '  shutdownIssued = true;',
    '  logger.warn(',
    '    `Auto shutdown: all downloads finished - shutting down in ${SHUTDOWN_DELAY_SECONDS}s (toggle the setting off to cancel)`,',
    '  );',
    '  if (isWindows) {',
    '    spawn("shutdown", ["/s", "/t", String(SHUTDOWN_DELAY_SECONDS)], {',
    '      stdio: "ignore",',
    '      windowsHide: true,',
    '    });',
    '  } else {',
    '    spawn("shutdown", ["-h", `+${Math.max(1, Math.ceil(SHUTDOWN_DELAY_SECONDS / 60))}`], {',
    '      stdio: "ignore",',
    '    });',
    '  }',
    '}',
    '',
  ].join('\n'),
);
console.log('autoShutdownService created');

// 4. downloadManager.ts: import + settle hook + start abort
{
  const p = 'D:/MyTube/backend/src/services/downloadManager.ts';
  let s = read(p);
  const importAnchor = 'import { logger, sanitizeLogMessage } from "../utils/logger";';
  must(s.includes(importAnchor), 'dm import');
  s = s.replace(importAnchor, importAnchor + '\nimport { abortPendingShutdown, notifyDownloadSettled } from "./autoShutdownService";');

  const finallyOld = [
    '      // Only clean up if the task wasn\'t already cleaned up by cancelDownload',
    '      if (this.activeTasks.has(task.id)) {',
    '        this.activeTasks.delete(task.id);',
    '        this.activeDownloads--;',
    '      }',
    '      // Process next item in queue',
    '      this.processQueue();',
  ].join('\n');
  must(s.includes(finallyOld), 'dm finally block');
  const finallyNew = [
    '      // Only clean up if the task wasn\'t already cleaned up by cancelDownload',
    '      if (this.activeTasks.has(task.id)) {',
    '        this.activeTasks.delete(task.id);',
    '        this.activeDownloads--;',
    '      }',
    '      // Process next item in queue',
    '      this.processQueue();',
    '      // Fires the pending auto-shutdown when this was the last task',
    '      notifyDownloadSettled(this.activeDownloads, this.queue.length);',
  ].join('\n');
  s = s.replace(finallyOld, finallyNew);

  const startAnchor = '    this.updateQueuedDownloads();\n    this.activeDownloads++;';
  must(s.includes(startAnchor), 'dm queue start');
  s = s.replace(startAnchor, startAnchor + '\n    // A newly started download cancels any pending shutdown countdown\n    abortPendingShutdown("new download started");');

  write(p, s);
  console.log('downloadManager ok');
}

// 5. settingsController.ts: runtime apply + import
{
  const p = 'D:/MyTube/backend/src/controllers/settingsController.ts';
  let s = read(p);
  const importRegex = /import \{ downloadManager[^;]*;\r?\n/;
  must(importRegex.test(s), 'sc downloadManager import');
  s = s.replace(importRegex, (m) => m + 'import { setAutoShutdownEnabled } from "../services/autoShutdownService";\n');

  const applyOld = [
    '  if (',
    '    hasOwnSetting(settingsToPersist, "maxConcurrentDownloads") &&',
    '    finalSettings.maxConcurrentDownloads !== undefined',
    '  ) {',
    '    downloadManager.setMaxConcurrentDownloads(',
    '      finalSettings.maxConcurrentDownloads',
    '    );',
    '  }',
    '};',
  ].join('\n');
  must(s.includes(applyOld), 'sc applyRuntimeSettingChanges');
  const applyNew = [
    '  if (',
    '    hasOwnSetting(settingsToPersist, "maxConcurrentDownloads") &&',
    '    finalSettings.maxConcurrentDownloads !== undefined',
    '  ) {',
    '    downloadManager.setMaxConcurrentDownloads(',
    '      finalSettings.maxConcurrentDownloads',
    '    );',
    '  }',
    '  setAutoShutdownEnabled(finalSettings.autoShutdownEnabled === true);',
    '};',
  ].join('\n');
  s = s.replace(applyOld, applyNew);
  write(p, s);
  console.log('settingsController ok');
}

// 6. startupJobs.ts: init at boot
{
  const p = 'D:/MyTube/backend/src/server/startupJobs.ts';
  let s = read(p);
  const importAnchor = 'import { startCloudflaredIfEnabled } from "./cloudRoutes";';
  must(s.includes(importAnchor), 'sj import');
  s = s.replace(importAnchor,
    importAnchor + '\nimport { setAutoShutdownEnabled } from "../services/autoShutdownService";\nimport { getSettings } from "../services/storageService";');
  const bodyAnchor = 'export const startBackgroundJobs = (port: number): void => {';
  must(s.includes(bodyAnchor), 'sj body');
  s = s.replace(bodyAnchor, bodyAnchor + '\n    setAutoShutdownEnabled(getSettings().autoShutdownEnabled === true);');
  write(p, s);
  console.log('startupJobs ok');
}

// ============ frontend ============

// 7. types.ts
{
  const p = 'D:/MyTube/frontend/src/types.ts';
  let s = read(p);
  const anchor = '  pauseOnFocusLoss?: boolean;';
  must(s.includes(anchor), 'fe types');
  s = s.replace(anchor, anchor + '\n  autoShutdownEnabled?: boolean;');
  write(p, s);
  console.log('frontend types ok');
}

// 8. DownloadSettings.tsx: toggle before autoRetry block
{
  const p = 'D:/MyTube/frontend/src/components/Settings/DownloadSettings.tsx';
  let s = read(p);
  const anchor = '            <Box sx={{ mt: 3 }} id="autoRetry-setting">';
  must(s.includes(anchor), 'ds autoRetry anchor');
  const block = [
    '            <Box sx={{ mt: 3 }} id="autoShutdown-setting">',
    '                <FormControlLabel',
    '                    control={',
    '                        <Switch',
    '                            checked={settings.autoShutdownEnabled === true}',
    "                            onChange={(e) => onChange('autoShutdownEnabled', e.target.checked)}",
    '                        />',
    '                    }',
    "                    label={t('autoShutdownTitle') || '下载完成后自动关机'}",
    '                />',
    '                <Typography variant="body2" color="text.secondary" sx={{ mt: 1, mb: 2 }}>',
    "                    {t('autoShutdownDescription') || '开启后，当所有下载任务全部结束时，将在 60 秒后关闭计算机。再次关闭此开关可取消尚未执行的关机。'}",
    '                </Typography>',
    '            </Box>',
    '',
  ].join('\n');
  s = s.replace(anchor, block + anchor);
  write(p, s);
  console.log('DownloadSettings ok');
}

// 9. locales: all 10
const enKeys = {
  autoShutdownTitle: 'Auto shutdown when downloads finish',
  autoShutdownDescription: 'When enabled and all download tasks finish, the computer will shut down in 60 seconds. Toggle the switch off again to cancel a pending shutdown.',
  batchTransfer: 'Batch transfer',
  moveToAnotherCollection: 'Move to another collection',
  targetCollection: 'Target collection',
  selectedCount: '{n} selected',
  selectAll: 'Select all',
  clearSelection: 'Clear',
  confirmMove: 'Move',
  moving: 'Moving...',
  videosMovedToCollection: 'Videos moved successfully',
  failedToMoveVideos: 'Failed to move videos',
  mergeDuplicates: 'Merge duplicate collections',
  mergeDone: 'Merge complete',
  mergeFailed: 'Merge failed',
};
const zhKeys = {
  autoShutdownTitle: '下载完成后自动关机',
  autoShutdownDescription: '开启后，当所有下载任务全部结束时，将在 60 秒后关闭计算机。再次关闭此开关可取消尚未执行的关机。',
  batchTransfer: '批量转移',
  moveToAnotherCollection: '移动到其他合集',
  targetCollection: '目标合集',
  selectedCount: '已选 {n} 个',
  selectAll: '全选',
  clearSelection: '清除选择',
  confirmMove: '确认转移',
  moving: '转移中...',
  videosMovedToCollection: '视频已转移',
  failedToMoveVideos: '转移失败',
  mergeDuplicates: '合并同名合集',
  mergeDone: '合并完成',
  mergeFailed: '合并失败',
};
for (const loc of ['en','zh','es','de','ja','fr','ko','ar','pt','ru']) {
  const p = `D:/MyTube/frontend/src/utils/locales/${loc}.ts`;
  let s = read(p);
  if (s.includes('autoShutdownTitle')) { console.log('locale skip:', loc); continue; }
  const idx = s.indexOf('noVideosInCollection:');
  must(idx >= 0, `locale anchor ${loc}`);
  const lineEnd = s.indexOf('\n', idx);
  const values = loc === 'zh' ? zhKeys : enKeys;
  const insert = Object.entries(values).map(([k, v]) => `  ${k}: '${v.replace(/'/g, "\\'")}',`).join('\n');
  s = s.slice(0, lineEnd + 1) + insert + '\n' + s.slice(lineEnd + 1);
  write(p, s);
  console.log('locale ok:', loc);
}
console.log('ALL EDITS DONE');
