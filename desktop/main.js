// Method365 desktop app: a secure window onto the shared Method365 server.
// Nothing is stored locally except this app's settings (the server address); every agreement, signature
// and audit record stays in the server's database, the same one the web app uses.
const { app, BrowserWindow, Menu, Tray, shell, ipcMain, session, dialog, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_ID = 'com.jrsllc.esign';
const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

// Server address: ESIGN_SERVER_URL (set by IT for all PCs) > the user's saved setting > config.json.
function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {}
  const s = { closeToTray: true, ...defaults, ...saved };
  if (process.env.ESIGN_SERVER_URL) s.serverUrl = process.env.ESIGN_SERVER_URL.replace(/\/+$/, '');
  return s;
}
function saveSettings(next) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
}
let settings;
const serverOrigin = () => new URL(settings.serverUrl).origin;
const isServerUrl = (url) => {
  try {
    return new URL(url).origin === serverOrigin();
  } catch {
    return false;
  }
};

let win = null;
let tray = null;
let quitting = false;
let trayHintShown = false;
const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));

// Only one copy of the app runs; opening it again brings the window forward.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function loadServer(pathname = '/') {
  win.loadURL(new URL(pathname, settings.serverUrl).toString());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'Method365',
    icon,
    autoHideMenuBar: true,
    backgroundColor: '#f4f6fa',
    // The preload only exposes its bridge on the app's own local pages (offline screen), never to the website.
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });

  // Links to other websites open in the normal browser; the app only shows the Method365 server.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isServerUrl(url) && !url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isServerUrl(url)) return { action: 'allow', overrideBrowserWindowOptions: { icon, autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } } };
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Server unreachable: show the offline screen with "Try again" and a link to settings.
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = navigation replaced by another one
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { server: settings.serverUrl, error: desc } });
  });

  win.on('close', (e) => {
    if (quitting || !settings.closeToTray) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && tray) {
      tray.displayBalloon({ iconType: 'info', title: 'Method365 is still running', content: 'It keeps notifying you about signatures. Right-click the tray icon to quit.' });
      trayHintShown = true;
    }
  });
  win.on('closed', () => (win = null));
  loadServer('/');
}

function openSettings() {
  const s = new BrowserWindow({
    width: 560, height: 480, parent: win || undefined, modal: !!win, title: 'Method365 settings', icon, autoHideMenuBar: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  s.loadFile(path.join(__dirname, 'settings.html'));
}

function buildMenus() {
  const startAtLogin = app.getLoginItemSettings().openAtLogin;
  const common = [
    { label: 'Open Method365', click: showWindow },
    { label: 'Verify a signed PDF', click: () => { showWindow(); loadServer('/verify.html'); } },
    { type: 'separator' },
    { label: 'Settings…', click: openSettings },
    { label: 'Start with Windows', type: 'checkbox', checked: startAtLogin, click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }); buildMenus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(common));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Settings…', accelerator: 'Ctrl+,', click: openSettings }, { type: 'separator' }, { label: 'Quit', accelerator: 'Ctrl+Q', click: () => { quitting = true; app.quit(); } }] },
    { label: 'View', submenu: [{ role: 'reload' }, { label: 'Back', accelerator: 'Alt+Left', click: () => win?.webContents.navigationHistory.goBack() }, { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { label: 'Help', submenu: [
      { label: 'Download root certificate (for Adobe trust)', click: () => shell.openExternal(new URL('/ca.cer', settings.serverUrl).toString()) },
      { label: 'About Method365', click: () => dialog.showMessageBox(win, { type: 'info', title: 'About Method365', icon, message: `Method365 ${app.getVersion()}`, detail: `Connected to ${settings.serverUrl}\n\nThis app is a window onto your company's Method365 server. Agreements, signatures and audit trails are stored on the server, not on this PC.` }) },
    ] },
  ]));
}

// Requests are accepted only from the app's own local pages, never from the website.
const fromLocalPage = (e) => (e.senderFrame?.url || '').startsWith('file:');
const guarded = (fn) => (e, ...args) => (fromLocalPage(e) ? fn(e, ...args) : { error: 'Not allowed' });

ipcMain.handle('settings:get', guarded(() => ({ ...settings, version: app.getVersion() })));
ipcMain.handle('settings:save', guarded((e, next) => {
  const url = String(next.serverUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return { error: 'Enter the full server address, starting with https://' };
  settings = { ...settings, serverUrl: url, closeToTray: next.closeToTray !== false };
  saveSettings({ serverUrl: settings.serverUrl, closeToTray: settings.closeToTray });
  buildMenus();
  if (win) loadServer('/');
  return { ok: true };
}));
ipcMain.handle('app:retry', guarded(() => { if (win) loadServer('/'); }));
ipcMain.handle('app:openSettings', guarded(() => openSettings()));

app.whenReady().then(() => {
  settings = loadSettings();
  app.setAppUserModelId(APP_ID); // needed for Windows notifications

  // ngrok's free plan shows a warning page to browsers; the app is not a browser, so skip it.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    if (isServerUrl(details.url)) details.requestHeaders['ngrok-skip-browser-warning'] = '1';
    cb({ requestHeaders: details.requestHeaders });
  });
  // The Method365 site may show notifications and copy links; everything else (camera, location…) is refused.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(isServerUrl(details.requestingUrl || wc.getURL()) && ['notifications', 'clipboard-sanitized-write'].includes(permission));
  });

  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png')));
  tray.setToolTip('Method365');
  tray.on('click', showWindow);
  buildMenus();
  if (!process.argv.includes('--hidden')) createWindow();
});

app.on('before-quit', () => (quitting = true));
app.on('window-all-closed', () => { /* keep running in the tray */ });
