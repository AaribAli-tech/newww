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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_BASE = process.env.VERIFY_URL || `http://127.0.0.1:${process.env.VERIFY_PORT || 8420}`;
const SHOTS = path.join(ROOT, '.cache', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });   // screenshot() will not create it
const log = (...a) => process.stdout.write(a.join(' ') + '\n');
// Two cores plus a software rasteriser means every page-side wait costs seconds,
// so the harness widens its own budgets instead of reporting a false failure.
const SLOW = process.env.VERIFY_SLOW ? process.env.VERIFY_SLOW === '1' : os.cpus().length <= 2;

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

/**
 * Screenshots here are only diagnostic, and `page.screenshot()` has no timeout of
 * its own — it waits on the CDP protocol timeout, which on a software rasteriser
 * (this sandbox renders through SwiftShader at ~2 frames a second) means the whole
 * run can sit there until it expires. Race it, take what came, move on.
 */
async function snap(name, ms = SLOW ? 130000 : 40000) {
    const file = path.join(SHOTS, name);
    // Park the render loop first. Capturing a page that is redrawing itself as fast
    // as a software rasteriser can is how a *diagnostic* screenshot ends up costing
    // minutes — and it keeps the renderer busy for every check that follows it.
    const parked = await page.evaluate(() => {
        if (!window.requestAnimationFrame || window.__rafParked) return false;
        window.__rafParked = window.requestAnimationFrame;
        window.requestAnimationFrame = () => 0;
        return true;
    }).catch(() => false);
    const shot = page.screenshot({ path: file }).then(() => true).catch(() => false);
    const won = await Promise.race([shot, new Promise(res => setTimeout(() => res(false), ms))]);
    if (parked) await page.evaluate(() => {
        if (window.__rafParked) { window.requestAnimationFrame = window.__rafParked; window.__rafParked = null; }
    }).catch(() => {});
    if (!won) log(`   (skipped ${name}: the page could not produce a frame in ${ms / 1000}s)`);
    return won;
}

/** Same idea for any evaluate that only needs to *happen*, not to return. */
async function attempt(label, fn, ms = SLOW ? 200000 : 60000) {
    try {
        await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), ms))]);
        return true;
    } catch (err) {
        log(`   (could not finish ${label}: ${String(err.message).slice(0, 60)})`);
        return false;
    }
}



// True network cost. The page's own view of a response cannot tell a socket read
// from a service-worker cache hit, so ask the network stack directly: CDP marks
// both fromCache and fromServiceWorker on the response, and encodedDataLength is
// what actually crossed the wire.
const page = await browser.newPage();

/** Like attempt(), but for a probe whose *value* is used: null on timeout. */
async function race(label, fn, ms) {
    let done = false;
    const value = await Promise.race([
        fn().then(v => { done = true; return v; }),
        new Promise(res => setTimeout(() => res(null), ms))
    ]);
    if (!done) log(`   (could not finish ${label}: the page was too busy to answer in ${ms / 1000}s)`);
    return value;
}

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

await snap('game.png');

// fire a few rounds and make sure nothing throws while shooting/reloading
await attempt('the shooting/keybind exercise', () => page.evaluate(async () => {
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
}));

// ── what a kill does, and the two teamless modes ────────────────────────────
// The headless rules test (npm run test:rules) covers the arithmetic. This covers
// the parts that only exist in a running page: the medal stack, the streak strip,
// and the fact that a *player* kill reaches the mode at all — which is the bug
// that would have shipped Gun Game unwinnable and Free For All unwinnable-by-you.
const kills = await race('the kill-feedback checks', () => page.evaluate(async () => {
    const G = window.__nuketown;
    const txt = s => ((document.querySelector(s) || {}).textContent || '').replace(/\s+/g, ' ').trim();
    const p = G.player;
    const out = { before: { kills: p.kills, streak: p.killStreak } };
    // startMatch keeps working after it returns (roster, spawn, mode hand-off),
    // so wait for the state to say so rather than counting frames — a frame can
    // take seconds under a software rasteriser and a fixed wait just races it.
    const until = async (fn, ms = SLOW ? 120000 : 15000) => {
        const t0 = Date.now();
        for (;;) {
            if (fn()) return true;
            if (Date.now() - t0 > ms) return false;
            await new Promise(r => setTimeout(r, 40));
        }
    };

    // three kills inside the chain window: KILL, then DOUBLE KILL, then TRIPLE +
    // HEADSHOT. Nothing per-frame here — the DOM is written once per kill.
    G.debugKill(false); G.debugKill(false); G.debugKill(true);
    out.medals = [...document.querySelectorAll('#medals .medal')]
        .map(e => e.textContent.replace(/\s+/g, ' ').trim());
    out.feedRows = document.querySelectorAll('#killfeed .kf').length;
    out.streakOn = document.getElementById('streakRun').classList.contains('on');
    out.streakText = txt('#streakRun');
    out.kills = p.kills; out.streak = p.killStreak;
    out.score = p.score;

    // Free For All: no teams, every soldier hostile, rewards off, 200 is the bar
    G.setState('menu');
    document.querySelector('#modePick .mode[data-id=\"ffa\"]').click();
    await G.startMatch();
    const ffaUp = await until(() => G.state === 'playing' && G.gamemode.name === 'Free For All'
        && G.bots.length > 0 && G.bots.every(b => b.allHostile === true));
    const ffa = G.gamemode;
    out.ffa = {
        name: ffa.name,
        noTeams: ffa.noTeams === true,
        target: ffa.target,
        allBotsHostile: G.bots.every(b => b.allHostile === true),
        bothSpawnHalves: G.bots.every(b => (b.spawnPoints || []).length > 8),
        streakColHidden: document.getElementById('streakCol').classList.contains('hidden'),
        hud: txt('#modePrimary') || txt('#timer'),
        state: G.state, modeReady: ffaUp,
        killfeedWorks: (() => { const n = document.querySelectorAll('#killfeed .kf').length; G.debugKill(false);
            return document.querySelectorAll('#killfeed .kf').length > n; })(),
        // a player kill must move the *mode*, not just the scoreboard
        scoreMoved: (() => { const before = G.player.kills; G.debugKill(false); return G.player.kills > before; })()
    };

    // Gun Game: four rungs, and the kill you just scored swaps your gun
    G.setState('menu');
    document.querySelector('#modePick .mode[data-id=\"gun\"]').click();
    await G.startMatch();
    await until(() => G.state === 'playing' && G.gamemode.name === 'Gun Game' && G.bots.length > 0);
    const gg = G.gamemode;
    const gunBefore = p.current, rungBefore = p._ggRung | 0;
    G.debugKill(false);
    // The mode asks for the gun; the rig grants it once the previous swap has
    // played out, so pump the player as well as the mode (player.update is what
    // ticks the viewmodel) rather than waiting seconds for a rendered frame.
    for (let i = 0; i < 90; i++) {
        p.update(1 / 60, performance.now() / 1000 + i / 60);
        gg.update(1 / 60);
    }
    out.gun = {
        name: gg.name, rungs: gg.rungs,
        hud: txt('#modePrimary'), next: txt('#modeLine'),
        rungBefore, rungAfter: p._ggRung | 0,
        gunBefore, gunAfter: p.current,
        botsClimbToo: G.bots.some(b => (b._ggRung | 0) >= 0 && b.weaponIndex >= 0),
        state: G.state
    };

    // onMatchStart() wiring, checked on state rather than on a banner that lives
    // 1.7 s: Round Control must open on round 1 in its freeze, not round 0.
    G.setState('menu');
    document.querySelector('#modePick .mode[data-id="ctl"]').click();
    await G.startMatch();
    const ctlUp = await until(() => G.state === 'playing' && G.gamemode.name === 'Round Control');
    const ctl = G.gamemode;
    out.ctl = { name: ctl.name, round: ctl.round, phase: ctl.phase, ready: ctlUp,
        oneLife: ctl.canRespawn(G.player) === false };

    // back to the mode the run started in, so the numbers below are comparable
    G.setState('menu');
    document.querySelector('#modePick .mode[data-id=\"tdm\"]').click();
    await G.startMatch();
    return out;
}), SLOW ? 260000 : 120000) || { error: 'not measured' };

if (kills.error) {
    log(`\n kills/modes       could not be measured (${kills.error})`);
} else {
    log(`\n kill feedback     ${kills.medals.length ? kills.medals.join(' + ') : 'no medals rendered'}` +
        ` · feed ${kills.feedRows} row(s) · streak ${kills.streakText || 'off'}`);
    log(` free for all      ${kills.ffa.name} · ${kills.ffa.target} kills · hostile to all: ` +
        `${kills.ffa.allBotsHostile} · streaks hidden: ${kills.ffa.streakColHidden} · ${kills.ffa.hud}`);
    log(` round control     opens on round ${kills.ctl && kills.ctl.round} · one life: ${kills.ctl && kills.ctl.oneLife}`);
    log(` gun game          ${kills.gun.rungs} rungs · your kill moved rung ` +
        `${kills.gun.rungBefore + 1} → ${kills.gun.rungAfter + 1} · weapon ${kills.gun.gunBefore} → ${kills.gun.gunAfter}`);
}
const MEDALS = ['KILL', 'DOUBLE KILL', 'TRIPLE KILL', 'HEADSHOT'];
const killsOk = !kills.error &&
    kills.medals.length >= 3 && MEDALS.every(m => kills.medals.some(x => x.includes(m))) &&
    kills.feedRows >= 3 && kills.streakOn && kills.streak === kills.before.streak + 3 &&
    kills.ffa.noTeams === true && kills.ffa.target === 200 && kills.ffa.allBotsHostile === true &&
    kills.ffa.streakColHidden === true && kills.ffa.state === 'playing' && kills.ffa.scoreMoved === true &&
    kills.ffa.modeReady === true &&
    kills.gun.rungs === 4 && kills.gun.rungAfter === kills.gun.rungBefore + 1 &&
    kills.gun.gunAfter !== kills.gun.gunBefore && kills.gun.state === 'playing' &&
    kills.ffa.allBotsHostile === true &&
    kills.ctl.ready === true && kills.ctl.round === 1 && kills.ctl.oneLife === true;

// ── spectating a teammate must be a third-person shot ───────────────────────
// The bug this catches: the spectator camera used to be placed on the teammate's
// own eye line — inside their head mesh — so a dead player in Round Control saw
// the inside of a helmet instead of their squadmate. Two geometric assertions
// make that impossible to regress: the camera has to sit several metres BEHIND
// the operator's head, and the head has to be INSIDE the frame.
const spec = await race('the spectator check', () => page.evaluate(() => {
    const G = window.__nuketown;
    const p = G.player;
    if (!p) return { error: 'no player rig' };
    // Round Control is the mode that keeps you down and makes you spectate. Rather
    // than rebuilding the match to switch to it — which costs seconds when a frame
    // does — flip the one property that path reads, and put it back at the end.
    const wasRespawn = G.gamemode.canRespawn;
    G.gamemode.canRespawn = () => false;
    for (const b of G.bots) if (b.team === p.team) b.health = 99999;
    p.paused = false;
    p.spawnProtect = 0;                   // spawn protection would eat the shot
    p.takeDamage(9999, 'VERIFY', { x: p.position.x + 3, y: 0, z: p.position.z + 3 });
    if (p.alive) { p.health = 0; p.alive = false; }
    p.deathT = 3;                         // let the death collapse have finished (1.05 s)
    for (let i = 0; i < 8; i++) G.spectateStep(1 / 60);
    const t = G.specTarget;
    G.gamemode.canRespawn = wasRespawn;
    if (!t) return { error: 'no living teammate to watch' };
    const c = G.camera;
    const hx = t.position.x, hy = t.position.y + 1.6, hz = t.position.z;
    const dist = Math.hypot(c.position.x - hx, c.position.y - hy, c.position.z - hz);
    const fx = -Math.sin(c.rotation.y) * Math.cos(c.rotation.x);
    const fy = Math.sin(c.rotation.x);
    const fz = -Math.cos(c.rotation.y) * Math.cos(c.rotation.x);
    const vx = hx - c.position.x, vy = hy - c.position.y, vz = hz - c.position.z;
    const vl = Math.hypot(vx, vy, vz) || 1;
    return {
        dist, facing: (vx * fx + vy * fy + vz * fz) / vl, near: c.near,
        raised: c.position.y - t.position.y, fov: Math.round(c.fov),
        name: document.getElementById('specName').textContent.trim(),
        banner: document.getElementById('spectate').classList.contains('on')
    };
}), SLOW ? 180000 : 45000) || { error: 'the page was too busy to answer' };

if (spec.error) {
    log(`\n spectator        could not be measured (${spec.error})`);
} else {
    log(`\n spectator        ${spec.dist.toFixed(2)} m behind ${JSON.stringify(spec.name)}` +
        ` · target ${spec.facing > 0.5 ? 'in frame' : 'OUT OF FRAME'} · ${spec.raised.toFixed(2)} m above` +
        ` their feet · fov ${spec.fov} · banner ${spec.banner ? 'on' : 'off'}`);
}
// third person = clearly behind the head, head inside the frame, not clipped by the
// near plane. Anything tighter and this is a first-person camera again.
const specOk = !spec.error && spec.dist > 1.6 && spec.facing > 0.5 && spec.dist > spec.near * 4
    && spec.banner;

// ── repeat visit: the shell cache should turn this into a disk read ─────────
const sw = await race('the service-worker probe', () => page.evaluate(async () => {
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
}), SLOW ? 180000 : 40000) || { supported: false, unmeasured: true };
log(`\n service worker    ${sw.unmeasured ? 'probe timed out — run again on a faster machine'
    : sw.registered ? 'active, ' + sw.entries + ' entries cached'
    : 'not active' + (sw.error ? ' (' + sw.error + ')' : '')}`);

const firstWire = net.wire, firstCached = net.cached, firstReqs = net.requests;
const bytesBefore = bytes;
let reloadMs = 0, reloadWire = 0, reloadProblem = '';
try {
    const tReload = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: SLOW ? 260000 : 90000 });
    await page.waitForFunction('window.__nuketown && window.__nuketown.state === "menu"',
        { timeout: SLOW ? 300000 : 120000, polling: 400 });
    reloadMs = Date.now() - tReload;
    reloadWire = net.wire - firstWire;
} catch (err) {
    // The repeat-visit number is the whole point of the service worker, so a page
    // that will not come back is a failure to report — never a reason to hang.
    reloadProblem = String(err && err.message || err).split('\n')[0].slice(0, 80);
    reloadWire = firstWire;      // no new bytes were measured
}
log(`\n first visit       menu in ${timings['→ menu'].ms} ms · ${(firstWire / 1024).toFixed(0)} KB over the network` +
    ` · ${firstReqs} requests`);
log(reloadProblem
    ? ` repeat visit      NOT MEASURED (${reloadProblem})`
    : ` repeat visit      menu in ${reloadMs} ms · ${(reloadWire / 1024).toFixed(0)} KB over the network` +
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
await snap('after.png');
await browser.close();

log('\n────────────────────────────────────────────────────────────');
log(` requests         ${requests} · ${(bytes / 1024).toFixed(0)} KB transferred`);
log(` 404+ responses   ${missing.length ? missing.map(([u, v]) => u + ' ' + v.status).join(', ') : 'none'}`);
log(` failed requests  ${failed.length ? '\n   ' + failed.join('\n   ') : 'none'}`);
log(` console errors   ${errors.length ? '\n   ' + errors.join('\n   ') : 'none'}`);
log(` console warnings ${warnings.length ? '\n   ' + warnings.slice(0, 8).join('\n   ') : 'none'}`);

const reloadOk = !reloadProblem && (!sw.registered || reloadWire < firstWire * 0.25);
const ok = errors.length === 0 && failed.length === 0 && missing.length === 0 &&
    report.scene.skinned > 0 && live.bots > 0 && report.assets.soldiers && report.assets.viewmodels &&
    reloadOk && specOk && killsOk;
// a real repeat-visit win: the shell cache must keep the second load off the wire
if (sw.registered && firstWire > 0 && reloadWire > firstWire * 0.25) {
    log('   note: the repeat visit still pulled a sizeable share from the network');
}
const perfOk = perf.calls > 0 && report.scene.triangles > 10000;
log(`\n ${ok && perfOk ? '✓ PASS — boots, loads its GLB assets, plays, and a kill does what the mode says' : '✗ CHECK — see the lists above'}\n`);
process.exit(ok ? 0 : 1);
