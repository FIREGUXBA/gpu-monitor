import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, protocol, session, Tray } from 'electron';
import { migrateSourceData } from './migrate.mjs';
import { startWindowsUpdater } from './windows-updater.mjs';

const mac = process.platform === 'darwin';
const dataDir = resolve(process.env.GPU_MONITOR_DATA_DIR || join(
  process.platform === 'win32' ? process.env.LOCALAPPDATA || app.getPath('appData') : app.getPath('appData'),
  'GPU Monitor',
));
const origin = 'gpu-monitor://panel';
app.setName('GPU Monitor');

function startUpdater() {
  if (!mac || !app.isPackaged) return;
  const addon = join(process.resourcesPath, '..', 'Frameworks', 'mac-updater.node');
  if (!existsSync(addon)) return;
  try {
    const updater = createRequire(import.meta.url)(addon);
    updater.start();
    return () => {
      app.focus({ steal: true });
      updater.checkForUpdates();
    };
  } catch (error) {
    console.error('GPU Monitor 更新器启动失败:', error);
  }
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'gpu-monitor',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

function trayImage() {
  const size = 32;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let y = 4; y < 28; y++) {
    for (let x = 4; x < 28; x++) {
      const body = x >= 8 && x < 24 && y >= 8 && y < 24;
      const center = x >= 12 && x < 20 && y >= 12 && y < 20;
      const pins = [10, 11, 15, 16, 20, 21];
      if ((body && !center) || (!body && (pins.includes(x) || pins.includes(y)))) {
        bitmap.writeUInt32LE(mac ? 0xff000000 : 0xff4a8ad6, (y * size + x) * 4);
      }
    }
  }
  const icon = nativeImage.createFromBitmap(bitmap, { width: size, height: size, scaleFactor: 2 });
  icon.setTemplateImage(mac);
  return icon;
}

mkdirSync(join(dataDir, 'Chromium'), { recursive: true });
app.setPath('userData', join(dataDir, 'Chromium'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let window;
  let loaded = false;
  let tray;
  let quitting = false;
  let stopped = false;
  let stopMonitor;

  function showPanel() {
    if (!loaded || quitting) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  app.on('second-instance', showPanel);
  app.on('activate', showPanel);
  app.on('window-all-closed', () => {});
  function finishQuit(action) {
    if (quitting) return;
    quitting = true;
    void (async () => {
      try {
        await startup;
        await stopMonitor?.();
      } finally {
        stopped = true;
        tray?.destroy();
        action();
      }
    })().catch(console.error);
  }

  app.on('before-quit', (event) => {
    if (stopped) return;
    event.preventDefault();
    finishQuit(() => app.quit());
  });

  const startup = (async () => {
    await app.whenReady();
    const appIcon = join(app.getAppPath(), 'public', 'gpu-monitor.png');
    if (mac && !app.isPackaged) {
      const updateDockIcon = () => {
        const appearance = nativeTheme.shouldUseDarkColors ? 'Dark' : 'Default';
        app.dock.setIcon(join(app.getAppPath(), 'packaging', 'icons', `mac-${appearance}.png`));
      };
      updateDockIcon();
      nativeTheme.on('updated', updateDockIcon);
    }
    await migrateSourceData(app.isPackaged ? null : join(app.getAppPath(), 'data'), dataDir);
    process.env.GPU_MONITOR_DATA_DIR = dataDir;
    const monitor = await import('./server.mjs');
    stopMonitor = monitor.stopMonitor;
    await monitor.startMonitor();
    if (quitting) return;

    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    protocol.handle('gpu-monitor', async (request) => {
      const url = new URL(request.url);
      if (url.host !== 'panel' || url.username || url.password) return new Response(null, { status: 403 });
      const response = await monitor.handleRequest(request);
      response.headers.set('content-security-policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'");
      return response;
    });

    window = new BrowserWindow({
      title: 'GPU Monitor',
      icon: appIcon,
      width: 900,
      height: 600,
      minWidth: 900,
      minHeight: 480,
      show: false,
      ...(mac && { titleBarStyle: 'hidden', titleBarOverlay: true, trafficLightPosition: { x: 14, y: 11 } }),
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
    window.webContents.on('will-redirect', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      window.hide();
    });

    await window.loadURL(origin + (mac ? '/?window=mac' : '/'));
    if (quitting) return;
    loaded = true;
    showPanel();

    if (!app.isPackaged && process.env.GPU_MONITOR_DEV !== '0') {
      window.webContents.openDevTools({ mode: 'detach' });
    }

    let checkForUpdates = startUpdater();
    if (process.platform === 'win32' && app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))) {
      const { autoUpdater } = createRequire(import.meta.url)('electron-updater');
      checkForUpdates = startWindowsUpdater(autoUpdater, window, dialog, () => finishQuit(() => {
        autoUpdater.once('error', () => {
          dialog.showErrorBox('GPU Monitor 更新失败', '无法启动更新安装程序。请重新打开 GPU Monitor 后重试。');
          app.quit();
        });
        autoUpdater.quitAndInstall(true, true);
      }));
    }
    if (mac && checkForUpdates) {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu', submenu: [
          { role: 'about' },
          { label: '检查更新…', click: checkForUpdates },
          { type: 'separator' },
          { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
          { type: 'separator' }, { role: 'quit' },
        ] },
        { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
      ]));
    } else if (checkForUpdates) {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
        { label: '帮助', submenu: [{ label: '检查更新…', click: checkForUpdates }] },
      ]));
    }

    tray = new Tray(trayImage());
    tray.setToolTip('GPU Monitor');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开面板', click: showPanel },
      ...(checkForUpdates ? [{ label: '检查更新…', click: () => {
        showPanel();
        checkForUpdates();
      } }] : []),
      { label: '退出', click: () => app.quit() },
    ]));
    if (!mac) tray.on('click', showPanel);
  })();

  void startup.catch((err) => {
    console.error(err);

    dialog.showErrorBox('GPU Monitor 启动失败', String(err.message || err));
    app.quit();
  });
}
