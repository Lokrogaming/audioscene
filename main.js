const { app, BrowserWindow, ipcMain, dialog, shell, desktopCapturer } = require('electron');
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

// ---- Streaming-Aufnahme: Chunks landen sofort auf Platte statt im RAM ----
// Lange Takes crashen sonst (OOM im Renderer). Temp-Datei = .part im
// Aufnahme-Ordner, d. h. selbst bei Crash bleibt der Rest auf der Platte.
const recSessions = new Map(); // sessionId -> { path, ext, wav: {sampleRate, channels} | null, bytes }

function uniquePath(dest) {
  if (!fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const base = path.basename(dest, ext);
  let i = 2;
  let cand = path.join(dir, `${base} (${i})${ext}`);
  while (fs.existsSync(cand)) {
    i += 1;
    cand = path.join(dir, `${base} (${i})${ext}`);
  }
  return cand;
}

function wavHeader(sampleRate, channels) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(0, 4); // RIFF-Größe → beim Finalisieren patchen
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28); // byteRate
  h.writeUInt16LE(channels * 2, 32); // blockAlign
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(0, 40); // data-Größe → beim Finalisieren patchen
  return h;
}

ipcMain.handle('rec:begin', (event, { sessionId, ext, wav }) => {
  try {
    const settings = loadSettings();
    const dir = ensureOutputDir(settings.outputDir);
    const tmp = path.join(dir, `AudioScene_SESSION_${Date.now()}_${Math.floor(Math.random() * 1e6)}.part`);
    if (wav) {
      fs.writeFileSync(tmp, wavHeader(wav.sampleRate, wav.channels));
      recSessions.set(sessionId, { path: tmp, ext, wav, bytes: 44 });
    } else {
      fs.writeFileSync(tmp, Buffer.alloc(0));
      recSessions.set(sessionId, { path: tmp, ext, wav: null, bytes: 0 });
    }
    return { ok: true, path: tmp };
  } catch (e) {
    console.error('rec:begin fehlgeschlagen:', e);
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('rec:append', (event, { sessionId, chunk }) => {
  const s = recSessions.get(sessionId);
  if (!s) return { ok: false, error: 'unknown session' };
  try {
    const buf = Buffer.from(chunk);
    if (buf.length === 0) return { ok: true, bytes: s.bytes };
    fs.appendFileSync(s.path, buf);
    s.bytes += buf.length;
    return { ok: true, bytes: s.bytes };
  } catch (e) {
    console.error('rec:append fehlgeschlagen:', e);
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('rec:finalize', (event, { sessionId, filename }) => {
  const s = recSessions.get(sessionId);
  if (!s) return { ok: false, error: 'unknown session' };
  try {
    if (s.wav) {
      const dataLen = Math.max(0, s.bytes - 44);
      const fd = fs.openSync(s.path, 'r+');
      try {
        const b4 = Buffer.alloc(4);
        b4.writeUInt32LE(36 + dataLen, 0);
        fs.writeSync(fd, b4, 0, 4, 4);
        const b40 = Buffer.alloc(4);
        b40.writeUInt32LE(dataLen, 0);
        fs.writeSync(fd, b40, 0, 4, 40);
      } finally {
        fs.closeSync(fd);
      }
    }
    const settings = loadSettings();
    const dir = ensureOutputDir(settings.outputDir);
    const dest = uniquePath(path.join(dir, filename));
    fs.renameSync(s.path, dest);
    recSessions.delete(sessionId);
    return { ok: true, path: dest, bytes: s.bytes };
  } catch (e) {
    console.error('rec:finalize fehlgeschlagen:', e);
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('rec:abort', (event, { sessionId }) => {
  const s = recSessions.get(sessionId);
  if (!s) return { ok: true };
  recSessions.delete(sessionId);
  try { fs.unlinkSync(s.path); } catch {}
  return { ok: true };
});

// Crash-Reste (.part) zum Anzeigen im Verlauf-Dock
ipcMain.handle('rec:partials', () => {
  try {
    const settings = loadSettings();
    const dir = ensureOutputDir(settings.outputDir);
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.part'))
      .map((f) => {
        const p = path.join(dir, f);
        try {
          const st = fs.statSync(p);
          return { name: f, path: p, size: st.size, mtime: st.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 20);
  } catch (e) {
    console.error('rec:partials fehlgeschlagen:', e);
    return [];
  }
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

// Aufnehmbare Fenster/Bildschirme für die OBS-artige Quellenauswahl.
// (Ob ein Fenster wirklich Ton liefert, entscheidet Windows beim Capture;
// Bildschirme liefern zuverlässig den Loopback.)
ipcMain.handle('windows:list', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 160, height: 90 },
      fetchWindowIcons: true,
    });
    return sources
      .filter((s) => s.name && s.name.trim() && !/audioscene/i.test(s.name))
      .slice(0, 40)
      .map((s) => ({
        id: s.id,
        name: s.name,
        isScreen: s.id.startsWith('screen:'),
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        thumb: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
      }));
  } catch (e) {
    console.error('Fensterliste fehlgeschlagen:', e);
    return [];
  }
});
