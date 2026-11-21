// Regenerates every icon file from the artwork in build/icon-source/, using Electron's
// own Chromium (no ImageMagick, rsvg or extra packages):
//   lectern-light.png  the full artwork, for every size above 32 px
//   lectern-small.svg  the same book simplified for 32 px and below (no bow, frame lines or
//                      page texture, a larger star), so it still reads in menus, lists and the
//                      sidebar
// into
//   build/icons/<n>x<n>.png       Linux icon set, in-app welcome mark, dev window icon
//   build/lectern.icns            macOS (PNG entries, ARGB 16/32 px like iconutil)
//   build/lectern.ico             Windows (PNG entries)
//   build/lectern-mark-small.png  the small artwork at 64 px, for the 32 px sidebar mark on 2x screens
// Both sources are square tiles with black outside corners. The tile is hand-drawn, not an
// exact superellipse, so its edge is traced ray by ray from the centre (every 0.1°,
// sub-pixel), and everything outside a line just inside that edge becomes transparent.
// The artwork itself is only masked and scaled. Every raster puts the tile on the macOS
// grid: an 824 px body centred in 1024 px, with a soft shadow.
//
//   node scripts/render-icons.mjs
//
// On Linux Chromium runs on its headless platform, so no display is needed.
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { argbData, icnsFile, icoFile } from './icon-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const build = path.join(root, 'build');
const pngSizes = [16, 24, 32, 48, 64, 96, 128, 256, 512];
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const artFor = size => size <= 32 ? 'small' : 'full';
// [type, pixels, artwork, ARGB instead of PNG]. The artwork follows the size the slot is shown
// at: ic11 is 16 pt at 2x (32 px) and stays small; ic12 is 32 pt at 2x (64 px), where the
// full book is legible.
const icnsSlots = [['ic04', 16, 'small', true], ['ic05', 32, 'small', true], ['ic11', 32, 'small'], ['ic12', 64, 'full'],
  ['ic07', 128, 'full'], ['ic13', 256, 'full'], ['ic08', 256, 'full'], ['ic14', 512, 'full'], ['ic09', 512, 'full'], ['ic10', 1024, 'full']];
const smallMarkSize = 64;
// Pull the mask this far inside the traced edge (source pixels), past the anti-aliased
// ramp into black, so no dark fringe survives.
const inset = 1.25;

// Runs in the page. Returns the drawing helpers; every function works on canvases.
function iconKit(inset) {
  async function load(url) {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    return canvas;
  }
  // Distance from the centre to the tile's edge (50% coverage), every 0.1°.
  function outline(canvas) {
    const size = canvas.width, c = size / 2, steps = 3600;
    if (canvas.height !== size) throw new Error('Icon sources must be square');
    const data = canvas.getContext('2d').getImageData(0, 0, size, size).data;
    const lum = (x, y) => {
      x = Math.max(0, Math.min(size - 1, x)); y = Math.max(0, Math.min(size - 1, y));
      const i = (y * size + x) * 4;
      return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    };
    const at = (X, Y) => { // bilinear, pixel centres at +0.5
      const x = X - 0.5, y = Y - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      return lum(x0, y0) * (1 - fx) * (1 - fy) + lum(x0 + 1, y0) * fx * (1 - fy) + lum(x0, y0 + 1) * (1 - fx) * fy + lum(x0 + 1, y0 + 1) * fx * fy;
    };
    const black = 12; // the outside corners are pure black; any tile colour is far above this
    const raw = new Float64Array(steps);
    for (let s = 0; s < steps; s++) {
      const t = s / steps * 2 * Math.PI, ux = Math.cos(t), uy = Math.sin(t);
      const limit = Math.min(Math.abs(ux) > 1e-9 ? c / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-9 ? c / Math.abs(uy) : Infinity);
      const ray = r => at(c + ux * r, c + uy * r);
      if (ray(limit - 0.5) > black) { raw[s] = limit; continue; } // the tile reaches the canvas border here
      let r = limit - 0.5;
      while (r > c / 2 && ray(r) <= black) r -= 0.5;
      if (r <= c / 2) throw new Error('Could not find the tile edge; is the outside of the tile black?');
      const background = (ray(r - 6) + ray(r - 8) + ray(r - 10)) / 3;
      let edge = r + 1;
      while (edge > r - 4 && ray(edge) < background / 2) edge -= 0.02;
      raw[s] = edge;
    }
    const smooth = new Float64Array(steps), k = 4; // triangle filter over ±0.4° against pixel noise
    for (let s = 0; s < steps; s++) {
      let sum = 0, weight = 0;
      for (let j = -k; j <= k; j++) { const w = k + 1 - Math.abs(j); sum += raw[(s + j + steps) % steps] * w; weight += w; }
      smooth[s] = sum / weight;
    }
    return smooth;
  }
  function masked(canvas) {
    const radius = outline(canvas), size = canvas.width, c = size / 2, steps = radius.length;
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const context = out.getContext('2d');
    context.drawImage(canvas, 0, 0);
    const path = new Path2D();
    for (let s = 0; s < steps; s++) {
      const t = s / steps * 2 * Math.PI, r = radius[s] - inset;
      path[s ? 'lineTo' : 'moveTo'](c + Math.cos(t) * r, c + Math.sin(t) * r);
    }
    path.closePath();
    context.globalCompositeOperation = 'destination-in';
    context.fill(path);
    return out;
  }
  // Halve with high-quality smoothing until within 2x of the target, so small sizes stay crisp.
  function reduced(canvas, size) {
    let current = canvas;
    while (current.width / 2 >= size) {
      const next = document.createElement('canvas');
      next.width = next.height = Math.ceil(current.width / 2);
      const context = next.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(current, 0, 0, next.width, next.height);
      current = next;
    }
    return current;
  }
  // The tile on a size x size canvas: `body` of the width, centred, with an optional drop shadow.
  function icon(tile, size, body, shadow) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d');
    const extent = size * body, offset = (size - extent) / 2;
    context.imageSmoothingQuality = 'high';
    if (shadow) {
      context.shadowColor = 'rgba(0, 0, 0, 0.3)';
      context.shadowBlur = size * 0.024;
      context.shadowOffsetY = size * 0.01;
    }
    context.drawImage(reduced(tile, extent), offset, offset, extent, extent);
    return canvas;
  }
  const tiles = {};
  return {
    // `url` may be a PNG or an SVG data URL; either way the outside corners must be black.
    async prepare(name, url) { tiles[name] = masked(await load(url)); },
    render(name, size, { body = 824 / 1024, shadow = true, raw = false } = {}) {
      const canvas = icon(tiles[name], size, body, shadow);
      return { png: canvas.toDataURL('image/png'), rgba: raw ? Array.from(canvas.getContext('2d').getImageData(0, 0, size, size).data) : undefined };
    },
  };
}

const dataUrl = async (file, type) => `data:${type};base64,` + (await readFile(file)).toString('base64');
const pngOf = result => Buffer.from(result.png.split(',')[1], 'base64');

async function generate() {
  const { app, BrowserWindow } = await import('electron');
  app.disableHardwareAcceleration();
  app.dock?.hide();
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await window.loadURL('about:blank');
  const page = code => window.webContents.executeJavaScript(code);
  await page(`window.kit = (${iconKit})(${inset}); 0`);
  for (const [name, file, type] of [['full', 'lectern-light.png', 'image/png'], ['small', 'lectern-small.svg', 'image/svg+xml']]) {
    await page(`window.kit.prepare(${JSON.stringify(name)}, ${JSON.stringify(await dataUrl(path.join(build, 'icon-source', file), type))})`);
    console.log(`  traced and masked ${file}`);
  }
  const cache = new Map();
  const render = async (art, size, raw = false) => {
    const key = `${art}:${size}:${raw}`;
    if (!cache.has(key)) cache.set(key, await page(`window.kit.render(${JSON.stringify(art)}, ${size}, { raw: ${raw} })`));
    return cache.get(key);
  };

  await mkdir(path.join(build, 'icons'), { recursive: true });
  for (const size of pngSizes) await writeFile(path.join(build, 'icons', `${size}x${size}.png`), pngOf(await render(artFor(size), size)));
  const ico = [];
  for (const size of icoSizes) ico.push({ size, png: pngOf(await render(artFor(size), size)) });
  await writeFile(path.join(build, 'lectern.ico'), icoFile(ico));
  const icns = [];
  for (const [type, size, art, argb] of icnsSlots) {
    const image = await render(art, size, !!argb);
    icns.push([type, argb ? argbData(Uint8Array.from(image.rgba), size, size) : pngOf(image)]);
  }
  await writeFile(path.join(build, 'lectern.icns'), icnsFile(icns));
  await writeFile(path.join(build, 'lectern-mark-small.png'), pngOf(await render('small', smallMarkSize)));
  console.log('Wrote build/icons/*.png, lectern.icns, lectern.ico and lectern-mark-small.png');
}

export { iconKit };

if (process.versions.electron && process.env.LECTERN_ICON_RENDER === '1') {
  const { app } = await import('electron');
  // Not awaited: Electron emits 'ready' only after the ESM entry finishes evaluating.
  generate().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
} else if (!process.versions.electron && path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { default: electron } = await import('electron');
  const flags = ['--disable-gpu'];
  if (process.platform === 'linux') flags.push('--ozone-platform=headless');
  if (process.getuid?.() === 0) flags.push('--no-sandbox'); // Chromium refuses to run as root otherwise.
  const env = { ...process.env, LECTERN_ICON_RENDER: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electron, [...flags, fileURLToPath(import.meta.url)], { env, stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' });
  // Chromium logs harmless GPU/D-Bus noise on headless machines; show it only on failure.
  if (child.status !== 0) { process.stderr.write(child.stderr ?? ''); process.exit(child.status ?? 1); }
}
