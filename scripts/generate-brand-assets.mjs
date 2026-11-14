#!/usr/bin/env node
/**
 * GEODESIA — brand asset generator
 * ---------------------------------------------------------------------------
 * Produces the raster derivatives of the permanent channel mark and the Open
 * Graph social preview card. Run once and commit the output; the Vercel build
 * does NOT depend on this script.
 *
 *   node scripts/generate-brand-assets.mjs
 *
 * Steps
 *  1. sharp: mark SVG (48u grid) → favicon PNGs (32/180/192/512).
 *  2. OG card: render scripts/og-card.html at exactly 1200×630.
 *       a. headless Edge/Chrome screenshot (preferred: real IBM Plex webfonts)
 *       b. sharp rasterisation of a font-free/fallback SVG (never fails)
 *  3. Prints a manifest of what was written.
 */
import { execFile, spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const brandDir = join(root, 'public', 'brand');
const ogDir = join(root, 'public', 'og');
const MARK = join(brandDir, 'geodesia-mark.svg');

const written = [];
const note = (line) => {
  written.push(line);
  console.log('  ' + line);
};

async function ensureDirs() {
  await mkdir(brandDir, { recursive: true });
  await mkdir(ogDir, { recursive: true });
}

/* ------------------------------------------------------------------ icons */
async function buildIcons() {
  console.log('Icons from the channel mark…');
  const mark = await readFile(MARK);
  const targets = [
    { file: 'geodesia-mark-32.png', size: 32 },
    { file: 'geodesia-mark-192.png', size: 192 },
    { file: 'geodesia-mark-512.png', size: 512 },
    { file: 'geodesia-apple-180.png', size: 180 },
  ];
  for (const { file, size } of targets) {
    const out = join(brandDir, file);
    await sharp(mark, { density: Math.max(72, Math.ceil((size / 48) * 72 * 2)) })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(out);
    note(`${file} (${size}×${size})`);
  }
}

/* --------------------------------------------------------------- OG card */
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findBrowser() {
  if (process.env.GEODESIA_BROWSER && existsSync(process.env.GEODESIA_BROWSER)) {
    return process.env.GEODESIA_BROWSER;
  }
  return BROWSERS.find((candidate) => existsSync(candidate)) ?? null;
}

/** Copy the card + webfonts into a space-free temp directory so file:// URLs work. */
async function stageCard() {
  const stage = join(tmpdir(), `geodesia-og-${Date.now()}`);
  await mkdir(join(stage, 'fonts'), { recursive: true });
  const html = await readFile(join(root, 'scripts', 'og-card.html'), 'utf8');
  const fontFiles = [
    ['ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2'],
    ['ibm-plex-sans', 'ibm-plex-sans-latin-500-normal.woff2'],
    ['ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2'],
    ['ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2'],
    ['ibm-plex-mono', 'ibm-plex-mono-latin-500-normal.woff2'],
  ];
  for (const [pkg, file] of fontFiles) {
    const from = join(root, 'node_modules', '@fontsource', pkg, 'files', file);
    if (existsSync(from)) await copyFile(from, join(stage, 'fonts', file));
  }
  const patched = html.replaceAll(
    /\.\.\/node_modules\/@fontsource\/[^)]+\/([a-z0-9-]+\.woff2)/g,
    './fonts/$1',
  );
  const target = join(stage, 'og-card.html');
  await writeFile(target, patched, 'utf8');
  return { stage, target };
}

/**
 * Run the browser, poll for the screenshot, and hard-kill the process tree.
 * Chromium headless on Windows happily outlives its parent, so we never wait on
 * the child's exit code alone.
 */
function runBrowser(binary, args, outputPath, timeoutMs = 45_000) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(binary, args, { windowsHide: true, stdio: 'ignore', detached: false });
    } catch (error) {
      resolvePromise({ ok: false, reason: error.message });
      return;
    }

    const started = Date.now();
    let settled = false;
    const finish = async (ok) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      // Kill the tree: Chromium spawns renderer/GPU children that keep running.
      if (child.pid) {
        await new Promise((done) => {
          execFile(
            'taskkill',
            ['/PID', String(child.pid), '/T', '/F'],
            { windowsHide: true, timeout: 10_000 },
            () => done(),
          );
        }).catch(() => {});
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolvePromise(ok ? { ok: true } : { ok: false, reason: 'browser did not produce a screenshot' });
    };

    const poll = setInterval(async () => {
      if (!settled && existsSync(outputPath)) {
        try {
          const size = (await stat(outputPath)).size;
          if (size > 2048) {
            await finish(true);
            return;
          }
        } catch {
          /* still writing */
        }
      }
      if (Date.now() - started > timeoutMs) await finish(false);
    }, 250);

    const deadline = setTimeout(() => finish(false), timeoutMs + 2_000);
    child.on('exit', () => {
      setTimeout(() => finish(existsSync(outputPath) && statSync(outputPath).size > 2048), 500);
    });
  });
}

async function screenshotCard() {
  const browser = findBrowser();
  if (!browser) {
    console.log('  no Chromium-family browser found — falling back to vector rasterisation');
    return null;
  }
  const { stage, target } = await stageCard();
  const out = join(ogDir, 'geodesia-og.png');
  await rm(out, { force: true }).catch(() => {});
  const fileUrl =
    'file:///' +
    target
      .replaceAll('\\', '/')
      .replace(/^\/+/, '')
      .split('/')
      .map(encodeURIComponent)
      .join('/');
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-renderer-backgrounding',
    '--force-device-scale-factor=1',
    '--window-size=1200,630',
    '--screenshot=' + out,
    '--user-data-dir=' + join(stage, 'profile'),
    fileUrl,
  ];
  console.log(`  browser: ${basename(browser)}`);
  const result = await runBrowser(browser, args, out);
  await rm(stage, { recursive: true, force: true }).catch(() => {});
  if (!result.ok || !existsSync(out)) {
    console.log(`  screenshot failed: ${result.reason ?? 'unknown'}`);
    return null;
  }
  const meta = await sharp(out).metadata();
  if (meta.width !== 1200 || meta.height !== 630) {
    console.log(`  unexpected dimensions ${meta.width}×${meta.height}`);
    return null;
  }
  return out;
}

/** Deterministic, font-fallback vector version of the card (sharp → PNG). */
async function rasteriseFallback() {
  const mark = await readFile(MARK);
  const markDataUri = `data:image/svg+xml;base64,${mark.toString('base64')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0H0V40" fill="none" stroke="rgba(11,15,14,0.045)" stroke-width="1"/>
    </pattern>
  </defs>
  <rect width="1200" height="630" fill="#F6F3EC"/>
  <rect width="1200" height="630" fill="url(#grid)"/>
  <rect x="28.5" y="28.5" width="1143" height="573" fill="none" stroke="rgba(11,15,14,0.14)"/>

  <image href="${markDataUri}" x="86" y="78" width="54" height="54"/>
  <text x="154" y="116" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="32" font-weight="600" letter-spacing="-0.8" fill="#0E1413">Geodesia</text>
  <line x1="322" y1="92" x2="322" y2="112" stroke="rgba(11,15,14,0.22)"/>
  <text x="338" y="109" font-family="Consolas, monospace" font-size="10.5" letter-spacing="1.7" fill="#4B5C55">SPATIAL INSTRUMENTS</text>
  <text x="1114" y="97" font-family="Consolas, monospace" font-size="10.5" letter-spacing="1.5" text-anchor="end" fill="#68796F">WGS 84 · CLIENT-SIDE EXECUTION</text>

  <text x="86" y="262" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="52" font-weight="600" letter-spacing="-2" fill="#0E1413">Terrain. Area. Units.</text>
  <text x="86" y="326" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="52" font-weight="600" letter-spacing="-2" fill="#C0451E">Computed in the browser.</text>
  <text x="86" y="384" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="17" fill="#35443F">Elevation cross-sections, parcel areas from coordinates, and cadastral</text>
  <text x="86" y="409" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="17" fill="#35443F">unit conversion. Verified geodesic maths, CSV/JSON/PDF, no account.</text>

  <g transform="translate(700,316)">
    <text x="0" y="-6" font-family="Consolas, monospace" font-size="9" letter-spacing="1.4" fill="#68796F">FIG. 1 — CROSS-SECTION</text>
    <g stroke="rgba(11,15,14,0.09)" stroke-width="1">
      <line x1="0" y1="34" x2="414" y2="34"/><line x1="0" y1="72" x2="414" y2="72"/>
      <line x1="0" y1="110" x2="414" y2="110"/><line x1="0" y1="148" x2="414" y2="148"/>
    </g>
    <path d="M0 148 L22 140 L44 142 L66 130 L88 118 L110 97 L132 90 L154 76 L176 61 L198 40 L216 24 L238 42 L260 55 L282 69 L304 82 L326 94 L348 106 L370 117 L392 122 L414 127 L414 178 L0 178 Z" fill="rgba(46,111,104,0.12)"/>
    <path d="M0 148 L22 140 L44 142 L66 130 L88 118 L110 97 L132 90 L154 76 L176 61 L198 40 L216 24 L238 42 L260 55 L282 69 L304 82 L326 94 L348 106 L370 117 L392 122 L414 127" fill="none" stroke="#2E6F68" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="216" cy="24" r="4" fill="#C0451E"/>
    <line x1="216" y1="18" x2="216" y2="4" stroke="#C0451E"/>
    <text x="230" y="8" font-family="Consolas, monospace" font-size="9" letter-spacing="1" fill="#C0451E">2148 m</text>
    <line x1="0" y1="178" x2="414" y2="178" stroke="rgba(11,15,14,0.32)"/>
  </g>

  <line x1="86" y1="512" x2="1114" y2="512" stroke="rgba(11,15,14,0.14)"/>
  <g font-family="Consolas, monospace" font-size="11" letter-spacing="1.2" fill="#26322E">
    <text x="86" y="540"><tspan fill="#C0451E">01</tspan>  TERRAIN PROFILE</text>
    <text x="286" y="540"><tspan fill="#C0451E">02</tspan>  POLYGON AREA</text>
    <text x="476" y="540"><tspan fill="#C0451E">03</tspan>  LAND UNITS</text>
    <text x="1114" y="540" text-anchor="end" letter-spacing="1.0" fill="#0E1413">geodesia.online</text>
  </g>
</svg>`;
  const out = join(ogDir, 'geodesia-og.png');
  await writeFile(join(ogDir, 'geodesia-og.svg'), svg, 'utf8');
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
  return out;
}

async function buildOG() {
  console.log('Open Graph card…');
  const skipBrowser = process.env.GEODESIA_SKIP_BROWSER === '1';
  let out = skipBrowser ? null : await screenshotCard();
  if (!out) {
    console.log('  using deterministic vector rasterisation');
    out = await rasteriseFallback();
  } else {
    // keep the HTML twin for design review
    const svgSource = await readFile(join(root, 'scripts', 'og-card.html'), 'utf8');
    await writeFile(join(ogDir, 'geodesia-og.svg.source.html'), svgSource, 'utf8');
  }
  const size = await stat(out);
  const meta = await sharp(out).metadata();
  note(`geodesia-og.png (${meta.width}×${meta.height}, ${(size.size / 1024).toFixed(1)} KB)`);
}

await ensureDirs();
await buildIcons();
await buildOG();

console.log(`\nDone — ${written.length} assets written under public/.`);
