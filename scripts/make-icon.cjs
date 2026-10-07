// Erzeugt assets/icon.ico (+ PNGs) aus assets/logo-icon.svg.
// Benutzung: node scripts/make-icon.cjs
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIcoMod = require('png-to-ico');
const pngToIco = pngToIcoMod.default || pngToIcoMod;

(async () => {
  const root = path.join(__dirname, '..');
  const svg = path.join(root, 'assets', 'logo-icon.svg');
  const sizes = [16, 32, 48, 256];
  const pngs = [];
  for (const s of sizes) {
    const out = path.join(root, 'assets', `icon-${s}.png`);
    await sharp(svg, { density: 512 }).resize(s, s).png().toFile(out);
    pngs.push(out);
    console.log('PNG:', out);
  }
  const buf = await pngToIco(pngs);
  const ico = path.join(root, 'assets', 'icon.ico');
  fs.writeFileSync(ico, buf);
  console.log('ICO:', ico, buf.length, 'bytes');
})().catch((e) => { console.error(e); process.exit(1); });
