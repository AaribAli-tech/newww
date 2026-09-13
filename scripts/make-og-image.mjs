// ============================================================================
// make-og-image.mjs — shoots public/og.png (1200x630) from a live render.
//
// The card people see when the Vercel URL gets pasted into Discord, Slack or X.
// Generating it from the running game means it can never go stale relative to
// the actual build: same map, same lighting, same sky.
//
//   npm run build && node scripts/serve.mjs 8420 &
//   CHROME_PATH=/usr/bin/chromium node scripts/make-og-image.mjs
//
// Needs a browser (puppeteer or any Chrome you point CHROME_PATH at) and the
// site being served. Output is quantised down to a friendly ~150 KB.
// ============================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_BASE = process.env.VERIFY_URL || `http://127.0.0.1:${process.env.VERIFY_PORT || 8420}`;
const OUT = path.join(ROOT, 'public', 'og.png');
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

let launcher = null;
for (const name of ['puppeteer', 'puppeteer-core']) {
    try { launcher = (await import(name)).default; break; } catch { /* try the next one */ }
}
if (!launcher) { log('\n install puppeteer (or puppeteer-core + CHROME_PATH) first\n'); process.exit(2); }

const browser = await launcher.launch({
    headless: true,
    protocolTimeout: 420000,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader', '--hide-scrollbars']
});
const page = await browser.newPage();
// 2x for a crisp card, downscaled below
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 2 });
await page.goto(URL_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__nuketown && window.__nuketown.state === "menu"', { timeout: 180000 });
// let the sky settle and the photo textures swap in behind the menu
await new Promise(r => setTimeout(r, 6000));
// the menu overlay sits over a slow cinematic orbit of the map — exactly the
// shot we want, so it is screenshotted as-is with the title on top of it
await page.screenshot({ path: OUT, type: 'png' });
await browser.close();

const sharp = (await import('sharp')).default;
const buf = await sharp(OUT).resize(1200, 630, { fit: 'cover' }).png({ quality: 80, effort: 9, palette: true }).toBuffer();
await (await import('node:fs/promises')).writeFile(OUT, buf);
log(` wrote public/og.png  ${(buf.length / 1024).toFixed(0)} KB`);
