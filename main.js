const { app, BrowserWindow, shell, ipcMain, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// Auto-updater configuration
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

let mainWindow;

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
      webviewTag: true
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
  createWindow();

  // Send app version to renderer
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('app-version', app.getVersion());
  });

  // Check for updates after 3 seconds (give app time to load)
  setTimeout(() => {
    checkForUpdates();
  }, 3000);
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

// ==================== AUTO-UPDATE FUNCTIONS ====================

function checkForUpdates() {
  autoUpdater.checkForUpdates();
}

// Send update status to renderer
function sendUpdateStatus(status, data = {}) {
  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('update-status', { status, ...data });
  }
}

// Event: Update available
autoUpdater.on('update-available', (info) => {
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

// Event: Update downloaded
autoUpdater.on('update-downloaded', (info) => {
  sendUpdateStatus('downloaded', { version: info.version });
});

// Event: Error
autoUpdater.on('error', (error) => {
  console.error('Auto-update error:', error);
  const msg = error.message || String(error);
  sendUpdateStatus('error', { message: msg.substring(0, 150) });
});

// IPC: User wants to download update
ipcMain.on('update-download', () => {
  autoUpdater.downloadUpdate();
});

// IPC: User wants to install update (restart)
ipcMain.on('update-install', () => {
  autoUpdater.quitAndInstall();
});

// IPC: User wants to check for updates manually
ipcMain.on('update-check', () => {
  autoUpdater.checkForUpdates();
});

// ==================== END AUTO-UPDATE ====================
