export function startWindowsUpdater(updater, window, dialog, installUpdate) {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.disableWebInstaller = true;
  updater.disableDifferentialDownload = true;
  updater.on('download-progress', ({ percent }) => window.setProgressBar(percent / 100));
  updater.on('error', (error) => console.error('GPU Monitor 更新失败:', error));

  let busy = false;
  let reportResult = false;

  async function checkForUpdates(manual) {
    if (manual) reportResult = true;
    if (busy) return;
    busy = true;
    let downloading = false;
    try {
      const result = await updater.checkForUpdates();
      if (!result?.isUpdateAvailable) {
        if (reportResult) await dialog.showMessageBox(window, {
          type: 'info', message: '当前已是最新版本。',
        });
        return;
      }

      const { response } = await dialog.showMessageBox(window, {
        type: 'info',
        message: `GPU Monitor ${result.updateInfo.version} 已发布`,
        detail: '下载完成后，GPU Monitor 将重启并安装更新。',
        buttons: ['下载并安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return;

      downloading = true;
      window.setProgressBar(2, { mode: 'indeterminate' });
      await updater.downloadUpdate();
      installUpdate();
    } catch {
      if (downloading || reportResult) await dialog.showMessageBox(window, {
        type: 'error',
        message: downloading ? '无法下载更新' : '无法检查更新',
        detail: '请检查网络连接后重试。',
      });
    } finally {
      if (downloading) window.setProgressBar(-1);
      busy = false;
      reportResult = false;
    }
  }

  void checkForUpdates(false);
  return () => void checkForUpdates(true);
}
