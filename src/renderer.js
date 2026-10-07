// AudioScene Renderer – OBS-Logik für Audio
// Quellen: Anwendungs-Audio (getDisplayMedia Loopback), Mic (getUserMedia), Output-Loopback
// Mixer: Web Audio Gain + Analyser pro Quelle, Master-Recorder via MediaRecorder

const $ = (id) => document.getElementById(id);

const state = {
  settings: {
    outputDir: '',
    format: 'webm',
    audioBitrate: 192000,
    sampleRate: 48000,
    channels: 2,
    hotkeyRecord: 'F9'
  },
  sources: [], // {id, name, type, label, stream, gain, analyser, volume, muted, devices}
  audioCtx: null,
  masterGain: null,
  masterAnalyser: null,
  masterDest: null,
  recorder: null,
  chunks: [],
  recording: false,
  recStart: 0,
  recTimer: null,
  pendingType: null,
  selectedSourceId: null,
};

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}
function fmtShort(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

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
    // Kein direktes Monitoring (kein Feedback), nur Aufnahme-Bus.
    // Optional: masterGain -> destination auskommentiert lassen.
  }
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
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
  refreshSettingsUI();
  refreshStatusLine();
}
function refreshSettingsUI() {
  $('set-output').value = state.settings.outputDir || '';
  $('set-format').value = state.settings.format || 'webm';
  $('set-samplerate').value = String(state.settings.sampleRate || 48000);
  $('set-channels').value = String(state.settings.channels || 2);
  $('set-bitrate').value = String(state.settings.audioBitrate || 192000);
  $('set-hotkey').value = state.settings.hotkey || state.settings.hotkeyRecord || 'F9';
  $('stat-path').textContent = state.settings.outputDir || '–';
  $('stat-bitrate').textContent = `${Math.round((state.settings.audioBitrate || 192000) / 1000)} kbps`;
  $('status-format').textContent =
    `Format: ${state.settings.format} · ${Math.round(state.settings.audioBitrate / 1000)} kbps · ${(state.settings.sampleRate / 1000).toFixed(1)} kHz · ${state.settings.channels === 1 ? 'Mono' : 'Stereo'}`;
}

async function saveSettingsFromUI() {
  const next = {
    outputDir: $('set-output').value,
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

function refreshStatusLine() {
  $('stat-count').textContent = `${state.sources.length} ${state.sources.length === 1 ? 'Quelle' : 'Quellen'}`;
  $('status-devices').textContent =
    state.sources.length === 0 ? 'Geräte: –' : `Geräte: ${state.sources.length} aktiv`;
}

// ---------- Quellen-UI ----------
function renderSources() {
  const ul = $('source-list');
  ul.innerHTML = '';
  state.sources.forEach((s) => {
    const li = document.createElement('li');
    li.dataset.id = s.id;
    if (s.id === state.selectedSourceId) li.classList.add('selected');
    const icon = s.type === 'app' ? '🖥️' : s.type === 'mic' ? '🎤' : '🔈';
    li.innerHTML = `<span>${icon} ${escapeHtml(s.name)}</span><span class="eye">${s.muted ? '🔇' : '👁'}</span>`;
    li.onclick = () => {
      state.selectedSourceId = s.id;
      renderSources();
      renderMixer();
    };
    ul.appendChild(li);
  });
  if (state.sources.length === 0) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="muted">Noch keine Quelle – klicke auf +</span>';
    ul.appendChild(li);
  }
  $('preview-empty').classList.toggle('hidden', state.sources.length > 0);
  refreshStatusLine();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMixer() {
  const box = $('mixer');
  box.innerHTML = '';
  if (state.sources.length === 0) {
    box.innerHTML = '<div class="mixer-empty" id="mixer-empty">Keine Quellen.<br />Klicke auf + bei Quellen.</div>';
    return;
  }
  state.sources.forEach((s) => {
    const div = document.createElement('div');
    div.className = 'strip';
    const typeLabel = s.type === 'app' ? 'Anwendungs-Audio' : s.type === 'mic' ? 'Eingabegerät' : 'Ausgabegerät';
    div.innerHTML = `
      <div class="s-name">${escapeHtml(s.name)}</div>
      <div class="s-type">${typeLabel}</div>
      <div class="vu"><div id="vu-${s.id}"></div></div>
      <input type="range" min="0" max="100" value="${Math.round(s.volume * 100)}" id="vol-${s.id}" />
      <div class="s-row">
        <span id="db-${s.id}">0 dB</span>
        <span class="mute ${s.muted ? 'muted' : ''}" id="mute-${s.id}" title="Stummschalten">🔊</span>
      </div>`;
    box.appendChild(div);
    $(`vol-${s.id}`).oninput = (e) => {
      s.volume = e.target.value / 100;
      if (s.gain) s.gain.gain.value = s.muted ? 0 : s.volume;
      const db = s.volume <= 0.001 ? '-inf' : (20 * Math.log10(s.volume)).toFixed(1);
      $(`db-${s.id}`).textContent = `${db} dB`;
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
    if (type === 'app') {
      // System-/App-Audio: Nutzer wählt Fenster/Bildschirm + "Systemaudio teilen" anhaken
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      // Videotrack brauchen wir nicht, nur Audio
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
    } else if (type === 'out') {
      // Echter Loopback braucht WASAPI-spezifisches Handling; MVP: wie App-Audio via DisplayMedia
      // Besserer Weg (später, nativ): WASAPI loopback per Node-Modul. Hier Fallback auf Auswahl-Dialog.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach((t) => t.stop());
      const at = stream.getAudioTracks();
      if (at.length === 0) {
        alert('Kein Audio freigegeben. Bitte „Systemaudio teilen“ aktivieren.');
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = new MediaStream(at);
    }
  } catch (e) {
    console.warn('Quelle abgebrochen:', e);
    return;
  }

  const id = `src_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
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
    name: name || defaultName(type),
    type,
    stream,
    node: srcNode,
    gain,
    analyser,
    volume: 1.0,
    muted: false,
    vuData: new Uint8Array(analyser.frequencyBinCount),
  };
  // Track-Ende (z. B. Freigabe gestoppt) → Quelle behalten, aber markieren
  stream.getTracks().forEach((t) => {
    t.onended = () => {
      $('status-left').textContent = `Hinweis: Quelle „${s.name}“ wurde vom System beendet.`;
    };
  });

  state.sources.push(s);
  state.selectedSourceId = id;
  renderSources();
  renderMixer();
  $('status-left').textContent = `Quelle hinzugefügt: ${s.name}`;
}
function defaultName(type) {
  const n = state.sources.length + 1;
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
  try {
    s.stream.getTracks().forEach((t) => t.stop());
    s.node.disconnect();
    s.gain.disconnect();
    s.analyser.disconnect();
  } catch {}
  state.selectedSourceId = state.sources.length ? state.sources[0].id : null;
  renderSources();
  renderMixer();
}

// ---------- Aufnahme ----------
function buildFilename() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
  const ext = state.settings.format === 'wav' ? 'wav' : 'webm';
  return `AudioScene_${stamp}.${ext}`;
}

async function startRecording() {
  if (state.recording) return;
  if (state.sources.length === 0) {
    alert('Bitte zuerst eine Quelle hinzufügen (+ bei Quellen).');
    return;
  }
  ensureCtx();
  const mimeCandidates = state.settings.format === 'wav'
    ? ['audio/wav', 'audio/webm;codecs=opus', 'audio/webm']
    : ['audio/webm;codecs=opus', 'audio/webm'];
  let mime = '';
  for (const c of mimeCandidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) { mime = c; break; }
  }
  const opts = {};
  if (mime) opts.mimeType = mime;
  if (state.settings.audioBitrate) opts.audioBitsPerSecond = state.settings.audioBitrate;

  try {
    state.recorder = new MediaRecorder(state.masterDest.stream, opts);
  } catch (e) {
    alert('Recorder konnte nicht gestartet werden: ' + e.message);
    return;
  }
  state.chunks = [];
  state.recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) state.chunks.push(e.data);
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
  $('status-left').textContent = `Aufnahme läuft… (${mime || 'Standard-Codec'}, ${Math.round(state.settings.audioBitrate / 1000)} kbps)`;

  state.recTimer = setInterval(() => {
    const el = Date.now() - state.recStart;
    $('rec-time').textContent = fmtShort(el);
    $('clock').textContent = new Date().toLocaleTimeString('de-DE');
  }, 500);
}

function stopRecording() {
  if (!state.recording || !state.recorder) return;
  state.recorder.stop();
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
  const blob = new Blob(state.chunks, { type: state.recorder.mimeType || 'audio/webm' });
  const filename = buildFilename();
  $('status-left').textContent = `Aufnahme beendet (${(blob.size / 1024 / 1024).toFixed(2)} MB) – speichere…`;

  if (window.audioScene) {
    const filePath = await window.audioScene.saveFileDialog({
      filename,
      filters: state.settings.format === 'wav'
        ? [{ name: 'WAV Audio', extensions: ['wav'] }, { name: 'WebM Audio', extensions: ['webm'] }]
        : [{ name: 'WebM Audio', extensions: ['webm'] }, { name: 'Alle Dateien', extensions: ['*'] }],
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
    // Browser-Fallback (ohne Electron): Download via <a>
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    $('status-left').textContent = `Gespeichert (Download): ${filename}`;
  }
}

// ---------- VU + Waveform Loop ----------
function loop() {
  // Mixer-VUs
  state.sources.forEach((s) => {
    if (!s.analyser) return;
    s.analyser.getByteFrequencyData(s.vuData);
    let sum = 0;
    for (let i = 0; i < s.vuData.length; i++) sum += s.vuData[i];
    const avg = sum / s.vuData.length / 255;
    const el = document.getElementById(`vu-${s.id}`);
    if (el) el.style.width = `${Math.min(100, Math.round(avg * 160))}%`;
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
  if (state.masterAnalyser && state.sources.length > 0) {
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
    ctx.fillText(state.sources.length === 0 ? 'NO SIGNAL – Quelle hinzufügen' : 'SIGNAL BEREIT', W / 2, H / 2);
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
    hint.textContent = 'Nimmt alles auf, was über deine Lautsprecher/Kopfhörer läuft. MVP nutzt denselben System-Dialog wie Anwendungs-Audio. Natives WASAPI-Loopback folgt.';
    sel.innerHTML = '<option value="">System-Sound (Loopback via System-Dialog)</option>';
  }
  picker.classList.remove('hidden');
}

// ---------- Events ----------
function bindEvents() {
  setInterval(() => {
    if (!state.recording) $('clock').textContent = new Date().toLocaleTimeString('de-DE');
  }, 1000);

  $('btn-source-add').onclick = () => {
    $('device-picker').classList.add('hidden');
    openModal('modal-source');
  };
  $('btn-source-close').onclick = () => closeModal('modal-source');
  $('btn-source-remove').onclick = removeSelectedSource;
  $('btn-source-props').onclick = () => {
    if (!state.selectedSourceId) { alert('Bitte zuerst eine Quelle in der Liste anklicken.'); return; }
    alert('Eigenschaften-Dialog folgt in v0.2 (Gerät wechseln, Mono-Downmix, Filter). Aktuell: Lautstärke + Mute im Mixer.');
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

  $('btn-record').onclick = startRecording;
  $('btn-stop').onclick = stopRecording;

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
  $('btn-scene-add').onclick = () => {
    const ul = $('scene-list');
    const li = document.createElement('li');
    li.textContent = `Szene ${ul.children.length + 1}`;
    li.onclick = () => {
      ul.querySelectorAll('li').forEach((x) => x.classList.remove('active'));
      li.classList.add('active');
    };
    ul.appendChild(li);
  };
  document.querySelectorAll('#scene-list li').forEach((li) => {
    li.onclick = () => {
      document.querySelectorAll('#scene-list li').forEach((x) => x.classList.remove('active'));
      li.classList.add('active');
    };
  });

  document.addEventListener('keydown', (e) => {
    const hot = (state.settings.hotkeyRecord || 'F9').toUpperCase();
    if (e.key.toUpperCase() === hot) {
      e.preventDefault();
      if (state.recording) stopRecording();
      else startRecording();
    }
  });
}

function moveSource(dir) {
  const i = state.sources.findIndex((s) => s.id === state.selectedSourceId);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= state.sources.length) return;
  const [s] = state.sources.splice(i, 1);
  state.sources.splice(j, 0, s);
  renderSources();
  renderMixer();
}

// ---------- Init ----------
(async function init() {
  bindEvents();
  await loadSettings();
  renderSources();
  renderMixer();
  requestAnimationFrame(loop);
  // Szenen-Größe an Canvas anpassen
  function fitCanvas() {
    const c = $('waveform');
    const r = c.parentElement.getBoundingClientRect();
    c.width = Math.max(400, Math.floor(r.width * 0.96));
    c.height = Math.max(140, Math.floor(r.height * 0.8));
  }
  window.addEventListener('resize', fitCanvas);
  setTimeout(fitCanvas, 100);
})();
