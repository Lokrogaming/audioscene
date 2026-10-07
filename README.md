<p align="center">
  <img src="assets/logo-icon.svg" width="128" alt="AudioScene Logo" />
</p>

# AudioScene – OBS für Audio

**AudioScene** ist wie OBS – nur für Sound. Du fügst **Anwendungs-Audio** und **Audiogeräte** als Quellen hinzu, mischst sie im Mixer und nimmst alles mit einem Klick auf.

![Status](https://img.shields.io/badge/status-v0.1.0_MVP-blue)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
![Engine](https://img.shields.io/badge/engine-Electron_%2B_WebAudio-green)

> Doku-Website (GitHub Pages): siehe Ordner [`docs/`](docs/) – dort wird erklärt, wie alles funktioniert. Aktuell bewusst **ohne Download-/Installer-Button**.

## Features (v0.2)

- **Szenen + Quellen wie in OBS**
  - Szenen anlegen, umbenennen (Doppelklick), löschen, sortieren – nur die aktive Szene läuft auf den Master
  - 🖥️ Anwendungs-Audioaufnahme (per System-Dialog mit „Systemaudio teilen“)
  - 🎤 Eingabegerät (Mikrofon / Headset, wählbar, in Eigenschaften wechselbar)
  - 🔈 Ausgabegerät / System-Sound (Loopback via System-Dialog)
- **Quellen-Eigenschaften** (Doppelklick oder ⚙): umbenennen, Gerät wechseln, Lautstärke
- **Audio-Mixer** mit Lautstärke-Slider, Mute, Live-VU + Peak-Hold und Clip-Warnung pro Quelle
- **Mithören-Toggle** (Master-Monitoring, standardmäßig aus gegen Feedback)
- **Wellenform-Vorschau** (statt Video-Vorschau) + REC-Badge + Timer + Live-Dateigröße
- **⏺ Aufnahme-Button** (Hotkey Standard: `F9`, Eingabefelder ausgenommen), MediaRecorder im Mix-Bus
- **Einstellungen wie in OBS:**
  - Ausgabe-Ordner, Dateiname-Vorlage (`%Y %m %d %H %M %S`), Format (WebM Opus / WAV als echtes 16-bit PCM)
  - Sample-Rate (44.1 / 48 kHz), Kanäle (Mono mit Downmix / Stereo)
  - Bitrate (64–320 kbps)
- **Automatischer Aufnahme-Ordner auf Windows:**
  - Nutzt `app.getPath('music')` → löst automatisch den lokalisierten Ordner auf
  - DE: `C:\Users\<du>\Musik\AudioScene` · EN: `...\Music\AudioScene`
  - Es wird **nie** ein Pfad hardcodiert. Der Ordner wird bei Start erstellt.

## Projekt starten

```bash
npm install
npm start
```

Build (später, portable – noch kein öffentlicher Download):

```bash
npm run dist
```

## Speicherort-Logik (wichtig)

```js
const music = app.getPath('music'); // → Musik / Music, je nach Windows-Sprache
const dir = path.join(music, 'AudioScene');
fs.mkdirSync(dir, { recursive: true });
```

So funktioniert es auf Deutsch, Englisch und allen anderen Sprachen – ohne raten, ob der Ordner `Audio`, `Musik` oder `Music` heißt.

## Roadmap

- [ ] Natives WASAPI-Loopback (ohne System-Dialog, pro App wählbar)
- [ ] WASAPI-Geräteliste nativ (statt Browser-enumerateDevices)
- [ ] MP3 / FLAC / Opus-Export via FFmpeg
- [ ] Filter: Noise-Gate, Kompressor, EQ
- [ ] Echte Szenen-Umschaltung mit getrennten Mixern
- [ ] Installer (NSIS) – erst wenn stabil, aktuell kein Download-Button auf der Page

## Tech

- Electron 33, Web Audio API (Gain + Analyser pro Quelle → Master-Bus), MediaRecorder
- OBS-inspirierte UI: Menüleiste, Docks (Szenen / Quellen / Mixer / Steuerung), Statusleiste

MIT License – gebaut von Lokrogaming.
