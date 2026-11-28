// Approx for Windows: the production Approx web app in its own window, with verified automatic updates.
// Sessions, settings and local data live in the Electron user-data folder (%APPDATA%\Approx) and survive updates.
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const updater = require('./updater.js');

const SERVER = (process.env.APPROX_URL || 'https://approx-ai.vercel.app').replace(/\/+$/, '');
let win; let pending = null; let lastCheck = null;

function createWindow() {
  win = new BrowserWindow({ width: 1280, height: 860, minWidth: 380, minHeight: 600, title: 'Approx', icon: path.join(__dirname, 'icon.png'), backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
  win.removeMenu();
  win.loadURL(SERVER);
  // Links to other sites open in the default browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith(SERVER)) shell.openExternal(url); return { action: url.startsWith(SERVER) ? 'allow' : 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(SERVER)) { e.preventDefault(); shell.openExternal(url); } });
}

async function checkForUpdates(interactive) {
  lastCheck = await updater.check({ server: SERVER, current: app.getVersion() });
  lastCheck.checked_at = Date.now();
  if (lastCheck.status === 'available') {
    pending = lastCheck;
    const { response } = await dialog.showMessageBox(win, { type: 'info', buttons: ['Update now', 'Later'], defaultId: 0, cancelId: 1, title: 'Approx update',
      message: `Approx ${lastCheck.latest} is available (you have ${lastCheck.current}).`, detail: (lastCheck.notes || '').slice(0, 1500) });
    if (response === 0) await installUpdate();
  } else if (interactive) {
    dialog.showMessageBox(win, { type: lastCheck.status === 'error' ? 'warning' : 'info', message: lastCheck.status === 'error' ? `Could not check for updates: ${lastCheck.reason}` : `Approx ${lastCheck.current} is up to date.` });
  }
  return lastCheck;
}

async function installUpdate() {
  if (!pending) return { ok: false, reason: 'No update available' };
  try {
    const file = await updater.download({ url: pending.url, sha256: pending.sha256, version: pending.latest, dir: path.join(app.getPath('temp'), 'approx-update'),
      onProgress: (p) => { if (p !== null) win?.setProgressBar(p); } });
    win?.setProgressBar(-1);
    // NSIS one-click installer: /S = silent upgrade in place (user data kept); --updated relaunches Approx after install.
    spawn(file, ['/S', '--updated'], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
    return { ok: true };
  } catch (e) {
    win?.setProgressBar(-1);
    dialog.showMessageBox(win, { type: 'error', message: 'The update was not installed.', detail: `${e.message}\nApprox keeps running the current version; it will try again later.` });
    return { ok: false, reason: e.message };
  }
}

ipcMain.handle('approx:version', () => ({ version: app.getVersion(), last_check: lastCheck }));
ipcMain.handle('approx:check', () => checkForUpdates(true));
ipcMain.handle('approx:update', () => installUpdate());

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    createWindow();
    setTimeout(() => checkForUpdates(false), 10_000);
    setInterval(() => checkForUpdates(false), 6 * 3600_000);
  });
  app.on('window-all-closed', () => app.quit());
}
