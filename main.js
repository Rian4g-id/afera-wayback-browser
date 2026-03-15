const { app, BrowserWindow, shell, ipcMain, Menu, dialog } = require('electron');
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

// Event: Update available
autoUpdater.on('update-available', (info) => {
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Available',
    message: `Version ${info.version} is available!`,
    detail: 'Do you want to download it now?',
    buttons: ['Download', 'Later'],
    defaultId: 0
  }).then((result) => {
    if (result.response === 0) {
      autoUpdater.downloadUpdate();

      // Show download progress in title
      mainWindow.setTitle('Afera Wayback Browser - Downloading update...');
    }
  });
});

// Event: Update not available
autoUpdater.on('update-not-available', () => {
  // Silent - no notification needed
});

// Event: Download progress
autoUpdater.on('download-progress', (progress) => {
  mainWindow.setTitle(`Afera Wayback Browser - Downloading: ${Math.round(progress.percent)}%`);
});

// Event: Update downloaded
autoUpdater.on('update-downloaded', (info) => {
  mainWindow.setTitle('Afera Wayback Browser');

  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Ready',
    message: 'Update downloaded!',
    detail: 'The application will restart to install the update.',
    buttons: ['Restart Now', 'Later'],
    defaultId: 0
  }).then((result) => {
    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });
});

// Event: Error
autoUpdater.on('error', (error) => {
  console.error('Auto-update error:', error);
});

// ==================== END AUTO-UPDATE ====================
