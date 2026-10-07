// AudioScene Docs – Interaktionen
(function () {
  // Mobile Menü
  const burger = document.getElementById('burger');
  const mobile = document.getElementById('mobileMenu');
  if (burger && mobile) burger.addEventListener('click', () => mobile.classList.toggle('hidden'));

  // Tabs oben
  const btns = document.querySelectorAll('.tabbtn');
  const panes = document.querySelectorAll('.tabpanel');
  btns.forEach((b) => {
    b.addEventListener('click', () => {
      btns.forEach((x) => {
        x.classList.remove('bg-obs-accent', 'text-white');
        x.classList.add('bg-obs-panel2');
      });
      b.classList.add('bg-obs-accent', 'text-white');
      b.classList.remove('bg-obs-panel2');
      panes.forEach((p) => p.classList.add('hidden'));
      const t = document.getElementById(b.dataset.tab);
      if (t) t.classList.remove('hidden');
    });
  });

  // FAQ Accordion
  document.querySelectorAll('.faq').forEach((f) => {
    const q = f.querySelector('.faq-q');
    if (q) q.addEventListener('click', () => f.classList.toggle('open'));
  });

  // Bitraten-Rechner
  const rate = document.getElementById('calcRate');
  const mins = document.getElementById('calcMin');
  const out = document.getElementById('calcOut');
  function calc() {
    if (!rate || !mins || !out) return;
    const bps = parseInt(rate.value, 10);
    const m = Math.max(1, parseFloat(mins.value) || 1);
    const mb = ((bps * m * 60) / 8 / 1024 / 1024).toFixed(1).replace('.', ',');
    out.textContent = `≈ ${mb} MB`;
  }
  if (rate) rate.addEventListener('change', calc);
  if (mins) mins.addEventListener('input', calc);
  calc();

  // Code kopieren
  const copy = document.getElementById('copyCode');
  if (copy) {
    copy.addEventListener('click', async () => {
      const txt = document.getElementById('codeBlock').innerText;
      try {
        await navigator.clipboard.writeText(txt);
        const ok = document.getElementById('copyOk');
        if (ok) {
          ok.classList.remove('hidden');
          setTimeout(() => ok.classList.add('hidden'), 1500);
        }
      } catch {}
    });
  }

  // Demo-Mixer-Strips
  const strips = [
    { name: '🖥️ Spotify', id: 'd1' },
    { name: '🎤 Mikrofon', id: 'd2' },
    { name: '🔈 System', id: 'd3' },
  ];
  const box = document.getElementById('demoStrips');
  let muted = false;
  let gain = 0.7;
  if (box) {
    strips.forEach((s) => {
      const div = document.createElement('div');
      div.className = 'bg-black/40 border border-obs-border rounded p-2 flex items-center gap-3';
      div.innerHTML = `<span class="w-28 font-bold text-xs">${s.name}</span>
        <div class="flex-1 h-2 bg-black rounded overflow-hidden"><div id="vu-${s.id}" class="vu-bar h-2 rounded bg-gradient-to-r from-green-500 via-yellow-400 to-red-500" style="width:10%"></div></div>
        <span class="text-xs text-obs-muted" id="pct-${s.id}">70%</span>`;
      box.appendChild(div);
    });
    setInterval(() => {
      strips.forEach((s, i) => {
        const el = document.getElementById(`vu-${s.id}`);
        const pct = document.getElementById(`pct-${s.id}`);
        if (!el) return;
        const base = muted ? 0 : gain * (0.35 + Math.random() * 0.65);
        el.style.width = `${Math.round(base * 100)}%`;
        if (pct && s.id === 'd1') pct.textContent = `${Math.round(gain * 100)}%`;
      });
      ['vu1', 'vu2', 'vu3'].forEach((id, i) => {
        const el = document.getElementById(id);
        if (el) el.style.width = `${muted ? 2 : Math.round(gain * (20 + Math.random() * 75))}%`;
      });
    }, 180);
  }
  const g = document.getElementById('demoGain');
  if (g) g.addEventListener('input', (e) => { gain = e.target.value / 100; });
  const m = document.getElementById('demoMute');
  if (m) m.addEventListener('click', () => {
    muted = !muted;
    m.textContent = muted ? '🔇 Entmuten' : '🔊 Mute testen';
  });

  // Demo-Waveform (Deko)
  const c = document.getElementById('demoWave');
  if (c) {
    const ctx = c.getContext('2d');
    let t = 0;
    function draw() {
      const W = (c.width = c.clientWidth * 2);
      const H = (c.height = 280);
      ctx.fillStyle = '#0a0d14';
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = '#232839';
      ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
      ctx.strokeStyle = '#3a6df0';
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let x = 0; x < W; x += 4) {
        const v = Math.sin(x * 0.02 + t) * 0.5 + Math.sin(x * 0.05 - t * 1.4) * 0.3 + (Math.random() - 0.5) * 0.18;
        const y = H / 2 + v * H * 0.4 * (muted ? 0.05 : gain + 0.15);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      t += 0.08;
      requestAnimationFrame(draw);
    }
    draw();
  }
})();
