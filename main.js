const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

// ---- Speicherort: automatisch im lokalisierten Musik-Ordner ----
// app.getPath('music') löst auf Windows automatisch den richtigen
// Known Folder auf, egal ob Deutsch ("Musik"), Englisch ("Music")
// oder ein anderes System. NIEMALS Pfad hardcoden wie C:\Users\...\Music!
function getDefaultOutputDir() {
  const music = app.getPath('music');
  return path.join(music, 'AudioScene');
}

function ensureOutputDir(customDir) {
  const dir = customDir || getDefaultOutputDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error('Konnte Ausgabeordner nicht erstellen:', e);
  }
  return dir;
}

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'audioscene-settings.json');
}

function loadSettings() {
  const defaults = {
    outputDir: getDefaultOutputDir(),
    filenameTemplate: 'AudioScene_%Y-%m-%d_%H-%M-%S',
    format: 'webm', // webm | wav
    audioBitrate: 192000, // in bps, UI zeigt kbps
    sampleRate: 48000,
    channels: 2, // 1 = Mono, 2 = Stereo
    hotkeyRecord: 'F9',
    monitoring: false
  };
  try {
    const p = getSettingsPath();
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      return { ...defaults, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.warn('Settings konnten nicht geladen werden, nutze Defaults.', e);
  }
  return defaults;
}

function saveSettings(s) {
  try {
    fs.writeFileSync(getSettingsPath(), JSON.stringify(s, null, 2), 'utf-8');
  } catch (e) {
    console.error('Settings speichern fehlgeschlagen:', e);
  }
}

function createMainWindow() {
  const iconCandidates = [
    path.join(__dirname, 'assets', 'logo-icon.svg'),
    path.join(__dirname, 'assets', 'logo.svg')
  ];
  const winOpts = {
    width: 1280,
    height: 760,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#1b1e27',
    title: 'AudioScene – OBS für Audio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  };
  // SVG-Icon nur setzen wenn vorhanden (Windows braucht für Installer später ICO/PNG,
  // fürs Fenster reicht das hier als Deko – kein harter Fehler wenn es fehlt).
  try {
    const hit = iconCandidates.find((p) => fs.existsSync(p));
    if (hit) winOpts.icon = hit;
  } catch {}
  mainWindow = new BrowserWindow(winOpts);

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const settings = loadSettings();
  ensureOutputDir(settings.outputDir);

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC ----
ipcMain.handle('settings:get', () => {
  return loadSettings();
});

ipcMain.handle('settings:save', (event, next) => {
  const current = loadSettings();
  const merged = { ...current, ...next };
  ensureOutputDir(merged.outputDir);
  saveSettings(merged);
  return merged;
});

ipcMain.handle('settings:default-dir', () => {
  return getDefaultOutputDir();
});

ipcMain.handle('dialog:pick-dir', async () => {
  const settings = loadSettings();
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Aufnahme-Ordner wählen',
    defaultPath: settings.outputDir,
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
});

ipcMain.handle('dialog:save-file', async (event, { filename, filters }) => {
  const settings = loadSettings();
  const res = await dialog.showSaveDialog(mainWindow, {
    title: 'Aufnahme speichern',
    defaultPath: path.join(settings.outputDir, filename),
    filters: filters || [{ name: 'Audio', extensions: ['webm', 'wav'] }]
  });
  if (res.canceled || !res.filePath) return null;
  return res.filePath;
});

ipcMain.handle('file:save-buffer', async (event, { filePath, buffer }) => {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(buffer));
    return { ok: true, path: filePath };
  } catch (e) {
    console.error(e);
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('shell:open-dir', async (event, dir) => {
  const settings = loadSettings();
  const target = dir || settings.outputDir;
  ensureOutputDir(target);
  await shell.openPath(target);
  return true;
});

ipcMain.handle('app:get-music-path', () => {
  // Für Anzeige in den Einstellungen: wo liegt "Musik" auf diesem System?
  return {
    music: app.getPath('music'),
    defaultOutput: getDefaultOutputDir(),
    userData: app.getPath('userData')
  };
});

ipcMain.handle('app:get-version', () => {
  return app.getVersion();
});
