// AudioScene Renderer v0.2.0 – OBS-Logik für Audio
// Szenen mit eigenem Quellen-Mix, Eigenschaften-Dialog, Monitoring,
// Peak/Clip-Anzeige, Dateiname-Vorlage, WAV-Export (WebM → PCM).

const $ = (id) => document.getElementById(id);

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
  sources: [], // {id, sceneId, name, type, deviceId, stream, node, gain, analyser, volume, muted, peak, ended, vuData, routed}
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
  recordMode: 'native', // native | fallback-webm | transcode
  targetFormat: 'webm',
  pendingType: null,
  selectedSourceId: null,
  propsId: null,
};

function fmtShort(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const FORMAT_LABEL = { webm: 'WebM (Opus)', ogg: 'OGG (Opus)', mp3: 'MP3', wav: 'WAV (PCM)', m4a: 'M4A (AAC)' };
const FORMAT_EXT = ['webm', 'ogg', 'mp3', 'wav', 'm4a'];
function formatLabel(f) { return FORMAT_LABEL[f] || f || 'WebM (Opus)'; }
function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 99999)}`;
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
    // Monitoring (Mithören) ist standardmäßig AUS – kein Feedback.
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
      $('music-info').textContent =
        `Musik-Ordner auf diesem System: ${paths.music} → Aufnahmen: ${state.settings.outputDir} (wird automatisch erstellt)`;
    }
  }
  if (!state.settings.filenameTemplate) state.settings.filenameTemplate = 'AudioScene_%Y-%m-%d_%H-%M-%S';
  refreshSettingsUI();
  refreshStatusLine();
}
function refreshSettingsUI() {
  $('set-output').value = state.settings.outputDir || '';
  $('set-template').value = state.settings.filenameTemplate || 'AudioScene_%Y-%m-%d_%H-%M-%S';
  $('set-format').value = state.settings.format || 'webm';
  $('set-samplerate').value = String(state.settings.sampleRate || 48000);
  $('set-channels').value = String(state.settings.channels || 2);
  $('set-bitrate').value = String(state.settings.audioBitrate || 192000);
  $('set-hotkey').value = state.settings.hotkey || state.settings.hotkeyRecord || 'F9';
  $('stat-path').textContent = state.settings.outputDir || '–';
  const fmt = FORMAT_EXT.includes(state.settings.format) ? state.settings.format : 'webm';
  const kbps = Math.round((state.settings.audioBitrate || 192000) / 1000);
  $('stat-bitrate').textContent = fmt === 'wav' ? 'PCM (verlustfrei)' : `${kbps} kbps`;
  $('status-format').textContent =
    `Format: ${formatLabel(fmt)}${fmt === 'wav' ? '' : ` · ${kbps} kbps`} · ${(state.settings.sampleRate / 1000).toFixed(1)} kHz · ${state.settings.channels === 1 ? 'Mono' : 'Stereo'}`;
  const hint = $('bitrate-hint');
  if (hint) {
    hint.textContent =
      fmt === 'wav' ? 'WAV ist unkomprimiert – die Bitrate wird ignoriert (Datei wird groß).' :
      fmt === 'mp3' ? 'MP3 wird nach Stop aus der Aufnahme kodiert (dauert ein paar Sekunden).' :
      fmt === 'm4a' ? 'M4A nutzt den System-Encoder – falls nicht unterstützt, wird WebM gespeichert.' :
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

function activeScene() {
  return state.scenes.find((sc) => sc.id === state.activeSceneId) || null;
}
function sceneSources() {
  return state.sources.filter((s) => s.sceneId === state.activeSceneId);
}

function refreshStatusLine() {
  const mine = sceneSources();
  const sc = activeScene();
  $('stat-count').textContent = `${mine.length} ${mine.length === 1 ? 'Quelle' : 'Quellen'} (total ${state.sources.length})`;
  $('stat-scene').textContent = sc ? sc.name : '–';
  $('status-devices').textContent =
    mine.length === 0 ? 'Geräte: –' : `Geräte: ${mine.length} aktiv in „${sc ? sc.name : '–'}“`;
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
  // Quellen der gelöschten Szene ebenfalls entfernen (mit Audio-Knoten aufräumen)
  const doomed = state.sources.filter((s) => s.sceneId === gone.id);
  doomed.forEach((s) => {
    try {
      s.stream.getTracks().forEach((t) => t.stop());
      s.node.disconnect(); s.gain.disconnect();
      try { s.analyser.disconnect(); } catch {}
    } catch {}
  });
  state.sources = state.sources.filter((s) => s.sceneId !== gone.id);
  state.activeSceneId = state.scenes[Math.max(0, idx - 1)].id;
  applySceneRouting();
  renderScenes();
  renderSources();
  renderMixer();
  $('status-left').textContent = `Szene gelöscht: ${gone.name} (${doomed.length} Quellen entfernt)`;
}

function moveScene(dir) {
  const i = state.scenes.findIndex((sc) => sc.id === state.activeSceneId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.scenes.length) return;
  const [sc] = state.scenes.splice(i, 1);
  state.scenes.splice(j, 0, sc);
  renderScenes();
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
  const commit = () => {
    const v = input.value.trim();
    if (v) sc.name = v;
    renderScenes();
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') renderScenes();
    e.stopPropagation();
  };
  input.onblur = commit;
}

// ---------- Quellen-UI ----------
function renderSources() {
  const ul = $('source-list');
  ul.innerHTML = '';
  const mine = sceneSources();
  mine.forEach((s) => {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    if (s.id === state.selectedSourceId) li.classList.add('selected');
    const icon = s.type === 'app' ? '🖥️' : s.type === 'mic' ? '🎤' : '🔈';
    const flag = s.ended ? ' ⚠' : '';
    li.innerHTML = `<span>${icon} ${escapeHtml(s.name)}${flag}</span><span class="eye">${s.muted ? '🔇' : '👁'}</span>`;
    li.title = s.ended ? 'Track wurde vom System beendet – siehe Eigenschaften' : '';
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
  const sc = activeScene();
  $('preview-empty').classList.toggle('hidden', mine.length > 0);
  refreshStatusLine();
}

function renderMixer() {
  const box = $('mixer');
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
    const db = s.volume <= 0.001 ? '-inf' : (20 * Math.log10(s.volume)).toFixed(1);
    div.innerHTML = `
      <div class="s-name">${escapeHtml(s.name)}${s.ended ? ' ⚠' : ''}</div>
      <div class="s-type">${typeLabel}</div>
      <div class="vu" id="vuWrap-${s.id}"><div id="vu-${s.id}"></div></div>
      <input type="range" min="0" max="100" value="${Math.round(s.volume * 100)}" id="vol-${s.id}" />
      <div class="s-row">
        <span id="db-${s.id}">${db} dB</span>
        <span class="mute ${s.muted ? 'muted' : ''}" id="mute-${s.id}" title="Stummschalten">🔊</span>
      </div>
      <div class="peak" id="peak-${s.id}">Peak 0%</div>`;
    box.appendChild(div);
    $(`vol-${s.id}`).oninput = (e) => {
      s.volume = e.target.value / 100;
      if (s.gain) s.gain.gain.value = s.muted ? 0 : s.volume;
      const v = s.volume <= 0.001 ? '-inf' : (20 * Math.log10(s.volume)).toFixed(1);
      $(`db-${s.id}`).textContent = `${v} dB`;
    };
    $(`mute-${s.id}`).onclick = () => {
      s.muted = !s.muted;
      if (s.gain) s.gain.gain.value = s.muted ? 0 : s.volume;
      renderSources();
      renderMixer();
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

// Quelle hinzufügen – Kern wie OBS
async function addSource(type, deviceId, name) {
  ensureCtx();
  let stream = null;
  try {
    if (type === 'app' || type === 'out') {
      // System-/App-Audio: Nutzer wählt Fenster/Bildschirm + "Systemaudio teilen" anhaken
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach((t) => t.stop());
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        alert('Kein Audio freigegeben. Bitte im Dialog „Systemaudio teilen“ aktivieren.');
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = new MediaStream(audioTracks);
    } else if (type === 'mic') {
      const constraints = deviceId
        ? { audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false } }
        : { audio: { echoCancellation: false, noiseSuppression: false } };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    }
  } catch (e) {
    console.warn('Quelle abgebrochen:', e);
    return;
  }

  const id = uid('src');
  const srcNode = state.audioCtx.createMediaStreamSource(stream);
  const gain = state.audioCtx.createGain();
  gain.gain.value = 1.0;
  const analyser = state.audioCtx.createAnalyser();
  analyser.fftSize = 512;
  srcNode.connect(gain);
  gain.connect(analyser);
  analyser.connect(state.masterGain);

  const s = {
    id,
    sceneId: state.activeSceneId,
    name: name || defaultName(type),
    type,
    deviceId: deviceId || null,
    stream,
    node: srcNode,
    gain,
    analyser,
    volume: 1.0,
    muted: false,
    peak: 0,
    ended: false,
    routed: true,
    vuData: new Uint8Array(analyser.frequencyBinCount),
  };
  stream.getTracks().forEach((t) => {
    t.onended = () => {
      s.ended = true;
      renderSources();
      renderMixer();
      $('status-left').textContent = `Hinweis: Quelle „${s.name}“ wurde vom System beendet.`;
    };
  });

  state.sources.push(s);
  state.selectedSourceId = id;
  renderScenes();
  renderSources();
  renderMixer();
  $('status-left').textContent = `Quelle hinzugefügt: ${s.name}`;
}
function defaultName(type) {
  const n = sceneSources().length + 1;
  if (type === 'app') return `Anwendungs-Audio ${n}`;
  if (type === 'mic') return `Mikrofon ${n}`;
  return `System-Sound ${n}`;
}

function teardownSource(s) {
  try {
    s.stream.getTracks().forEach((t) => t.stop());
    s.node.disconnect();
    s.gain.disconnect();
    try { s.analyser.disconnect(); } catch {}
  } catch {}
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
}

// ---------- Quellen-Eigenschaften ----------
async function openProps(id) {
  const s = state.sources.find((x) => x.id === id);
  if (!s) return;
  state.propsId = id;
  $('props-sub').textContent = `${s.type === 'app' ? 'Anwendungs-Audio' : s.type === 'mic' ? 'Eingabegerät' : 'Ausgabegerät'} · Szene „${activeScene() ? activeScene().name : '–'}“${s.ended ? ' · ⚠ Track beendet' : ''}`;
  $('props-name').value = s.name;
  $('props-vol').value = Math.round(s.volume * 100);
  $('props-vol-val').textContent = String(Math.round(s.volume * 100));
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
}

async function switchMicDevice(s, deviceId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false },
  });
  try { s.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { s.node.disconnect(); } catch {}
  const srcNode = state.audioCtx.createMediaStreamSource(stream);
  srcNode.connect(s.gain);
  s.stream = stream;
  s.node = srcNode;
  s.deviceId = deviceId;
  s.ended = false;
  stream.getTracks().forEach((t) => {
    t.onended = () => {
      s.ended = true;
      renderSources();
      renderMixer();
    };
  });
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
  // Zielformat → Aufnahme-Strategie:
  // webm/ogg/m4a nativ per MediaRecorder, wav/mp3 als WebM mitschneiden + danach wandeln.
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
      // Ziel-Container nicht unterstützt → WebM als Fallback, Hinweis beim Speichern
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
    alert('MP3-Encoder (src/vendor/lame.min.js) wurde nicht geladen. Stelle sicher, dass die Datei existiert – es wird WebM gespeichert.');
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
    $('rec-time').textContent = fmtShort(el);
    $('clock').textContent = new Date().toLocaleTimeString('de-DE');
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
    // Ziel-Container wurde nicht unterstützt → das tatsächlich Aufgenommene speichern
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
  // Resamplen / Downmix über Offline-Kontext (Mono = automatischer Downmix)
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

// MP3 via lamejs (src/vendor/lame.min.js, CBR). Mono-/Stereo je nach Einstellungen.
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

// ---------- VU + Waveform Loop ----------
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
  // Master-Waveform
  const canvas = $('waveform');
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
    for (let i = 0; i < data.length; i++) {
      const v = data[i] / 128 - 1;
      const y = H / 2 + v * (H * 0.42);
      if (i === 0) ctx.moveTo(0, y);
      else ctx.lineTo(i * step, y);
    }
    ctx.stroke();
    ctx.lineWidth = 1;
  } else {
    ctx.fillStyle = '#3a4157';
    ctx.font = '13px Segoe UI';
    ctx.textAlign = 'center';
    ctx.fillText(mine.length === 0 ? 'NO SIGNAL – Quelle hinzufügen' : 'SIGNAL BEREIT', W / 2, H / 2);
  }
  requestAnimationFrame(loop);
}

// ---------- Modal-Logik ----------
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

async function prepareDevicePicker(type) {
  state.pendingType = type;
  const picker = $('device-picker');
  const sel = $('device-select');
  const hint = $('device-hint');
  sel.innerHTML = '';
  $('source-name').value = defaultName(type);

  if (type === 'mic') {
    $('device-label').textContent = 'Eingabegerät wählen:';
    hint.textContent = 'Tipp: Browser fragt ggf. nach Mikrofon-Erlaubnis. Danach erscheinen echte Gerätenamen.';
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
  } else if (type === 'app') {
    $('device-label').textContent = 'Methode:';
    hint.textContent = 'Im nächsten System-Dialog: Fenster/Bildschirm wählen + Haken bei „Systemaudio / Tab-Audio teilen“. Nur Audio wird aufgenommen, Video wird verworfen.';
    sel.innerHTML = '<option value="">System-Dialog (Fenster + Audio wählen)</option>';
  } else {
    $('device-label').textContent = 'Methode:';
    hint.textContent = 'Nimmt alles auf, was über deine Lautsprecher/Kopfhörer läuft. Nutzt denselben System-Dialog wie Anwendungs-Audio. Natives WASAPI-Loopback folgt.';
    sel.innerHTML = '<option value="">System-Sound (Loopback via System-Dialog)</option>';
  }
  picker.classList.remove('hidden');
}

// ---------- Events ----------
function bindEvents() {
  setInterval(() => {
    if (!state.recording) $('clock').textContent = new Date().toLocaleTimeString('de-DE');
  }, 1000);

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      $('status-left').textContent = 'Audiogeräte geändert – Liste ggf. neu laden (Quelle → Eigenschaften).';
    });
  }

  // Szenen
  $('btn-scene-add').onclick = addScene;
  $('btn-scene-remove').onclick = removeScene;
  $('btn-scene-up').onclick = () => moveScene(-1);
  $('btn-scene-down').onclick = () => moveScene(1);

  // Quellen
  $('btn-source-add').onclick = () => {
    $('device-picker').classList.add('hidden');
    openModal('modal-source');
  };
  $('btn-source-close').onclick = () => closeModal('modal-source');
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
    await addSource(type, sel.value || null, name);
  };

  // Eigenschaften
  $('btn-props-cancel').onclick = () => closeModal('modal-props');
  $('btn-props-save').onclick = saveProps;
  $('props-vol').oninput = (e) => { $('props-vol-val').textContent = String(e.target.value); };

  // Steuerung
  $('btn-record').onclick = startRecording;
  $('btn-stop').onclick = stopRecording;
  $('btn-monitor').onclick = () => setMonitoring(!state.monitoring);

  $('btn-settings').onclick = async () => {
    await loadSettings();
    openModal('modal-settings');
  };
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

  $('btn-folder').onclick = async () => {
    if (window.audioScene) await window.audioScene.openDir();
    else alert('Ordner: ' + state.settings.outputDir);
  };
  $('btn-exit').onclick = () => window.close();

  document.addEventListener('keydown', (e) => {
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

function moveSource(dir) {
  const mine = sceneSources();
  const i = mine.findIndex((s) => s.id === state.selectedSourceId);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= mine.length) return;
  // Position im globalen Array tauschen (nur innerhalb der Szene relevant)
  const a = state.sources.indexOf(mine[i]);
  const b = state.sources.indexOf(mine[j]);
  const tmp = state.sources[a];
  state.sources[a] = state.sources[b];
  state.sources[b] = tmp;
  renderSources();
  renderMixer();
}

// ---------- Init ----------
(async function init() {
  bindEvents();
  await loadSettings();
  defaultScenes();
  renderScenes();
  renderSources();
  renderMixer();
  setMonitoring(!!state.settings.monitoring);
  requestAnimationFrame(loop);
  function fitCanvas() {
    const c = $('waveform');
    const r = c.parentElement.getBoundingClientRect();
    c.width = Math.max(400, Math.floor(r.width * 0.96));
    c.height = Math.max(140, Math.floor(r.height * 0.8));
  }
  window.addEventListener('resize', fitCanvas);
  setTimeout(fitCanvas, 100);
})();
