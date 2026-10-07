// AudioScene Renderer v0.3.0 – OBS-Logik für Audio
// Szenen mit eigenem Mix, Fensterliste wie in OBS, Datei/Ansicht/Werkzeuge-Menüs,
// Dock-Drag&Drop mit gespeichertem Layout, Extra-Docks, Auto-Save/Restore,
// Formate WebM/OGG/MP3/WAV/M4A, Monitoring, Peak/Clip.

const $ = (id) => document.getElementById(id);
function setText(id, v) { const el = $(id); if (el) el.textContent = v; }

const state = {
  settings: {
    outputDir: '',
    filenameTemplate: 'AudioScene_%Y-%m-%d_%H-%M-%S',
    format: 'webm',
    audioBitrate: 192000,
    sampleRate: 48000,
    channels: 2,
    hotkeyRecord: 'F9',
    monitoring: false,
  },
  scenes: [], // {id, name}
  activeSceneId: null,
  sources: [], // {id, sceneId, name, type, deviceId, windowId, stream, node, gain, analyser, volume, muted, peak, ended, routed, vuData}
  layout: null, // {order:[], visible:{}, extra:[]}
  history: [], // {name, path, size, ext, time}
  audioCtx: null,
  masterGain: null,
  masterAnalyser: null,
  masterDest: null,
  monitorNode: null,
  monitoring: false,
  recorder: null,
  chunks: [],
  recBytes: 0,
  recording: false,
  recStart: 0,
  recTimer: null,
  recordedMime: '',
  recordMode: 'native',
  targetFormat: 'webm',
  pendingType: null,
  pendingWindowType: null,
  pendingWindowId: null,
  windowEntries: [],
  reconnectId: null,
  selectedSourceId: null,
  propsId: null,
  dragDock: null,
  dropTarget: null,
  sessionStart: Date.now(),
};

function fmtShort(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 99999)}`;
}
const FORMAT_LABEL = { webm: 'WebM (Opus)', ogg: 'OGG (Opus)', mp3: 'MP3', wav: 'WAV (PCM)', m4a: 'M4A (AAC)' };
const FORMAT_EXT = ['webm', 'ogg', 'mp3', 'wav', 'm4a'];
function formatLabel(f) { return FORMAT_LABEL[f] || f || 'WebM (Opus)'; }

// ---------- Docks ----------
const CORE_DOCKS = ['scenes', 'sources', 'mixer', 'controls'];
const DOCK_LABEL = {
  scenes: 'Szenen', sources: 'Quellen', mixer: 'Audio-Mixer', controls: 'Steuerung',
  history: 'Aufnahme-Verlauf', master: 'Master-Pegel', stats: 'Statistik',
};
const EXTRA_DOCKS = {
  history: { name: 'Aufnahme-Verlauf', desc: 'Liste aller gespeicherten Takes dieser Sitzung.' },
  master: { name: 'Master-Pegel', desc: 'Große Summen-Anzeige mit Clip-LED.' },
  stats: { name: 'Statistik', desc: 'Szenen, Quellen, Dateien, Laufzeit.' },
};
const coreDockEls = {};
const extraDockEls = {};

function defaultLayout() {
  return { order: [...CORE_DOCKS], visible: { scenes: true, sources: true, mixer: true, controls: true }, extra: [] };
}
function normalizeLayout() {
  if (!state.layout || !Array.isArray(state.layout.order)) state.layout = defaultLayout();
  const known = [...CORE_DOCKS, ...Object.keys(EXTRA_DOCKS)];
  state.layout.order = state.layout.order.filter((id) => known.includes(id));
  CORE_DOCKS.forEach((id) => { if (!state.layout.order.includes(id)) state.layout.order.push(id); });
  (state.layout.extra || []).forEach((id) => { if (EXTRA_DOCKS[id] && !state.layout.order.includes(id)) state.layout.order.push(id); });
  if (!state.layout.visible || typeof state.layout.visible !== 'object') state.layout.visible = {};
  CORE_DOCKS.forEach((id) => { if (state.layout.visible[id] === undefined) state.layout.visible[id] = true; });
  state.layout.extra = (state.layout.extra || []).filter((id) => EXTRA_DOCKS[id]);
  state.layout.extra.forEach((id) => { if (state.layout.visible[id] === undefined) state.layout.visible[id] = true; });
}
function cacheCoreDocks() {
  CORE_DOCKS.forEach((id) => {
    const el = document.querySelector(`.dock[data-dock="${id}"]`);
    if (el) coreDockEls[id] = el;
  });
}
function getDockEl(id) {
  if (CORE_DOCKS.includes(id)) return coreDockEls[id] || null;
  if (!EXTRA_DOCKS[id]) return null;
  if (!extraDockEls[id]) extraDockEls[id] = buildExtraDock(id);
  return extraDockEls[id];
}
function buildExtraDock(id) {
  const el = document.createElement('div');
  el.className = 'dock';
  el.dataset.dock = id;
  if (id === 'history') {
    el.innerHTML = `<div class="dock-title" title="Ziehen zum Umordnen">Aufnahme-Verlauf</div>
      <div class="dock-body"><ul id="history-list" class="list"></ul></div>`;
  } else if (id === 'master') {
    el.innerHTML = `<div class="dock-title" title="Ziehen zum Umordnen">Master-Pegel</div>
      <div class="dock-body">
        <div class="vu big" id="master-vu-wrap"><div id="master-vu"></div></div>
        <div class="s-row"><span id="master-pct">0%</span><span id="master-clip" class="clipdot">● Summe</span></div>
        <p class="muted small">Summe der aktiven Szene. Rot = Clip, dann Mixer runter.</p>
      </div>`;
  } else if (id === 'stats') {
    el.innerHTML = `<div class="dock-title" title="Ziehen zum Umordnen">Statistik</div>
      <div class="dock-body"><div class="stats">
        <div>🎬 Szenen: <span id="stat2-scenes">0</span></div>
        <div>🎚 Quellen: <span id="stat2-sources">0</span></div>
        <div>📼 Takes: <span id="stat2-files">0</span> (<span id="stat2-size">0 MB</span>)</div>
        <div>⏱ Laufzeit: <span id="stat2-uptime">00:00</span></div>
      </div></div>`;
  }
  const title = el.querySelector('.dock-title');
  if (title) title.title = 'Ziehen zum Umordnen (Layout wird gespeichert)';
  return el;
}
function renderDocks() {
  normalizeLayout();
  const bar = $('docks');
  if (!bar) return;
  bar.innerHTML = '';
  state.layout.order.forEach((id) => {
    if (state.layout.visible[id] === false) return;
    const el = getDockEl(id);
    if (el) bar.appendChild(el);
  });
  renderHistory();
  updateStatsDock();
  renderViewMenu();
  renderToolsMenu();
}
function renderViewMenu() {
  const box = $('view-docks');
  if (!box) return;
  box.innerHTML = '';
  state.layout.order.forEach((id) => {
    const on = state.layout.visible[id] !== false;
    const row = document.createElement('button');
    row.className = 'check-row';
    row.innerHTML = `<span class="box">${on ? '☑' : '☐'}</span><span>${escapeHtml(DOCK_LABEL[id] || id)}</span>`;
    row.onclick = () => {
      state.layout.visible[id] = !on;
      renderDocks();
      persistState();
    };
    box.appendChild(row);
  });
}
function renderToolsMenu() {
  const box = $('tools-docks');
  if (!box) return;
  box.innerHTML = '';
  Object.entries(EXTRA_DOCKS).forEach(([id, def]) => {
    const added = state.layout.extra.includes(id);
    const row = document.createElement('button');
    row.className = 'check-row';
    row.innerHTML = `<span class="box">${added ? '✓' : '+'}</span><span><b>${escapeHtml(def.name)}</b><small>${escapeHtml(def.desc)}</small></span>`;
    row.onclick = () => toggleExtraDock(id);
    box.appendChild(row);
  });
}
function toggleExtraDock(id) {
  const i = state.layout.extra.indexOf(id);
  if (i >= 0) {
    state.layout.extra.splice(i, 1);
    state.layout.order = state.layout.order.filter((x) => x !== id);
    delete extraDockEls[id];
    $('status-left').textContent = `Dock entfernt: ${EXTRA_DOCKS[id].name}`;
  } else {
    state.layout.extra.push(id);
    state.layout.order.push(id);
    state.layout.visible[id] = true;
    $('status-left').textContent = `Dock hinzugefügt: ${EXTRA_DOCKS[id].name}`;
  }
  renderDocks();
  persistState();
}
function moveDockInOrder(dragId, target) {
  if (!target) return;
  const order = state.layout.order.filter((x) => x !== dragId);
  let idx = order.indexOf(target.id);
  if (idx < 0) idx = order.length;
  else if (target.after) idx += 1;
  order.splice(idx, 0, dragId);
  state.layout.order = order;
  renderDocks();
  persistState();
}
function initDockDrag() {
  const bar = $('docks');
  if (!bar) return;
  // Titel als Griff: erst bei Mousedown draggable, damit Slider/Inputs normal bleiben
  bar.addEventListener('mousedown', (e) => {
    const dock = e.target.closest('.dock');
    if (e.target.closest('.dock-title') && dock) dock.draggable = true;
  });
  document.addEventListener('mouseup', () => {
    bar.querySelectorAll('.dock').forEach((d) => { d.draggable = false; });
  });
  bar.addEventListener('dragstart', (e) => {
    const dock = e.target.closest('.dock');
    if (!dock) return;
    state.dragDock = dock.dataset.dock;
    try {
      e.dataTransfer.setData('text/plain', state.dragDock);
      e.dataTransfer.effectAllowed = 'move';
    } catch {}
    setTimeout(() => dock.classList.add('dragging'), 0);
  });
  const clearMarks = () => bar.querySelectorAll('.drop-before,.drop-after').forEach((d) => d.classList.remove('drop-before', 'drop-after'));
  bar.addEventListener('dragend', () => {
    bar.querySelectorAll('.dock').forEach((d) => { d.classList.remove('dragging'); d.draggable = false; });
    clearMarks();
    state.dragDock = null;
    state.dropTarget = null;
  });
  bar.addEventListener('dragover', (e) => {
    if (!state.dragDock) return;
    e.preventDefault();
    clearMarks();
    const dock = e.target.closest('.dock');
    if (!dock || dock.dataset.dock === state.dragDock) { state.dropTarget = null; return; }
    const r = dock.getBoundingClientRect();
    const after = (e.clientX - r.left) > r.width / 2;
    dock.classList.add(after ? 'drop-after' : 'drop-before');
    state.dropTarget = { id: dock.dataset.dock, after };
  });
  bar.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!state.dragDock) return;
    moveDockInOrder(state.dragDock, state.dropTarget);
    state.dropTarget = null;
  });
}

// ---------- Audio-Engine ----------
function ensureCtx() {
  if (!state.audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new AC({ sampleRate: state.settings.sampleRate });
    state.masterGain = state.audioCtx.createGain();
    state.masterGain.gain.value = 1.0;
    state.masterAnalyser = state.audioCtx.createAnalyser();
    state.masterAnalyser.fftSize = 2048;
    state.masterDest = state.audioCtx.createMediaStreamDestination();
    state.masterGain.connect(state.masterAnalyser);
    state.masterAnalyser.connect(state.masterDest);
  }
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
}

function setMonitoring(on) {
  ensureCtx();
  state.monitoring = !!on;
  try {
    if (state.monitoring && !state.monitorNode) {
      state.monitorNode = state.audioCtx.createGain();
      state.monitorNode.gain.value = 1.0;
      state.masterGain.connect(state.monitorNode);
      state.monitorNode.connect(state.audioCtx.destination);
    } else if (!state.monitoring && state.monitorNode) {
      try { state.masterGain.disconnect(state.monitorNode); } catch {}
      try { state.monitorNode.disconnect(); } catch {}
      state.monitorNode = null;
    }
  } catch (e) {
    console.warn('Monitoring umschalten fehlgeschlagen:', e);
  }
  const btn = $('btn-monitor');
  if (btn) {
    btn.textContent = state.monitoring ? '🔊 Mithören: an' : '🔇 Mithören: aus';
    btn.classList.toggle('on', state.monitoring);
  }
  if (window.audioScene) {
    window.audioScene.saveSettings({ monitoring: state.monitoring }).catch(() => {});
  }
}

// Nur Quellen der aktiven Szene laufen auf den Master (wie OBS: nur aktive Szene hörbar).
function applySceneRouting() {
  if (!state.audioCtx) return;
  state.sources.forEach((s) => {
    if (!s.analyser) return;
    const shouldRoute = s.sceneId === state.activeSceneId;
    try {
      if (shouldRoute && !s.routed) {
        s.analyser.connect(state.masterGain);
        s.routed = true;
      } else if (!shouldRoute && s.routed) {
        try { s.analyser.disconnect(state.masterGain); } catch { try { s.analyser.disconnect(); } catch {} }
        s.routed = false;
      }
    } catch (e) {
      console.warn('Routing fehlgeschlagen:', e);
    }
  });
}

// ---------- Settings ----------
async function loadSettings() {
  if (window.audioScene) {
    state.settings = await window.audioScene.getSettings();
    const paths = await window.audioScene.getPaths().catch(() => null);
    if (paths) {
      setText('music-info', `Musik-Ordner auf diesem System: ${paths.music} → Aufnahmen: ${state.settings.outputDir} (wird automatisch erstellt)`);
    }
  }
  if (!state.settings.filenameTemplate) state.settings.filenameTemplate = 'AudioScene_%Y-%m-%d_%H-%M-%S';
  refreshSettingsUI();
  refreshStatusLine();
}
function refreshSettingsUI() {
  const s = state.settings;
  const out = $('set-output'); if (out) out.value = s.outputDir || '';
  const tpl = $('set-template'); if (tpl) tpl.value = s.filenameTemplate || 'AudioScene_%Y-%m-%d_%H-%M-%S';
  const fmt = $('set-format'); if (fmt) fmt.value = s.format || 'webm';
  const sr = $('set-samplerate'); if (sr) sr.value = String(s.sampleRate || 48000);
  const ch = $('set-channels'); if (ch) ch.value = String(s.channels || 2);
  const br = $('set-bitrate'); if (br) br.value = String(s.audioBitrate || 192000);
  const hk = $('set-hotkey'); if (hk) hk.value = s.hotkey || s.hotkeyRecord || 'F9';
  const f = FORMAT_EXT.includes(s.format) ? s.format : 'webm';
  const kbps = Math.round((s.audioBitrate || 192000) / 1000);
  setText('stat-path', s.outputDir || '–');
  setText('stat-bitrate', f === 'wav' ? 'PCM (verlustfrei)' : `${kbps} kbps`);
  setText('status-format', `Format: ${formatLabel(f)}${f === 'wav' ? '' : ` · ${kbps} kbps`} · ${((s.sampleRate || 48000) / 1000).toFixed(1)} kHz · ${s.channels === 1 ? 'Mono' : 'Stereo'}`);
  const hint = $('bitrate-hint');
  if (hint) {
    hint.textContent =
      f === 'wav' ? 'WAV ist unkomprimiert – die Bitrate wird ignoriert (Datei wird groß).' :
      f === 'mp3' ? 'MP3 wird nach Stop aus der Aufnahme kodiert (dauert ein paar Sekunden).' :
      f === 'm4a' ? 'M4A nutzt den System-Encoder – falls nicht unterstützt, wird WebM gespeichert.' :
      'Opus-Bitrate gilt direkt für die Aufnahme.';
  }
}

async function saveSettingsFromUI() {
  const next = {
    outputDir: $('set-output').value,
    filenameTemplate: $('set-template').value.trim() || 'AudioScene_%Y-%m-%d_%H-%M-%S',
    format: $('set-format').value,
    sampleRate: parseInt($('set-samplerate').value, 10),
    channels: parseInt($('set-channels').value, 10),
    audioBitrate: parseInt($('set-bitrate').value, 10),
    hotkeyRecord: $('set-hotkey').value || 'F9',
  };
  if (window.audioScene) {
    state.settings = await window.audioScene.saveSettings(next);
  } else {
    state.settings = { ...state.settings, ...next };
  }
  refreshSettingsUI();
}

// ---------- Auto-Save / Restore (Szenen, Quellen, Layout) ----------
let persistTimer = null;
function persistState() {
  if (!window.audioScene) return;
  try {
    window.audioScene.saveSettings({
      scenes: state.scenes,
      activeSceneId: state.activeSceneId,
      sources: state.sources.map((s) => ({
        id: s.id, sceneId: s.sceneId, name: s.name, type: s.type,
        deviceId: s.deviceId || null, windowId: s.windowId || null,
        volume: s.volume, muted: s.muted,
      })),
      layout: state.layout,
    }).catch(() => {});
  } catch {}
}
function persistDebounced() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistState, 500);
}

async function restoreState() {
  const st = state.settings;
  if (Array.isArray(st.scenes) && st.scenes.length) {
    state.scenes = st.scenes.filter((x) => x && x.id && x.name);
    if (!state.scenes.length) defaultScenes();
    else state.activeSceneId = state.scenes.some((x) => x.id === st.activeSceneId) ? st.activeSceneId : state.scenes[0].id;
  } else {
    defaultScenes();
  }
  if (st.layout) state.layout = st.layout;
  normalizeLayout();
  const saved = Array.isArray(st.sources) ? st.sources : [];
  state.sources = [];
  state.selectedSourceId = null;
  for (const meta of saved) {
    if (!meta || !meta.sceneId || !state.scenes.some((x) => x.id === meta.sceneId)) continue;
    if (meta.type === 'mic') {
      // Eingabegeräte still wiederherstellen (braucht keinen Klick)
      try {
        ensureCtx();
        const constraints = meta.deviceId
          ? { audio: { deviceId: { exact: meta.deviceId }, echoCancellation: false, noiseSuppression: false } }
          : { audio: { echoCancellation: false, noiseSuppression: false } };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        createSourceNode('mic', meta.deviceId || null, meta.name, stream, {
          id: meta.id, sceneId: meta.sceneId, volume: meta.volume, muted: meta.muted, quiet: true,
        });
      } catch (e) {
        console.warn('Mic-Restore fehlgeschlagen:', meta.name, e);
        state.sources.push(createPlaceholder(meta));
      }
    } else {
      // App-/System-Sound braucht einen Klick (System-Schutz) → Platzhalter zum Neuverbinden
      state.sources.push(createPlaceholder(meta));
    }
  }
  const mine = sceneSources();
  state.selectedSourceId = mine.length ? mine[0].id : null;
  applySceneRouting();
}

function createPlaceholder(meta) {
  return {
    id: meta.id || uid('src'),
    sceneId: meta.sceneId,
    name: meta.name || 'Quelle',
    type: meta.type || 'app',
    deviceId: meta.deviceId || null,
    windowId: meta.windowId || null,
    stream: null, node: null, gain: null, analyser: null,
    volume: typeof meta.volume === 'number' ? meta.volume : 1,
    muted: !!meta.muted,
    peak: 0, ended: true, routed: false,
    vuData: new Uint8Array(256),
  };
}

function activeScene() {
  return state.scenes.find((sc) => sc.id === state.activeSceneId) || null;
}
function sceneSources() {
  return state.sources.filter((s) => s.sceneId === state.activeSceneId);
}

function refreshStatusLine() {
  const mine = sceneSources();
  const sc = activeScene();
  setText('stat-count', `${mine.length} ${mine.length === 1 ? 'Quelle' : 'Quellen'} (total ${state.sources.length})`);
  setText('stat-scene', sc ? sc.name : '–');
  setText('status-devices', mine.length === 0 ? 'Geräte: –' : `Geräte: ${mine.length} aktiv in „${sc ? sc.name : '–'}“`);
  updateStatsDock();
}
function updateStatsDock() {
  setText('stat2-scenes', String(state.scenes.length));
  setText('stat2-sources', String(state.sources.length));
  setText('stat2-files', String(state.history.length));
  const mb = state.history.reduce((a, h) => a + (h.size || 0), 0) / 1024 / 1024;
  setText('stat2-size', `${mb.toFixed(1)} MB`);
  setText('stat2-uptime', fmtShort(Date.now() - state.sessionStart));
}

// ---------- Szenen ----------
function defaultScenes() {
  const a = { id: uid('scene'), name: '🎧 Podcast-Mix' };
  const b = { id: uid('scene'), name: '🎮 Game + Voice' };
  const c = { id: uid('scene'), name: '🎵 Nur Musik' };
  state.scenes = [a, b, c];
  state.activeSceneId = a.id;
}

function renderScenes() {
  const ul = $('scene-list');
  if (!ul) return;
  ul.innerHTML = '';
  state.scenes.forEach((sc) => {
    const li = document.createElement('li');
    li.dataset.id = sc.id;
    if (sc.id === state.activeSceneId) li.classList.add('active');
    const count = state.sources.filter((s) => s.sceneId === sc.id).length;
    li.innerHTML = `<span>${escapeHtml(sc.name)}</span><span class="eye">${count}</span>`;
    li.onclick = () => selectScene(sc.id);
    li.ondblclick = () => renameSceneInline(li, sc);
    ul.appendChild(li);
  });
  refreshStatusLine();
}

function selectScene(id) {
  if (!state.scenes.some((sc) => sc.id === id)) return;
  state.activeSceneId = id;
  const mine = sceneSources();
  state.selectedSourceId = mine.length ? mine[0].id : null;
  applySceneRouting();
  renderScenes();
  renderSources();
  renderMixer();
  persistState();
}

function addScene() {
  const sc = { id: uid('scene'), name: `Szene ${state.scenes.length + 1}` };
  state.scenes.push(sc);
  selectScene(sc.id);
  $('status-left').textContent = `Szene angelegt: ${sc.name} (Doppelklick zum Umbenennen)`;
}

function removeScene() {
  if (state.scenes.length <= 1) {
    alert('Die letzte Szene kann nicht gelöscht werden.');
    return;
  }
  const idx = state.scenes.findIndex((sc) => sc.id === state.activeSceneId);
  if (idx < 0) return;
  const [gone] = state.scenes.splice(idx, 1);
  const doomed = state.sources.filter((s) => s.sceneId === gone.id);
  doomed.forEach(teardownSource);
  state.sources = state.sources.filter((s) => s.sceneId !== gone.id);
  state.activeSceneId = state.scenes[Math.max(0, idx - 1)].id;
  applySceneRouting();
  renderScenes();
  renderSources();
  renderMixer();
  persistState();
  $('status-left').textContent = `Szene gelöscht: ${gone.name} (${doomed.length} Quellen entfernt)`;
}

function moveScene(dir) {
  const i = state.scenes.findIndex((sc) => sc.id === state.activeSceneId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.scenes.length) return;
  const [sc] = state.scenes.splice(i, 1);
  state.scenes.splice(j, 0, sc);
  renderScenes();
  persistState();
}

function renameSceneInline(li, sc) {
  li.innerHTML = '';
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = sc.name;
  input.maxLength = 40;
  li.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      if (v) sc.name = v;
    }
    renderScenes();
    persistState();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit(true);
    if (e.key === 'Escape') commit(false);
  };
  input.onblur = () => commit(true);
}

// ---------- Quellen-UI ----------
function renderSources() {
  const ul = $('source-list');
  if (!ul) return;
  ul.innerHTML = '';
  const mine = sceneSources();
  mine.forEach((s) => {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    if (s.id === state.selectedSourceId) li.classList.add('selected');
    const icon = s.type === 'app' ? '🖥️' : s.type === 'mic' ? '🎤' : '🔈';
    const flag = s.ended ? ' ⚠' : '';
    li.innerHTML = `<span>${icon} ${escapeHtml(s.name)}${flag}</span><span class="eye">${s.muted ? '🔇' : '👁'}</span>`;
    li.title = s.ended ? 'Offline – Doppelklick zum Neuverbinden' : 'Doppelklick: Eigenschaften';
    li.onclick = () => {
      state.selectedSourceId = s.id;
      renderSources();
      renderMixer();
    };
    li.ondblclick = () => openProps(s.id);
    ul.appendChild(li);
  });
  if (mine.length === 0) {
    const li = document.createElement('li');
    const sc = activeScene();
    li.innerHTML = `<span class="muted">Keine Quelle in „${escapeHtml(sc ? sc.name : '–')}“ – klicke auf +</span>`;
    ul.appendChild(li);
  }
  const empty = $('preview-empty');
  if (empty) empty.classList.toggle('hidden', mine.length > 0);
  refreshStatusLine();
}

function renderMixer() {
  const box = $('mixer');
  if (!box) return;
  box.innerHTML = '';
  const mine = sceneSources();
  if (mine.length === 0) {
    box.innerHTML = '<div class="mixer-empty">Keine Quellen in dieser Szene.<br />Klicke auf + bei Quellen.</div>';
    return;
  }
  mine.forEach((s) => {
    const div = document.createElement('div');
    div.className = 'strip' + (s.peak > 0.99 ? ' clipped' : '');
    div.id = `strip-${s.id}`;
    const typeLabel = s.type === 'app' ? 'Anwendungs-Audio' : s.type === 'mic' ? 'Eingabegerät' : 'Ausgabegerät';
    const offline = s.gain ? '' : ' · ⚠ offline';
    const db = s.volume <= 0.001 ? '-inf' : (20 * Math.log10(s.volume)).toFixed(1);
    div.innerHTML = `
      <div class="s-name">${escapeHtml(s.name)}${s.ended ? ' ⚠' : ''}</div>
      <div class="s-type">${typeLabel}${offline}</div>
      <div class="vu" id="vuWrap-${s.id}"><div id="vu-${s.id}"></div></div>
      <input type="range" min="0" max="100" value="${Math.round(s.volume * 100)}" id="vol-${s.id}" title="Lautstärke" />
      <div class="s-row">
        <span id="db-${s.id}">${db} dB</span>
        <span class="mute ${s.muted ? 'muted' : ''}" id="mute-${s.id}" title="Stummschalten">🔊</span>
      </div>
      <div class="peak" id="peak-${s.id}">${s.gain ? 'Peak 0%' : 'Doppelklick: verbinden'}</div>`;
    div.ondblclick = () => openProps(s.id);
    box.appendChild(div);
    $(`vol-${s.id}`).oninput = (e) => {
      s.volume = e.target.value / 100;
      if (s.gain) s.gain.gain.value = s.muted ? 0 : s.volume;
      const v = s.volume <= 0.001 ? '-inf' : (20 * Math.log10(s.volume)).toFixed(1);
      setText(`db-${s.id}`, `${v} dB`);
      persistDebounced();
    };
    $(`mute-${s.id}`).onclick = () => {
      s.muted = !s.muted;
      if (s.gain) s.gain.gain.value = s.muted ? 0 : s.volume;
      renderSources();
      renderMixer();
      persistState();
    };
  });
}

// ---------- Geräte ----------
async function listAudioDevices(kind) {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === kind);
  } catch {
    return [];
  }
}

// Gezieltes Fenster/Screen-Capture (Electron desktopCapturer-ID). Liefert nur
// Tonspuren (Video wird verworfen). Gibt null zurück, wenn kein Ton mitkommt.
async function captureDesktop(windowId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: windowId } },
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: windowId, maxWidth: 1280, maxHeight: 720, maxFrameRate: 5 } },
  });
  stream.getVideoTracks().forEach((t) => { try { t.stop(); } catch {} });
  const at = stream.getAudioTracks();
  if (!at.length) {
    stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    return null;
  }
  return new MediaStream(at);
}

// Manueller Fallback: System-Dialog mit „Systemaudio teilen“-Haken
async function manualLoopback() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  stream.getVideoTracks().forEach((t) => { try { t.stop(); } catch {} });
  const at = stream.getAudioTracks();
  if (!at.length) {
    stream.getTracks().forEach((t) => { try { t.stop(); } catch {} });
    alert('Kein Audio freigegeben. Bitte im Dialog „Systemaudio teilen“ aktivieren.');
    return null;
  }
  return new MediaStream(at);
}

// Quelle hinzufügen (Mic direkt, App/Sound laufen über den Fenster-Picker)
async function addSource(type, deviceId, name) {
  ensureCtx();
  let stream = null;
  try {
    if (type === 'mic') {
      const constraints = deviceId
        ? { audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false } }
        : { audio: { echoCancellation: false, noiseSuppression: false } };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } else {
      stream = await manualLoopback();
    }
  } catch (e) {
    console.warn('Quelle abgebrochen:', e);
    return;
  }
  if (!stream) return;
  createSourceNode(type, deviceId, name, stream, {});
}

function createSourceNode(type, deviceId, name, stream, opts) {
  ensureCtx();
  opts = opts || {};
  const srcNode = state.audioCtx.createMediaStreamSource(stream);
  const gain = state.audioCtx.createGain();
  const analyser = state.audioCtx.createAnalyser();
  analyser.fftSize = 512;
  srcNode.connect(gain);
  gain.connect(analyser);
  const s = {
    id: opts.id || uid('src'),
    sceneId: opts.sceneId || state.activeSceneId,
    name: name || defaultName(type),
    type,
    deviceId: deviceId || null,
    windowId: opts.windowId || null,
    stream,
    node: srcNode,
    gain,
    analyser,
    volume: typeof opts.volume === 'number' ? opts.volume : 1.0,
    muted: !!opts.muted,
    peak: 0,
    ended: false,
    routed: false,
    vuData: new Uint8Array(analyser.frequencyBinCount),
  };
  gain.gain.value = s.muted ? 0 : s.volume;
  stream.getTracks().forEach((t) => {
    t.onended = () => {
      s.ended = true;
      renderSources();
      renderMixer();
      $('status-left').textContent = `Hinweis: Quelle „${s.name}“ wurde vom System beendet.`;
    };
  });
  state.sources.push(s);
  applySceneRouting();
  if (!opts.quiet) {
    state.selectedSourceId = s.id;
    renderScenes();
    renderSources();
    renderMixer();
    persistState();
    $('status-left').textContent = `Quelle hinzugefügt: ${s.name}`;
  }
  return s;
}

// Bestehende Quelle (z. B. Platzhalter nach Neustart) mit neuem Stream versorgen
function attachStreamToSource(s, stream) {
  ensureCtx();
  try { if (s.stream) s.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (s.node) s.node.disconnect(); } catch {}
  try { if (s.gain) s.gain.disconnect(); } catch {}
  try { if (s.analyser) s.analyser.disconnect(); } catch {}
  const srcNode = state.audioCtx.createMediaStreamSource(stream);
  const gain = state.audioCtx.createGain();
  gain.gain.value = s.muted ? 0 : s.volume;
  const analyser = state.audioCtx.createAnalyser();
  analyser.fftSize = 512;
  srcNode.connect(gain);
  gain.connect(analyser);
  s.stream = stream;
  s.node = srcNode;
  s.gain = gain;
  s.analyser = analyser;
  s.vuData = new Uint8Array(analyser.frequencyBinCount);
  s.peak = 0;
  s.ended = false;
  s.routed = false;
  applySceneRouting();
  stream.getTracks().forEach((t) => {
    t.onended = () => {
      s.ended = true;
      renderSources();
      renderMixer();
    };
  });
}

function teardownSource(s) {
  try { if (s.stream) s.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (s.node) s.node.disconnect(); } catch {}
  try { if (s.gain) s.gain.disconnect(); } catch {}
  try { if (s.analyser) s.analyser.disconnect(); } catch {}
}

function defaultName(type) {
  const n = sceneSources().length + 1;
  if (type === 'app') return `Anwendungs-Audio ${n}`;
  if (type === 'mic') return `Mikrofon ${n}`;
  return `System-Sound ${n}`;
}

function removeSelectedSource() {
  const id = state.selectedSourceId;
  if (!id) return;
  const idx = state.sources.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const [s] = state.sources.splice(idx, 1);
  teardownSource(s);
  const mine = sceneSources();
  state.selectedSourceId = mine.length ? mine[0].id : null;
  renderScenes();
  renderSources();
  renderMixer();
  persistState();
}

function moveSource(dir) {
  const mine = sceneSources();
  const i = mine.findIndex((s) => s.id === state.selectedSourceId);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= mine.length) return;
  const a = state.sources.indexOf(mine[i]);
  const b = state.sources.indexOf(mine[j]);
  const tmp = state.sources[a];
  state.sources[a] = state.sources[b];
  state.sources[b] = tmp;
  renderSources();
  renderMixer();
  persistState();
}

// ---------- Fenster-/Prozess-Liste (wie OBS) ----------
async function openWindowPicker(type, presetName) {
  state.pendingWindowType = type;
  state.pendingWindowId = null;
  $('window-picker').classList.remove('hidden');
  $('window-name').value = presetName || defaultName(type);
  await refreshWindowList();
}

async function refreshWindowList() {
  const box = $('window-list');
  if (!box) return;
  box.innerHTML = '<p class="muted small" style="padding:8px">Suche aufnehmbare Fenster…</p>';
  let entries = [];
  if (window.audioScene && window.audioScene.listWindows) {
    try { entries = await window.audioScene.listWindows(); } catch (e) { console.warn(e); }
  }
  state.windowEntries = entries;
  box.innerHTML = '';
  if (!entries.length) {
    box.innerHTML = '<p class="muted small" style="padding:8px">Keine Fenster gefunden – nutze „Manuell (System-Dialog)“.</p>';
    return;
  }
  entries.forEach((w) => {
    const row = document.createElement('div');
    row.className = 'win-row' + (w.id === state.pendingWindowId ? ' selected' : '');
    const badge = w.isScreen ? 'Bildschirm · Loopback' : 'Fenster';
    const icon = w.icon ? `<img class="wicon" src="${w.icon}" alt="" />` : '<span class="wicon t-icon">🪟</span>';
    row.innerHTML = `${icon}<span class="wname">${escapeHtml(w.name)}</span><span class="wbadge">${badge}</span>`;
    row.title = w.isScreen ? 'Liefert zuverlässig den Systemsound' : 'Ton hängt von Windows ab – sonst „Manuell“ nutzen';
    row.onclick = () => {
      state.pendingWindowId = w.id;
      box.querySelectorAll('.win-row').forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      if (!$('window-name').value.trim()) $('window-name').value = shortWindowName(w);
    };
    box.appendChild(row);
  });
}

function shortWindowName(w) {
  const n = String(w.name || '').split('–')[0].split(' - ')[0].trim();
  return (n || w.name || 'Quelle').slice(0, 40);
}

async function confirmWindowAdd() {
  const type = state.pendingWindowType || 'app';
  const name = $('window-name').value.trim() || defaultName(type);
  const wid = state.pendingWindowId;
  let stream = null;
  if (!wid || wid === '__manual__') {
    closeModal('modal-source');
    $('window-picker').classList.add('hidden');
    try { stream = await manualLoopback(); } catch (e) { console.warn(e); }
  } else {
    try {
      stream = await captureDesktop(wid);
    } catch (e) { console.warn('Desktop-Capture fehlgeschlagen:', e); stream = null; }
    if (!stream) {
      if (!confirm('Dieses Fenster liefert keine Tonspur. Jetzt den manuellen System-Dialog öffnen (Haken bei „Systemaudio teilen“)?')) return;
      closeModal('modal-source');
      $('window-picker').classList.add('hidden');
      try { stream = await manualLoopback(); } catch (e) { console.warn(e); }
    } else {
      closeModal('modal-source');
      $('window-picker').classList.add('hidden');
    }
  }
  if (!stream) return;
  if (state.reconnectId) {
    const s = state.sources.find((x) => x.id === state.reconnectId);
    state.reconnectId = null;
    if (!s) return;
    s.windowId = wid && wid !== '__manual__' ? wid : s.windowId;
    attachStreamToSource(s, stream);
    if (name) s.name = name;
    renderScenes();
    renderSources();
    renderMixer();
    persistState();
    $('status-left').textContent = `Quelle neu verbunden: ${s.name}`;
  } else {
    createSourceNode(type, null, name, stream, { windowId: wid && wid !== '__manual__' ? wid : null });
  }
}

function startReconnect(id) {
  const s = state.sources.find((x) => x.id === id);
  if (!s) return;
  closeModal('modal-props');
  state.reconnectId = id;
  state.pendingWindowType = s.type;
  $('device-picker').classList.add('hidden');
  openModal('modal-source');
  openWindowPicker(s.type, s.name);
}

// ---------- Quellen-Eigenschaften ----------
async function openProps(id) {
  const s = state.sources.find((x) => x.id === id);
  if (!s) return;
  state.propsId = id;
  const typeName = s.type === 'app' ? 'Anwendungs-Audio' : s.type === 'mic' ? 'Eingabegerät' : 'Ausgabegerät';
  setText('props-sub', `${typeName} · Szene „${activeScene() ? activeScene().name : '–'}“${s.ended ? ' · ⚠ offline' : ''}`);
  $('props-name').value = s.name;
  $('props-vol').value = Math.round(s.volume * 100);
  setText('props-vol-val', String(Math.round(s.volume * 100)));
  const recBtn = $('btn-props-reconnect');
  if (recBtn) recBtn.classList.toggle('hidden', !(s.ended && !s.node && s.type !== 'mic'));
  const wrap = $('props-device-wrap');
  const sel = $('props-device');
  sel.innerHTML = '';
  if (s.type === 'mic') {
    wrap.style.display = '';
    $('props-device-label').textContent = 'Eingabegerät';
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).then((st) => st.getTracks().forEach((t) => t.stop())).catch(() => {});
    } catch {}
    const devs = await listAudioDevices('audioinput');
    if (devs.length === 0) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'Standard-Mikrofon';
      sel.appendChild(o);
    } else {
      devs.forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Mikrofon ${i + 1}`;
        sel.appendChild(o);
      });
      if (s.deviceId) sel.value = s.deviceId;
    }
  } else {
    wrap.style.display = 'none';
  }
  openModal('modal-props');
}

async function saveProps() {
  const s = state.sources.find((x) => x.id === state.propsId);
  if (!s) { closeModal('modal-props'); return; }
  const newName = $('props-name').value.trim();
  if (newName) s.name = newName;
  s.volume = Math.max(0, Math.min(100, parseInt($('props-vol').value, 10) || 0)) / 100;
  if (s.gain) s.gain.gain.value = s.muted ? 0 : s.volume;

  if (s.type === 'mic') {
    const want = $('props-device').value || null;
    if (want && want !== s.deviceId) {
      try {
        await switchMicDevice(s, want);
        $('status-left').textContent = `Gerät gewechselt: ${s.name}`;
      } catch (e) {
        alert('Gerätewechsel fehlgeschlagen: ' + (e.message || e));
      }
    }
  }
  closeModal('modal-props');
  renderSources();
  renderMixer();
  persistState();
}

async function switchMicDevice(s, deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false },
  });
  s.deviceId = deviceId;
  attachStreamToSource(s, stream);
}

// ---------- Aufnahme ----------
function buildFilename(forceExt) {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const tpl = state.settings.filenameTemplate || 'AudioScene_%Y-%m-%d_%H-%M-%S';
  const stamp = tpl
    .replaceAll('%Y', String(now.getFullYear()))
    .replaceAll('%m', p(now.getMonth() + 1))
    .replaceAll('%d', p(now.getDate()))
    .replaceAll('%H', p(now.getHours()))
    .replaceAll('%M', p(now.getMinutes()))
    .replaceAll('%S', p(now.getSeconds()));
  const clean = stamp.replace(/[<>:\"/\\|?*]/g, '_');
  let ext = forceExt || state.settings.format || 'webm';
  if (!FORMAT_EXT.includes(ext)) ext = 'webm';
  return `${clean || 'AudioScene_Aufnahme'}.${ext}`;
}

async function startRecording() {
  if (state.recording) return;
  const mine = sceneSources();
  if (mine.length === 0) {
    alert('Bitte zuerst eine Quelle in dieser Szene hinzufügen (+ bei Quellen).');
    return;
  }
  ensureCtx();
  if (mine.every((s) => s.muted)) {
    if (!confirm('Alle Quellen dieser Szene sind stumm – trotzdem aufnehmen (Stille)?')) return;
  }
  // Zielformat → Strategie: webm/ogg/m4a nativ, wav/mp3 als WebM + wandeln
  const target = FORMAT_EXT.includes(state.settings.format) ? state.settings.format : 'webm';
  const NATIVE_MIMES = {
    webm: ['audio/webm;codecs=opus', 'audio/webm'],
    ogg: ['audio/ogg;codecs=opus', 'audio/ogg'],
    m4a: ['audio/mp4;codecs=mp4a', 'audio/aac', 'audio/mp4'],
  };
  const supported = (m) => { try { return window.MediaRecorder && MediaRecorder.isTypeSupported(m); } catch { return false; } };
  let mime = '';
  let recordMode = 'native';
  if (target === 'wav' || target === 'mp3') {
    for (const c of ['audio/webm;codecs=opus', 'audio/webm']) {
      if (supported(c)) { mime = c; break; }
    }
    recordMode = 'transcode';
  } else {
    for (const c of NATIVE_MIMES[target] || []) {
      if (supported(c)) { mime = c; break; }
    }
    if (!mime) {
      for (const c of ['audio/webm;codecs=opus', 'audio/webm']) {
        if (supported(c)) { mime = c; break; }
      }
      recordMode = 'fallback-webm';
    }
  }
  if (!mime) {
    alert('Dieser Build unterstützt kein Audio-Recording (MediaRecorder fehlt).');
    return;
  }
  if (target === 'mp3' && (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder)) {
    alert('MP3-Encoder (src/vendor/lame.min.js) wurde nicht geladen – es wird WebM gespeichert.');
    state.settings.format = 'webm';
    refreshSettingsUI();
    return;
  }
  state.recordedMime = mime;
  state.recordMode = recordMode;
  state.targetFormat = target;
  const opts = { mimeType: mime };
  if (state.settings.audioBitrate) opts.audioBitsPerSecond = state.settings.audioBitrate;

  try {
    state.recorder = new MediaRecorder(state.masterDest.stream, opts);
  } catch (e) {
    alert('Recorder konnte nicht gestartet werden: ' + e.message);
    return;
  }
  state.chunks = [];
  state.recBytes = 0;
  state.recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      state.chunks.push(e.data);
      state.recBytes += e.data.size;
    }
  };
  state.recorder.onstop = saveRecording;
  state.recorder.start(250);

  state.recording = true;
  state.recStart = Date.now();
  $('btn-record').disabled = true;
  $('btn-record').classList.add('recording');
  $('btn-record').textContent = '⏺ Nimmt auf…';
  $('btn-stop').disabled = false;
  $('rec-badge').classList.remove('hidden');
  const sc = activeScene();
  const kbpsNow = Math.round((state.settings.audioBitrate || 192000) / 1000);
  const modeNote = recordMode === 'transcode' ? ` → wird zu ${target.toUpperCase()} gewandelt`
    : recordMode === 'fallback-webm' ? ` (Ziel ${target.toUpperCase()} nicht unterstützt → WebM)` : '';
  $('status-left').textContent = `Aufnahme läuft… („${sc ? sc.name : '–'}“, Ziel: ${formatLabel(target)}, ${mime}${target === 'wav' ? '' : `, ${kbpsNow} kbps`}${modeNote})`;

  state.recTimer = setInterval(() => {
    const el = Date.now() - state.recStart;
    setText('rec-time', fmtShort(el));
    setText('clock', new Date().toLocaleTimeString('de-DE'));
    $('status-left').textContent =
      `Aufnahme läuft… (${fmtShort(el)} · ${(state.recBytes / 1024 / 1024).toFixed(1)} MB${recordMode === 'transcode' ? ` → wird zu ${target.toUpperCase()} gewandelt` : ''})`;
  }, 500);
}

function stopRecording() {
  if (!state.recording || !state.recorder) return;
  try { state.recorder.stop(); } catch {}
  clearInterval(state.recTimer);
  state.recording = false;
  $('btn-record').disabled = false;
  $('btn-record').classList.remove('recording');
  $('btn-record').textContent = '⏺ Aufnahme starten';
  $('btn-stop').disabled = true;
  $('rec-badge').classList.add('hidden');
  $('status-left').textContent = 'Speichere Aufnahme…';
}

async function saveRecording() {
  let blob = new Blob(state.chunks, { type: state.recorder.mimeType || 'audio/webm' });
  const target = state.targetFormat || state.settings.format || 'webm';
  const mode = state.recordMode || 'native';
  let ext = extFromMime(state.recordedMime);

  if ((target === 'wav' || target === 'mp3') && mode === 'transcode') {
    $('status-left').textContent = `Wandle zu ${target.toUpperCase()} (${(blob.size / 1024 / 1024).toFixed(2)} MB WebM)…`;
    try {
      const pcm = await decodeToBuffer(blob);
      if (target === 'wav') {
        blob = encodeWavBlob(pcm);
      } else {
        const kbps = Math.max(32, Math.min(320, Math.round((state.settings.audioBitrate || 192000) / 1000)));
        blob = encodeMp3Blob(pcm, kbps);
      }
      ext = target;
    } catch (e) {
      console.warn(`${target.toUpperCase()}-Wandlung fehlgeschlagen, speichere WebM:`, e);
      $('status-left').textContent = `${target.toUpperCase()}-Wandlung fehlgeschlagen – speichere WebM.`;
      ext = 'webm';
    }
  } else if (mode === 'fallback-webm' || !FORMAT_EXT.includes(target)) {
    ext = extFromMime(state.recordedMime);
    if (target !== ext) {
      $('status-left').textContent = `${target.toUpperCase()} wird hier nicht unterstützt – speichere ${ext.toUpperCase()} stattdessen.`;
    }
  } else {
    ext = target;
  }

  const filename = buildFilename(ext);
  $('status-left').textContent = `Aufnahme beendet (${(blob.size / 1024 / 1024).toFixed(2)} MB ${ext.toUpperCase()}) – speichere…`;

  if (window.audioScene) {
    const filePath = await window.audioScene.saveFileDialog({
      filename,
      filters: filtersForExt(ext),
    });
    if (!filePath) {
      $('status-left').textContent = 'Speichern abgebrochen – Aufnahme verworfen.';
      return;
    }
    const buf = await blob.arrayBuffer();
    const res = await window.audioScene.saveBuffer(filePath, Array.from(new Uint8Array(buf)));
    if (res && res.ok) {
      $('status-left').textContent = `Gespeichert: ${res.path}`;
      pushHistory({ name: filename, path: res.path, size: blob.size, ext, time: Date.now() });
    } else {
      $('status-left').textContent = `Fehler beim Speichern: ${(res && res.error) || 'unbekannt'}`;
    }
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    $('status-left').textContent = `Gespeichert (Download): ${filename}`;
    pushHistory({ name: filename, path: '', size: blob.size, ext, time: Date.now() });
  }
}

// WebM-Mitschnitt → PCM-AudioBuffer in Ziel-Samplerate/Kanälen (für WAV/MP3)
async function decodeToBuffer(webmBlob) {
  ensureCtx();
  const ab = await webmBlob.arrayBuffer();
  const raw = await state.audioCtx.decodeAudioData(ab.slice(0));
  const rate = state.settings.sampleRate || raw.sampleRate;
  const ch = state.settings.channels === 1 ? 1 : Math.min(2, raw.numberOfChannels);
  if (raw.sampleRate === rate && raw.numberOfChannels === ch) return raw;
  const off = new OfflineAudioContext(ch, Math.max(1, Math.ceil(raw.duration * rate)), rate);
  const src = off.createBufferSource();
  src.buffer = raw;
  src.connect(off.destination);
  src.start(0);
  return await off.startRendering();
}

function extFromMime(mime) {
  mime = String(mime || '');
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('aac') || mime.includes('m4a')) return 'm4a';
  return 'webm';
}

function filtersForExt(ext) {
  const map = {
    webm: [{ name: 'WebM Audio', extensions: ['webm'] }],
    ogg: [{ name: 'OGG Audio', extensions: ['ogg'] }, { name: 'WebM Audio', extensions: ['webm'] }],
    mp3: [{ name: 'MP3 Audio', extensions: ['mp3'] }],
    wav: [{ name: 'WAV Audio', extensions: ['wav'] }],
    m4a: [{ name: 'M4A Audio', extensions: ['m4a'] }, { name: 'WebM Audio', extensions: ['webm'] }],
  };
  return map[ext] || [{ name: 'Audio', extensions: [ext, 'webm'] }];
}

function floatTo16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function encodeWavBlob(audioBuf) {
  const data = [];
  for (let c = 0; c < audioBuf.numberOfChannels; c++) data.push(audioBuf.getChannelData(c));
  return new Blob([encodeWav(data, audioBuf.sampleRate)], { type: 'audio/wav' });
}

// MP3 via lamejs (src/vendor/lame.min.js, CBR). Mono/Stereo je nach Einstellungen.
function encodeMp3Blob(audioBuf, kbps) {
  if (typeof lamejs === 'undefined' || !lamejs.Mp3Encoder) {
    throw new Error('MP3-Encoder (lamejs) nicht geladen');
  }
  const ch = audioBuf.numberOfChannels;
  const sr = audioBuf.sampleRate;
  const enc = new lamejs.Mp3Encoder(ch, sr, kbps);
  const left = floatTo16(audioBuf.getChannelData(0));
  const right = ch > 1 ? floatTo16(audioBuf.getChannelData(1)) : null;
  const parts = [];
  const CHUNK = 1152;
  for (let i = 0; i < left.length; i += CHUNK) {
    const l = left.subarray(i, i + CHUNK);
    let data;
    if (right) data = enc.encodeBuffer(l, right.subarray(i, i + CHUNK));
    else data = enc.encodeBuffer(l);
    if (data && data.length) parts.push(new Uint8Array(data));
  }
  const end = enc.flush();
  if (end && end.length) parts.push(new Uint8Array(end));
  return new Blob(parts, { type: 'audio/mpeg' });
}

function encodeWav(channelsData, sampleRate) {
  const numCh = channelsData.length;
  const len = channelsData[0].length;
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const buffer = new ArrayBuffer(44 + len * blockAlign);
  const v = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + len * blockAlign, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, len * blockAlign, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channelsData[c][i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return buffer;
}

// ---------- Aufnahme-Verlauf ----------
function pushHistory(entry) {
  state.history.unshift(entry);
  if (state.history.length > 50) state.history.pop();
  renderHistory();
  updateStatsDock();
}
function renderHistory() {
  const ul = $('history-list');
  if (!ul) return;
  ul.innerHTML = '';
  if (!state.history.length) {
    ul.innerHTML = '<li><span class="muted">Noch keine Aufnahme gespeichert.</span></li>';
    return;
  }
  state.history.forEach((h) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>📼 ${escapeHtml(h.name)}</span><span class="eye">${(h.size / 1024 / 1024).toFixed(1)} MB · ${h.ext.toUpperCase()}</span>`;
    li.title = h.path || h.name;
    li.onclick = async () => { if (window.audioScene) await window.audioScene.openDir(); };
    ul.appendChild(li);
  });
}

// ---------- VU + Waveform + Master Loop ----------
function loop() {
  const mine = sceneSources();
  state.sources.forEach((s) => {
    if (!s.analyser) return;
    s.analyser.getByteFrequencyData(s.vuData);
    let sum = 0;
    for (let i = 0; i < s.vuData.length; i++) sum += s.vuData[i];
    const avg = sum / s.vuData.length / 255;
    s.peak = Math.max(avg, (s.peak || 0) * 0.996);
    const el = document.getElementById(`vu-${s.id}`);
    if (el) el.style.width = `${Math.min(100, Math.round(avg * 160))}%`;
    const wrap = document.getElementById(`vuWrap-${s.id}`);
    const peakEl = document.getElementById(`peak-${s.id}`);
    const strip = document.getElementById(`strip-${s.id}`);
    const hot = avg > 0.92 || s.peak > 0.99;
    if (wrap) wrap.classList.toggle('clip', hot);
    if (strip) strip.classList.toggle('clipped', hot);
    if (peakEl) {
      peakEl.textContent = hot ? '⚠ CLIP – leiser stellen!' : `Peak ${Math.round((s.peak || 0) * 100)}%`;
      peakEl.classList.toggle('hot', hot);
    }
  });
  // Master-Waveform + Master-Dock
  const canvas = $('waveform');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#0a0d14';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#232839';
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
    if (state.masterAnalyser && mine.length > 0) {
      const data = new Uint8Array(state.masterAnalyser.fftSize);
      state.masterAnalyser.getByteTimeDomainData(data);
      ctx.strokeStyle = state.recording ? '#e5484d' : '#3a6df0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const step = W / data.length;
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i] / 128 - 1;
        const a = Math.abs(v);
        if (a > peak) peak = a;
        const y = H / 2 + v * (H * 0.42);
        if (i === 0) ctx.moveTo(0, y);
        else ctx.lineTo(i * step, y);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      const mvu = $('master-vu');
      if (mvu) mvu.style.width = `${Math.min(100, Math.round(peak * 130))}%`;
      setText('master-pct', `${Math.round(peak * 100)}%`);
      const clip = $('master-clip');
      if (clip) {
        const hot = peak > 0.98;
        clip.textContent = hot ? '⚠ CLIP' : '● Summe';
        clip.classList.toggle('hot', hot);
      }
    } else {
      ctx.fillStyle = '#3a4157';
      ctx.font = '13px Segoe UI';
      ctx.textAlign = 'center';
      ctx.fillText(mine.length === 0 ? 'NO SIGNAL – Quelle hinzufügen' : 'SIGNAL BEREIT', W / 2, H / 2);
    }
  }
  requestAnimationFrame(loop);
}

// ---------- Modal-Logik ----------
function openModal(id) { const el = $(id); if (el) el.classList.remove('hidden'); }
function closeModal(id) { const el = $(id); if (el) el.classList.add('hidden'); }

async function prepareDevicePicker(type) {
  state.pendingType = type;
  state.reconnectId = null;
  const picker = $('device-picker');
  const sel = $('device-select');
  const hint = $('device-hint');
  sel.innerHTML = '';
  $('source-name').value = defaultName(type);

  if (type === 'mic') {
    $('device-label').textContent = 'Eingabegerät wählen:';
    hint.textContent = 'Tipp: Beim ersten Mal fragt Windows nach Mikrofon-Erlaubnis. Danach erscheinen echte Gerätenamen.';
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true }).then((st) => st.getTracks().forEach((t) => t.stop())).catch(() => {});
    } catch {}
    const devs = await listAudioDevices('audioinput');
    if (devs.length === 0) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = 'Standard-Mikrofon';
      sel.appendChild(o);
    } else {
      devs.forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `Mikrofon ${i + 1}`;
        sel.appendChild(o);
      });
    }
    picker.classList.remove('hidden');
  } else {
    // Anwendungs-/System-Sound: Fensterliste wie in OBS (statt nur System-Dialog)
    picker.classList.add('hidden');
    openWindowPicker(type);
  }
}

// ---------- Menüs (Datei / Ansicht / Werkzeuge / Hilfe) ----------
function closeAllMenus() {
  document.querySelectorAll('.dropdown').forEach((d) => d.classList.add('hidden'));
}
function bindMenus() {
  const pairs = [['menu-file', 'drop-file'], ['menu-view', 'drop-view'], ['menu-tools', 'drop-tools'], ['menu-help', 'drop-help']];
  pairs.forEach(([m, d]) => {
    const mi = $(m);
    if (!mi) return;
    mi.onclick = (e) => {
      e.stopPropagation();
      const dd = $(d);
      const wasHidden = dd.classList.contains('hidden');
      closeAllMenus();
      if (wasHidden) {
        if (d === 'drop-view') renderViewMenu();
        if (d === 'drop-tools') renderToolsMenu();
        dd.classList.remove('hidden');
      }
    };
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu-wrap')) closeAllMenus();
  });
  const openSettings = async () => { closeAllMenus(); await loadSettings(); openModal('modal-settings'); };
  const openFolder = async () => {
    closeAllMenus();
    if (window.audioScene) await window.audioScene.openDir();
    else alert('Ordner: ' + state.settings.outputDir);
  };
  $('m-open-settings').onclick = openSettings;
  $('btn-settings').onclick = openSettings;
  $('m-open-folder').onclick = openFolder;
  $('btn-folder').onclick = openFolder;
  $('m-exit').onclick = () => window.close();
  $('btn-exit').onclick = () => window.close();
  $('view-reset').onclick = () => {
    closeAllMenus();
    state.layout = defaultLayout();
    renderDocks();
    persistState();
    $('status-left').textContent = 'Layout zurückgesetzt.';
  };
  $('m-about').onclick = async () => {
    closeAllMenus();
    let v = '0.3.0';
    try { if (window.audioScene && window.audioScene.getVersion) v = await window.audioScene.getVersion(); } catch {}
    alert(`AudioScene v${v} – OBS für Audio\nSzenen, Quellen, Mixer, Aufnahme in WebM/OGG/MP3/WAV/M4A.\nAufnahmen: ${state.settings.outputDir || '–'}`);
  };
}

// ---------- Events ----------
function bindEvents() {
  bindMenus();
  setInterval(() => {
    if (!state.recording) setText('clock', new Date().toLocaleTimeString('de-DE'));
    setText('stat2-uptime', fmtShort(Date.now() - state.sessionStart));
  }, 1000);

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      $('status-left').textContent = 'Audiogeräte geändert – Liste ggf. neu laden (Quelle → Eigenschaften, Fensterliste → ⟳).';
    });
  }

  // Szenen
  $('btn-scene-add').onclick = addScene;
  $('btn-scene-remove').onclick = removeScene;
  $('btn-scene-up').onclick = () => moveScene(-1);
  $('btn-scene-down').onclick = () => moveScene(1);

  // Quellen
  $('btn-source-add').onclick = () => {
    state.reconnectId = null;
    $('device-picker').classList.add('hidden');
    $('window-picker').classList.add('hidden');
    openModal('modal-source');
  };
  $('btn-source-close').onclick = () => {
    closeModal('modal-source');
    $('device-picker').classList.add('hidden');
    $('window-picker').classList.add('hidden');
    state.reconnectId = null;
  };
  $('btn-source-remove').onclick = removeSelectedSource;
  $('btn-source-props').onclick = () => {
    if (!state.selectedSourceId) { alert('Bitte zuerst eine Quelle in der Liste anklicken.'); return; }
    openProps(state.selectedSourceId);
  };
  $('btn-source-up').onclick = () => moveSource(-1);
  $('btn-source-down').onclick = () => moveSource(1);

  document.querySelectorAll('.src-type').forEach((b) => {
    b.onclick = () => prepareDevicePicker(b.dataset.type);
  });
  $('btn-device-cancel').onclick = () => $('device-picker').classList.add('hidden');
  $('btn-device-add').onclick = async () => {
    const type = state.pendingType || 'mic';
    const sel = $('device-select');
    const name = $('source-name').value.trim() || defaultName(type);
    closeModal('modal-source');
    $('device-picker').classList.add('hidden');
    await addSource(type, sel.value || null, name);
  };

  // Fenster-Picker
  $('btn-windows-refresh').onclick = () => refreshWindowList();
  $('btn-window-manual').onclick = () => {
    state.pendingWindowId = '__manual__';
    confirmWindowAdd();
  };
  $('btn-window-add').onclick = () => confirmWindowAdd();

  // Eigenschaften
  $('btn-props-cancel').onclick = () => closeModal('modal-props');
  $('btn-props-save').onclick = saveProps;
  $('btn-props-reconnect').onclick = () => startReconnect(state.propsId);
  $('props-vol').oninput = (e) => { setText('props-vol-val', String(e.target.value)); };

  // Steuerung
  $('btn-record').onclick = startRecording;
  $('btn-stop').onclick = stopRecording;
  $('btn-monitor').onclick = () => setMonitoring(!state.monitoring);

  // Einstellungen
  $('btn-settings-cancel').onclick = () => closeModal('modal-settings');
  $('btn-settings-save').onclick = async () => {
    await saveSettingsFromUI();
    closeModal('modal-settings');
    $('status-left').textContent = 'Einstellungen gespeichert.';
  };
  document.querySelectorAll('.tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      document.querySelectorAll('.tabpage').forEach((p) => p.classList.add('hidden'));
      $(`tab-${t.dataset.tab}`).classList.remove('hidden');
    };
  });
  $('btn-browse').onclick = async () => {
    if (!window.audioScene) return;
    const dir = await window.audioScene.pickDir();
    if (dir) $('set-output').value = dir;
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllMenus();
      return;
    }
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const hot = (state.settings.hotkeyRecord || 'F9').toUpperCase();
    if (e.key.toUpperCase() === hot) {
      e.preventDefault();
      if (state.recording) stopRecording();
      else startRecording();
    }
  });
}

// ---------- Init ----------
(async function init() {
  state.sessionStart = Date.now();
  bindEvents();
  await loadSettings();
  await restoreState();
  cacheCoreDocks();
  renderDocks();
  renderScenes();
  renderSources();
  renderMixer();
  setMonitoring(!!state.settings.monitoring);
  initDockDrag();
  persistState(); // Defaults / wiederhergestelltes Layout sofort sichern
  window.addEventListener('beforeunload', () => persistState());
  requestAnimationFrame(loop);
  function fitCanvas() {
    const c = $('waveform');
    if (!c || !c.parentElement) return;
    const r = c.parentElement.getBoundingClientRect();
    c.width = Math.max(400, Math.floor(r.width * 0.96));
    c.height = Math.max(140, Math.floor(r.height * 0.8));
  }
  window.addEventListener('resize', fitCanvas);
  setTimeout(fitCanvas, 100);
})();
