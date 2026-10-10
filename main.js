const { app, BrowserWindow, shell, ipcMain, Menu, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');
const { setupArchiveProxy } = require('./archive-proxy');

// Auto-updater configuration
// Updates are mandatory: download starts as soon as one is found,
// then the app installs it silently and restarts into the new version.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);

// Re-check while the app stays open
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

let mainWindow;

// True once an update was found: the mandatory update popup is showing
let updateInProgress = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
      // Keep List checks running at full speed while minimized / in the background
      // (Chromium would otherwise slow timers down to once a minute)
      backgroundThrottling: false
    },
    titleBarStyle: 'default',
    backgroundColor: '#1a1a2e',
    autoHideMenuBar: true
  });

  // Hilangkan menu bar completely
  Menu.setApplicationMenu(null);

  mainWindow.loadFile('index.html');

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  setupArchiveProxy();
  createWindow();

  // Send app version to renderer
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('app-version', app.getVersion());
  });

  // Check for updates after 3 seconds (give app time to load).
  // Only when packaged — electron-updater throws/errors in dev mode.
  if (app.isPackaged) {
    setTimeout(() => {
      checkForUpdates();
    }, 3000);
    setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handler untuk open external URL
ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url);
});

// IPC: folder where the renderer keeps the domain list / history
ipcMain.on('get-user-data-path', (event) => {
  event.returnValue = app.getPath('userData');
});

// IPC: save a text file (CSV export) through the Save dialog
ipcMain.handle('save-text-file', async (event, { defaultName, content }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  });
  if (canceled || !filePath) return { saved: false };
  await fs.promises.writeFile(filePath, content, 'utf8');
  return { saved: true, filePath };
});

// ==================== AUTO-UPDATE FUNCTIONS ====================

function checkForUpdates() {
  if (updateInProgress) return; // already downloading/installing
  // Failures are reported through the 'error' event
  autoUpdater.checkForUpdates().catch(() => {});
}

// Send update status to renderer
function sendUpdateStatus(status, data = {}) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('update-status', { status, ...data });
  }
}

// Install silently (no installer wizard) and relaunch the app afterwards
function installUpdate() {
  autoUpdater.quitAndInstall(true, true);
}

// Event: Update available (download starts automatically)
autoUpdater.on('update-available', (info) => {
  updateInProgress = true;
  sendUpdateStatus('available', { version: info.version });
});

// Event: Update not available
autoUpdater.on('update-not-available', () => {
  sendUpdateStatus('not-available');
});

// Event: Download progress
autoUpdater.on('download-progress', (progress) => {
  sendUpdateStatus('downloading', { percent: Math.round(progress.percent) });
});

// Event: Update downloaded -> install and restart after a short notice
autoUpdater.on('update-downloaded', (info) => {
  sendUpdateStatus('downloaded', { version: info.version });
  setTimeout(installUpdate, 3000);
});

// Event: Error
// Only shown while a mandatory update is in progress; a failed check
// (e.g. offline, GitHub down) must not lock the user out of the app.
autoUpdater.on('error', (error) => {
  console.error('Auto-update error:', error);
  if (!updateInProgress) return;
  const msg = error.message || String(error);
  sendUpdateStatus('error', { message: msg.substring(0, 150) });
});

// IPC: User wants to install now instead of waiting
ipcMain.on('update-install', () => {
  installUpdate();
});

// IPC: Retry after a failed download (check again -> downloads automatically)
ipcMain.on('update-check', () => {
  autoUpdater.checkForUpdates().catch(() => {});
});

// ==================== END AUTO-UPDATE ====================
