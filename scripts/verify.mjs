// ============================================================================
// verify.mjs — drives the built site in a real browser and reports on it.
//
// Asks the questions that matter for "can people play this off a Vercel URL":
//   • does it boot with zero console errors and zero failed requests?
//   • did the .glb soldiers, weapons and hands actually load (i.e. is the
//     Meshopt/quantised asset set readable by three.js)?
//   • how long until the menu is up, and how heavy was the download?
//   • what frame time does a live 5v5 match hold?
//
// Needs puppeteer, which is deliberately NOT a project dependency (it drags in
// a ~180 MB Chrome download). Install it when you want the check:
//
//   npm i -D puppeteer && npm run verify
//
// Set VERIFY_URL to point it at a deployed URL instead of a local build:
//   VERIFY_URL=https://nuketown.vercel.app node scripts/verify.mjs
// ============================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_BASE = process.env.VERIFY_URL || `http://127.0.0.1:${process.env.VERIFY_PORT || 8420}`;
const SHOTS = path.join(ROOT, '.cache', 'shots');
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

// puppeteer (which downloads its own Chrome) or puppeteer-core plus a browser
// you point at with CHROME_PATH — that fallback matters in containers, where
// the Chrome download is often blocked but a chromium build is reachable.
let launcher;
try {
    ({ default: launcher } = await import('puppeteer'));
} catch {
    try { ({ default: launcher } = await import('puppeteer-core')); }
    catch {
        log('\n no puppeteer installed.\n   npm i -D puppeteer            (downloads Chrome)\n   npm i -D puppeteer-core && export CHROME_PATH=/path/to/chrome\n');
        process.exit(2);
    }
}

let executablePath = process.env.CHROME_PATH || null;
if (!executablePath) {
    try {
        const spart = await import('@sparticuz/chromium').catch(() => null);
        if (spart?.default) executablePath = await spart.default.executablePath();
    } catch { /* a normal desktop Chrome install is the usual path */ }
}

const browser = await launcher.launch({
    headless: true,
    // software GL in a container renders a frame in tens of ms, so give the
    // protocol calls room to breathe
    protocolTimeout: Number(process.env.VERIFY_PROTOCOL_TIMEOUT || 420000),
    ...(executablePath ? { executablePath } : {}),
    args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--window-size=1280,720', '--disable-features=TranslateUI',
        '--autoplay-policy=no-user-gesture-required'
    ]
});

const page = await browser.newPage();
// True network cost. The page's own view of a response cannot tell a socket read
// from a service-worker cache hit, so ask the network stack directly: CDP marks
// both fromCache and fromServiceWorker on the response, and encodedDataLength is
// what actually crossed the wire.
const net = { wire: 0, cached: 0, cachedReqs: 0, requests: 0, byUrl: new Map() };
const cdp = await page.createCDPSession();
await cdp.send('Network.enable');
const seen = new Map();
cdp.on('Network.responseReceived', e => {
    seen.set(e.requestId, {
        url: e.response.url.replace(URL_BASE, '') || '/',
        fromServiceWorker: !!e.fromServiceWorker,
        fromCache: !!e.response.fromDiskCache || !!e.response.fromMemoryCache || !!e.fromServiceWorker
    });
});
cdp.on('Network.loadingFinished', e => {
    const info = seen.get(e.requestId) || { url: '?', fromCache: false, fromServiceWorker: false };
    const bytes = e.encodedDataLength || 0;
    net.requests++;
    if (info.fromCache || info.fromServiceWorker) { net.cached += bytes; net.cachedReqs++; } else net.wire += bytes;
    net.byUrl.set(info.url, { bytes, fromSW: info.fromServiceWorker });
});
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });

const errors = [];
const warnings = [];
const failed = [];
let bytes = 0;
let requests = 0;
const timings = {};

page.on('console', m => {
    const t = m.type();
    const text = m.text();
    if (t === 'error') errors.push(text);
    else if (t === 'warning') warnings.push(text);
    else if (/^\[(map|boot|assets|materials)\]/.test(text)) log('   ' + text);
});
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('requestfailed', r => failed.push(`${r.url()} — ${r.failure()?.errorText}`));
page.on('response', async r => {
    requests++;
    try {
        const h = r.headers();
        const enc = (h['content-encoding'] || '').toLowerCase();
        const raw = h['content-length'] ? Number(h['content-length']) : 0;
        bytes += raw;
        timings[r.url().replace(URL_BASE, '') || '/'] = {
            status: r.status(), cache: h['cache-control'] || '-', enc: enc || 'none',
            bytes: raw
        };
    } catch { /* non-network responses */ }
});

const t0 = Date.now();
await page.goto(URL_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });

// wait for the game to reach its menu
await page.waitForFunction('window.__nuketown && window.__nuketown.state === "menu"', { timeout: 90000, polling: 400 });
timings['→ menu'] = { status: 200, cache: '-', enc: '-', bytes: 0, ms: Date.now() - t0 };
log(`\n menu reachable in ${Date.now() - t0} ms`);

// ── start a real match and let it run ───────────────────────────────────────
await page.evaluate(() => {
    document.getElementById('btnStart').click();
});
await page.waitForFunction('window.__nuketown.state === "playing"', { timeout: 30000, polling: 400 });
log('\n match started — sampling frame time');

const report = await page.evaluate(async () => {
    const out = {};
    const G = window.__nuketown;
    out.renderer = {
        info: (() => {
            const r = G.renderer;
            const ctx = r.getContext();
            const dbg = ctx.getExtension('WEBGL_debug_renderer_info');
            return {
                api: r.capabilities.isWebGL2 ? 'webgl2' : 'webgl1',
                gpu: dbg ? ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a',
                maxTex: r.capabilities.maxTextureSize
            };
        })(),
        dpr: G.renderer.getPixelRatio()
    };
    // the debug handle tells us which optional layers landed; the scene walk
    // confirms a skinned GLB soldier is really in front of the camera
    const scene = G.scene;
    let skinned = 0, meshes = 0, tris = 0, drawCalls = 0;
    scene.traverse(o => {
        if (o.isMesh) meshes++;
        if (o.isSkinnedMesh) skinned++;
        if (o.isMesh && o.geometry) {
            const p = o.geometry.attributes.position;
            if (p) tris += (o.geometry.index ? o.geometry.index.count : p.count) / 3;
        }
    });
    out.scene = { meshes, skinned, triangles: Math.round(tris) };
    out.assets = G.assets;
    return out;
});

log(`   renderer        ${report.renderer.info.api} · ${report.renderer.info.gpu}`);
log(`   scene           ${report.scene.meshes} meshes · ${report.scene.skinned} skinned · ${report.scene.triangles.toLocaleString()} triangles`);
log(`   glb layers      soldiers ${report.assets.soldiers ? 'LOADED' : 'procedural fallback'} · viewmodels ${report.assets.viewmodels ? 'LOADED' : 'procedural fallback'} · photo textures ${report.assets.photos}`);


const perf = await page.evaluate(async () => {
    // both a frame budget and a wall clock: a software renderer can take a
    // minute for 300 frames, a real GPU a second
    const sample = () => new Promise(res => {
        const times = [];
        const start = performance.now();
        let prev = start;
        const tick = t => {
            times.push(t - prev);
            prev = t;
            if (times.length < 400 && performance.now() - start < 12000) requestAnimationFrame(tick);
            else res(times);
        };
        requestAnimationFrame(tick);
    });
    const times = await sample();
    const sorted = times.slice(5).sort((a, b) => a - b);
    const at = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    const G = window.__nuketown;
    const r = G.renderer;
    return {
        frames: sorted.length,
        median: at(0.5), p95: at(0.95), worst: sorted.length ? sorted[sorted.length - 1] : 0,
        fps: at(0.5) ? Math.round(1000 / at(0.5)) : 0,
        // the numbers that DO transfer to a real GPU: how much work a frame asks for
        calls: G.perf.calls,               // whole-frame totals, post passes included
        drawnTris: G.perf.triangles,
        programs: r.info.programs ? r.info.programs.length : -1,
        geometries: r.info.memory.geometries,
        textures: r.info.memory.textures,
        dpr: r.getPixelRatio(),
        quality: G.quality
    };
});
log(`   frame time      ${perf.frames} frames · median ${perf.median.toFixed(1)} ms · p95 ${perf.p95.toFixed(1)} ms · worst ${perf.worst.toFixed(1)} ms`);
log(`                   (SwiftShader software rasteriser in this sandbox — a real GPU is 30-100x`);
log(`                    faster; what matters here is that frames complete and never stall)`);
log(`   per-frame work  ${perf.calls} draw calls · ${perf.drawnTris.toLocaleString()} triangles · ${perf.programs} shader programs · ${perf.textures} textures`);
log(`                   pixel ratio ${perf.dpr} · quality preset ${perf.quality}`);

// ── HUD / gameplay sanity ───────────────────────────────────────────────────
const live = await page.evaluate(() => {
    const G = window.__nuketown;
    return {
        bots: G.bots.length,
        state: G.state,
        health: G.player && G.player.health,
        ammo: G.player && G.player.weapon && G.player.weapon.ammo,
        mode: G.gamemode && G.gamemode.constructor && G.gamemode.constructor.name,
        hudVisible: getComputedStyle(document.getElementById('hud')).display !== 'none',
        perfHud: (document.getElementById('perfHud') || {}).textContent
    };
});
log(`   live            ${live.bots} bots · state ${live.state} · ${live.health} hp · HUD ${live.hudVisible ? 'up' : 'missing'}`);
log(`   perf readout    ${String(live.perfHud || '').replace(/\s+/g, ' ').trim()}`);

await page.screenshot({ path: path.join(SHOTS, 'game.png') }).catch(() => {});

// fire a few rounds and make sure nothing throws while shooting/reloading
await page.evaluate(async () => {
    const G = window.__nuketown;
    const canvas = document.getElementById('gameCanvas');
    for (let i = 0; i < 3; i++) {
        canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
        await new Promise(r => setTimeout(r, 120));
        canvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
        await new Promise(r => setTimeout(r, 80));
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit3' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab' }));
    await new Promise(r => setTimeout(r, 250));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab' }));
    return true;
});

// ── repeat visit: the shell cache should turn this into a disk read ─────────
const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    try {
        const reg = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise(res => setTimeout(() => res(null), 15000))
        ]);
        if (!reg) return { supported: true, registered: false };
        const names = (await caches.keys()).filter(k => k.indexOf('nuketown-') === 0);
        let entries = 0;
        for (const k of names) entries += (await (await caches.open(k)).keys()).length;
        return { supported: true, registered: true, entries, scope: reg.scope };
    } catch (err) {
        return { supported: true, error: String(err && err.message || err) };
    }
});
log(`\n service worker    ${sw.registered ? 'active, ' + sw.entries + ' entries cached' : 'not active' + (sw.error ? ' (' + sw.error + ')' : '')}`);

const firstWire = net.wire, firstCached = net.cached, firstReqs = net.requests;
const bytesBefore = bytes;
const tReload = Date.now();
await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__nuketown && window.__nuketown.state === "menu"', { timeout: 120000, polling: 400 });
const reloadMs = Date.now() - tReload;
const reloadWire = net.wire - firstWire;
log(`\n first visit       menu in ${timings['→ menu'].ms} ms · ${(firstWire / 1024).toFixed(0)} KB over the network` +
    ` · ${firstReqs} requests`);
log(` repeat visit      menu in ${reloadMs} ms · ${(reloadWire / 1024).toFixed(0)} KB over the network` +
    ` · ${net.requests - firstReqs} requests, ${net.cachedReqs} of them answered from cache`);

// ── 404 hunt ────────────────────────────────────────────────────────────────
const missing = Object.entries(timings).filter(([, v]) => v.status >= 400);
const assetLines = Object.entries(timings)
    .filter(([u, v]) => v.bytes > 30000 && u !== '/')
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 8);
if (assetLines.length) {
    log('\n heaviest responses (compressed, as served)');
    for (const [u, v] of assetLines) {
        log(`   ${(u || '/').padEnd(46)} ${(v.bytes / 1024).toFixed(0).padStart(5)} KB  ${v.enc.padEnd(4)} ${v.cache.split(',')[0] || ''}`);
    }
}
await page.screenshot({ path: path.join(SHOTS, 'after.png') }).catch(() => {});
await browser.close();

log('\n────────────────────────────────────────────────────────────');
log(` requests         ${requests} · ${(bytes / 1024).toFixed(0)} KB transferred`);
log(` 404+ responses   ${missing.length ? missing.map(([u, v]) => u + ' ' + v.status).join(', ') : 'none'}`);
log(` failed requests  ${failed.length ? '\n   ' + failed.join('\n   ') : 'none'}`);
log(` console errors   ${errors.length ? '\n   ' + errors.join('\n   ') : 'none'}`);
log(` console warnings ${warnings.length ? '\n   ' + warnings.slice(0, 8).join('\n   ') : 'none'}`);

const reloadOk = !sw.registered || reloadWire < firstWire * 0.25;
const ok = errors.length === 0 && failed.length === 0 && missing.length === 0 &&
    report.scene.skinned > 0 && live.bots > 0 && report.assets.soldiers && report.assets.viewmodels && reloadOk;
// a real repeat-visit win: the shell cache must keep the second load off the wire
if (sw.registered && firstWire > 0 && reloadWire > firstWire * 0.25) {
    log('   note: the repeat visit still pulled a sizeable share from the network');
}
const perfOk = perf.calls > 0 && report.scene.triangles > 10000;
log(`\n ${ok && perfOk ? '✓ PASS — the web build boots, loads its GLB assets and plays' : '✗ CHECK — see the lists above'}\n`);
process.exit(ok ? 0 : 1);
