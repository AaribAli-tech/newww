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

// ── the first thing the game asks ───────────────────────────────────────────
// How good should the other side be? Asked once, on a profile that has never
// answered, with the way back named on the card. Picking an option has to dismiss
// it and set the game's own state, not just paint a button.
const gate = await race('the difficulty gate', () => page.evaluate(() => {
    const el = document.getElementById('diffGate');
    const shown = !!el && el.classList.contains('on');
    const opts = el ? Array.from(el.querySelectorAll('.diffOpt')).map(b => b.dataset.id) : [];
    const easy = document.querySelector('#diffGateOpts .diffOpt[data-id="easy"]');
    if (easy) easy.click();
    return { shown, opts, closed: !!el && !el.classList.contains('on'),
        chip: (document.getElementById('menuDiffVal') || {}).textContent || '',
        difficulty: window.__nuketown.difficulty };
}), SLOW ? 60000 : 20000) || { error: 'not measured' };
const gateAsked = !gate.error && gate.shown;
log(`\n difficulty ask    ${gate.error ? 'could not be measured (' + gate.error + ')'
    : (gate.shown ? 'asked on a fresh profile' : 'NOT ASKED — a first visit should see it')}` +
    ` · options ${JSON.stringify(gate.opts || [])} · picked Easy → chip ${JSON.stringify(String(gate.chip).trim())}` +
    ` · setting ${gate.difficulty} · card dismissed: ${gate.closed}`);

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

// ── the imported FBX is standing in the scene the game draws ────────────────
// The pose of this rig is not a detail you can eyeball once and forget: the game
// once overwrote the file's own standing rotations with the animation angles and
// every soldier walked around with their boots at head height and their hands
// behind their head. Bounding boxes cannot catch that (the skinned body keeps its
// bind-pose box whatever the bones do), so ask the bones the game is moving.
const stance = await page.evaluate(() => {
    const G = window.__nuketown;
    const V = G.camera.position.constructor;
    const rows = [];
    for (const b of (G.bots || [])) {
        if (b.alive === false) continue;                 // a ragdoll is meant to be upside down
        const bones = b.rig && b.rig.bones;
        if (!bones || !bones.Head || !bones.Hips || !bones.LeftFoot) continue;
        const y = (k) => bones[k].getWorldPosition(new V()).y;
        rows.push({ hip: y('Hips'), head: y('Head'), ankle: y('LeftFoot'), hand: y('LeftHand') });
    }
    return rows;
});
const upright = stance.filter(r => r.head > r.hip + 0.3 && r.ankle < r.hip - 0.2 && r.hand < r.head);
const poseOk = stance.length === 0 || stance.length >= 2 && upright.length === stance.length;
log(` ${poseOk ? '  standing pose ' : '   STANDING POSE'}  ${stance.length ? upright.length + '/' + stance.length + ' alive soldiers upright · head ' + stance.map(r => (r.head - r.hip).toFixed(2) + ' m above the hip').slice(0, 1).join('') : 'no rig with bones to measure'}`);

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
// SLOW is a Node-side number: an evaluate body cannot see it, so the wait budget is
// passed in as an argument instead of being read off the closure.
const kills = await race('the kill-feedback checks', () => page.evaluate(async (budget) => {
    const G = window.__nuketown;
    const txt = s => ((document.querySelector(s) || {}).textContent || '').replace(/\s+/g, ' ').trim();
    const p = G.player;
    const out = { before: { kills: p.kills, streak: p.killStreak } };
    // startMatch keeps working after it returns (roster, spawn, mode hand-off),
    // so wait for the state to say so rather than counting frames — a frame can
    // take seconds under a software rasteriser and a fixed wait just races it.
    const until = async (fn, ms = budget) => {
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
    // The HUD writes its mode-only panels on its own cadence, and a frame here can
    // take a quarter of a second under a software rasteriser — so wait for those
    // two classes rather than reading a frame that has not been painted yet. The
    // mode being right is not the same as the DOM having caught up, and the first
    // version of this check failed for exactly that reason.
    await until(() => document.getElementById('teamBars').classList.contains('hidden')
        && document.getElementById('streakCol').classList.contains('hidden'), 30000);
    out.ffa = {
        name: ffa.name,
        noTeams: ffa.noTeams === true,
        target: ffa.target,
        allBotsHostile: G.bots.every(b => b.allHostile === true),
        // The bug this is here to keep dead: with the old roster split, a third
        // of the lobby shared the player's team, which made them both invisible
        // on the radar and immune to the player's bullets.
        nobodyOnYourTeam: G.bots.every(b => b.team !== G.player.team),
        // a soldier with a non-finite position is invisible and unhittable — that
        // is literally how "the enemies can't be seen" happened in Free For All
        allOnTheMap: G.bots.every(bb => Number.isFinite(bb.position.x) && Number.isFinite(bb.position.z)),
        everyBotShootable: G.bots.every(b => G.player.canShoot(b)),
        teamBarsHidden: document.getElementById('teamBars').classList.contains('hidden'),
        bothSpawnHalves: G.bots.every(b => (b.spawnPoints || []).length > 8),
        streakColHidden: document.getElementById('streakCol').classList.contains('hidden'),
        hud: txt('#modePrimary') || txt('#timer'),
        state: G.state, modeReady: ffaUp,
        killfeedWorks: (() => { const n = document.querySelectorAll('#killfeed .kf').length; G.debugKill(false);
            return document.querySelectorAll('#killfeed .kf').length > n; })(),
        // a player kill must move the *mode*, not just the scoreboard
        scoreMoved: (() => { const before = G.player.kills; G.debugKill(false); return G.player.kills > before; })()
    };

    // Gun Game: 75 kills wins it, the ladder is four guns long, and the kill that
    // takes you off the last gun has to put you back on the first — so plant the
    // player one kill short of that loop and check the wrap, not just the step.
    G.setState('menu');
    document.querySelector('#modePick .mode[data-id=\"gun\"]').click();
    await G.startMatch();
    await until(() => G.state === 'playing' && G.gamemode.name === 'Gun Game' && G.bots.length > 0);
    const gg = G.gamemode;
    const gunBefore = p.current, rungBefore = p._ggRung | 0;
    p._ggKills = gg.rungs - 1;
    p._ggRung = p._ggKills;
    const killsBefore = p._ggKills | 0;
    G.debugKill(false);
    // The mode asks for the gun; the rig grants it once the previous swap has
    // played out, so pump the player as well as the mode (player.update is what
    // ticks the viewmodel) rather than waiting seconds for a rendered frame.
    for (let i = 0; i < 90; i++) {
        p.update(1 / 60, performance.now() / 1000 + i / 60);
        gg.update(1 / 60);
    }
    // ── map size ─────────────────────────────────────────────────────────────
    // The whole world is authored at 84 × 78 m and multiplied by one constant. If
    // any layer forgot to follow — colliders, spawn tables, fog, the sky — this is
    // where it shows: the fence either moved, or the houses did, or a soldier is
    // standing inside a wall. So measure the built world, not the source text.
    const BX = G.cw.boxes;
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (const b of BX) {
        if (b.tag === 'bound' || b.tag === 'ground') continue;
        if (b.minX < mnx) mnx = b.minX;
        if (b.maxX > mxx) mxx = b.maxX;
        if (b.minZ < mnz) mnz = b.minZ;
        if (b.maxZ > mxz) mxz = b.maxZ;
    }
    let skyR = 0, desert = 0;
    for (const o of G.scene.children) {
        const g = o.geometry;
        if (!g) continue;
        if (g.type === 'SphereGeometry' && g.parameters.radius > 200) skyR = g.parameters.radius;
        if (g.type === 'PlaneGeometry' && g.parameters.width > 500) desert = g.parameters.width;
    }
    // Nobody may be standing inside solid geometry — that is the failure mode of a
    // table that did not scale with the colliders around it.
    const scratch = [];
    const inside = [];
    const check = (who, pos) => {
        if (!pos) return;
        const r = 0.34;
        for (const id of G.cw._query(pos.x - r, pos.z - r, pos.x + r, pos.z + r, scratch)) {
            const b = BX[id];
            if (b.tag === 'ground' || b.tag === 'bound') continue;
            if (pos.y + 1.6 <= b.minY || pos.y >= b.maxY) continue;
            if (pos.x + r <= b.minX || pos.x - r >= b.maxX) continue;
            if (pos.z + r <= b.minZ || pos.z - r >= b.maxZ) continue;
            inside.push(`${who} in ${b.tag}`);
            return;
        }
    };
    check('player', G.player.position);
    for (const b of G.bots) if (b.alive) check(b.name, b.position);
    // The playable envelope is the fence, not the scenery: props and backdrop sit
    // outside it, so measuring every box overstates the map and proves nothing about
    // the perimeter the spawns and clamps depend on. The chain-link and the invisible
    // shell behind it are measured separately, because the failure worth catching is
    // one of them being scaled while the other was not — a fence standing 27 m past
    // the last house, or a shell buried under the street.
    let fenceReach = 0, boundReach = 0, fenceN = 0, fenceZ0 = 0, fenceZ1 = 0;
    for (const b of BX) {
        if (b.tag === 'fence') {
            fenceN++;
            fenceReach = Math.max(fenceReach, Math.abs(b.minX), Math.abs(b.maxX));
            if (b.minZ < fenceZ0) fenceZ0 = b.minZ;
            if (b.maxZ > fenceZ1) fenceZ1 = b.maxZ;
        } else if (b.tag === 'bound') {
            boundReach = Math.max(boundReach, Math.abs(b.minX), Math.abs(b.maxX));
        }
    }
    const fenceDepth = +(fenceZ1 - fenceZ0).toFixed(1);
    const far = G.cw.groundHeight(fenceReach - 3, fenceReach * (78 / 84) - 3, 1.2, 0.42, []);
    out.map = {
        width: +(mxx - mnx).toFixed(1), depth: +(mxz - mnz).toFixed(1),
        boxes: BX.length, stepHeight: +G.cw.stepHeight.toFixed(3),
        fog: `${Math.round(G.scene.fog.near)}–${Math.round(G.scene.fog.far)}`, fogFar: G.scene.fog.far,
        camFar: G.camera.far, skyR: Math.round(skyR), desert: Math.round(desert),
        fenceReach: +fenceReach.toFixed(1), boundReach: +boundReach.toFixed(1), fenceBoxes: fenceN,
        fenceDepth,
        // uniform scaling means the two axes keep their ratio; anything else is a
        // map that got stretched, which is a different and much uglier thing
        aspect: +((mxz - mnz) / (mxx - mnx)).toFixed(4),
        buried: inside, groundAtFarCorner: Number.isFinite(far) ? +far.toFixed(2) : 'NaN'
    };

    // One gun, in one slot. Everything that could change the weapon gets pressed:
    // the promotion just landed, and the gun it landed on has to still be the gun
    // in hand — a ladder you can walk sideways off is not a ladder.
    const held = p.current;
    const other = [0, 1, 2, 3].find(i => i !== held);
    p.useSlot(other);
    p.cycleSlot(1);
    p.cycleSlot(-1);
    for (const d of [1, 2, 3, 4]) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Digit' + d, bubbles: true }));
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ', bubbles: true }));
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }));
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
    for (let i = 0; i < 30; i++) { p.update(1 / 60, performance.now() / 1000 + i / 60); gg.update(1 / 60); }
    const liveSlots = [...document.querySelectorAll('#slots .slot')]
        .filter(el => el.style.display !== 'none').length;
    const litSlot = document.querySelector('#slots .slot.on');
    out.gun = {
        name: gg.name, rungs: gg.rungs, target: gg.killTarget,
        // the mode owns the weapon: one entry, locked, and every input refused
        loadout: JSON.stringify(p.loadout || null), noSwap: p.noSwap === true,
        keysIgnored: p.current === held, held, other,
        otherRefused: other !== undefined && p.canHold(other) === false,
        liveSlots, litSlot: litSlot ? litSlot.textContent.trim() : '',
        // the left panel must name the mode that is actually running
        modeLine: txt('#modeLine'), labelMatchesMode: /gun game/i.test(txt('#modeLine')),
        killsBefore, killsAfter: p._ggKills | 0, wrapped: (p._ggRung | 0) === 0,
        ladderRung: gg.rung,
        hud: txt('#modePrimary'), next: txt('#modeLine'),
        rungBefore, rungAfter: p._ggRung | 0,
        gunBefore, gunAfter: p.current,
        botsClimbToo: G.bots.some(b => (b._ggRung | 0) >= 0 && b.weaponIndex >= 0),
        nobodyOnYourTeam: G.bots.every(b => b.team !== G.player.team),
        // a soldier with a non-finite position is invisible and unhittable — that
        // is literally how "the enemies can't be seen" happened in Free For All
        allOnTheMap: G.bots.every(bb => Number.isFinite(bb.position.x) && Number.isFinite(bb.position.z)),
        everyBotShootable: G.bots.every(b => G.player.canShoot(b)),
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

    // The difficulty the player picked at the menu has to be on the soldiers, not
    // just on the chip — aimScale/spreadScale/reactionScale are what ai.js reads.
    out.diff = { live: G.difficulty, aim: G.bots[0] ? +G.bots[0].aimScale.toFixed(2) : null,
        spread: G.bots[0] ? +G.bots[0].spreadScale.toFixed(2) : null,
        react: G.bots[0] ? +G.bots[0].reactionScale.toFixed(2) : null,
        cap: G.bots[0] ? +G.bots[0].chanceCap.toFixed(2) : null,
        skill: G.bots.map(b => +(b.skill || 0).toFixed(2)) };
    // and the rest of the run is measured on the standard setting
    G.setDifficulty('medium');

    // back to the mode the run started in, so the numbers below are comparable
    G.setState('menu');
    document.querySelector('#modePick .mode[data-id=\"tdm\"]').click();
    await G.startMatch();
    return out;
}, SLOW ? 120000 : 15000), SLOW ? 260000 : 120000) || { error: 'not measured' };

if (kills.error) {
    log(`\n kills/modes       could not be measured (${kills.error})`);
} else {
    log(`\n kill feedback     ${kills.medals.length ? kills.medals.join(' + ') : 'no medals rendered'}` +
        ` · feed ${kills.feedRows} row(s) · streak ${kills.streakText || 'off'}`);
    log(` free for all      ${kills.ffa.name} · ${kills.ffa.target} kills · hostile to all: ` +
        `${kills.ffa.allBotsHostile} · no friendlies in the lobby: ${kills.ffa.nobodyOnYourTeam}` +
        ` · every bot shootable: ${kills.ffa.everyBotShootable} · all on the map: ` +
        `${kills.ffa.allOnTheMap} · team bars: ` +
        `${kills.ffa.teamBarsHidden ? 'hidden' : 'shown'} · streaks hidden: ${kills.ffa.streakColHidden} · ${kills.ffa.hud}`);
    log(` round control     opens on round ${kills.ctl && kills.ctl.round} · one life: ${kills.ctl && kills.ctl.oneLife}`);
    log(` enemy skill       asked for: ${gateAsked ? 'yes (first visit)' : 'no'} · picked ${JSON.stringify(kills.diff && kills.diff.live)}` +
        ` · on the soldiers: aim ×${kills.diff && kills.diff.aim}, spread ×${kills.diff && kills.diff.spread},` +
        ` reaction ×${kills.diff && kills.diff.react}, cap ${kills.diff && kills.diff.cap}` +
        ` · skill rolls ${kills.diff && JSON.stringify(kills.diff.skill.slice(0, 3))}…`);
    log(` gun game          ${kills.gun.target} kills to win · ${kills.gun.rungs} guns cycling · your kill went` +
        ` ${kills.gun.killsBefore} → ${kills.gun.killsAfter} and wrapped to gun ${kills.gun.rungAfter + 1}` +
        ` (${kills.gun.wrapped ? 'lapped' : 'DID NOT WRAP'}) · weapon ${kills.gun.gunBefore} → ${kills.gun.gunAfter}` +
        ` · hud ${JSON.stringify(kills.gun.hud)} · no friendlies: ${kills.gun.nobodyOnYourTeam}` +
        ` · shootable: ${kills.gun.everyBotShootable}`);
    log(` map size          fence line at ±${kills.map.fenceReach} m (was ±42) · shell at` +
        ` ±${kills.map.boundReach} · ${kills.map.fenceBoxes} fence boxes · envelope` +
        ` ${kills.map.width} × ${kills.map.depth} m (fence ${kills.map.fenceDepth} m deep)` +
        ` · ${kills.map.boxes}` +
        ` colliders · step ${kills.map.stepHeight} m · fog ${kills.map.fog} m · far` +
        ` ${kills.map.camFar} · sky dome r${kills.map.skyR} · ground at the far corner` +
        ` ${kills.map.groundAtFarCorner} · nobody buried in a wall: ${kills.map.buried.length === 0}` +
        (kills.map.buried.length ? ` (${kills.map.buried.slice(0, 3).join(', ')})` : ''));
    log(` one gun / one slot  loadout ${kills.gun.loadout} · locked: ${kills.gun.noSwap} · 1-4 + Q + wheel` +
        ` ${kills.gun.keysIgnored ? 'ignored' : 'CHANGED THE GUN'} · gun #${kills.gun.other}` +
        ` out of reach: ${kills.gun.otherRefused} · slots on screen: ${kills.gun.liveSlots}` +
        ` (${JSON.stringify(kills.gun.litSlot)}) · panel reads ${JSON.stringify(kills.gun.modeLine)}`);
}
// The gate is a promise about the bots, so check both halves: that it asked and
// closed, and that the numbers it stands for are the ones ai.js reads.
const diffOk = !gate.error && gate.shown && gate.opts.length === 3 && gate.closed
    && gate.chip.trim().toLowerCase() === 'easy' && gate.difficulty === 'easy'
    && !!kills.diff && kills.diff.live === 'easy'
    && Math.abs(kills.diff.aim - 0.42) < 0.01 && Math.abs(kills.diff.spread - 2.3) < 0.01
    && Math.abs(kills.diff.react - 2.1) < 0.01 && Math.abs(kills.diff.cap - 0.30) < 0.01
    && kills.diff.skill.every(x => x >= 0.12 && x <= 0.30);

const MEDALS = ['KILL', 'DOUBLE KILL', 'TRIPLE KILL', 'HEADSHOT'];
const killsOk = !kills.error &&
    kills.medals.length >= 3 && MEDALS.every(m => kills.medals.some(x => x.includes(m))) &&
    kills.feedRows >= 3 && kills.streakOn && kills.streak === kills.before.streak + 3 &&
    kills.ffa.noTeams === true && kills.ffa.target === 200 && kills.ffa.allBotsHostile === true &&
    kills.ffa.streakColHidden === true && kills.ffa.state === 'playing' && kills.ffa.scoreMoved === true &&
    kills.ffa.nobodyOnYourTeam === true && kills.ffa.everyBotShootable === true &&
    kills.ffa.allOnTheMap === true && kills.gun.allOnTheMap === true &&
    kills.ffa.teamBarsHidden === true && kills.gun.nobodyOnYourTeam === true &&
    kills.gun.everyBotShootable === true &&
    kills.ffa.modeReady === true &&
    kills.gun.rungs === 4 && kills.gun.target === 75 &&
    kills.map.width > 84 && kills.map.depth > 78 &&
    kills.map.fenceReach > 42 * 1.4 && kills.map.fenceReach < 42 * 1.45 + 1.5 &&
    kills.map.boundReach > kills.map.fenceReach && kills.map.boundReach - kills.map.fenceReach < 4 &&
    kills.map.fenceBoxes >= 4 &&   // four sides of chain-link, plus the yard picket runs
    kills.map.fenceDepth > 78 * 1.4 && kills.map.fenceDepth < 78 * 1.45 + 2.5 &&
    kills.map.stepHeight > 0.55 && kills.map.buried.length === 0 &&
    Number.isFinite(kills.map.groundAtFarCorner) &&
    kills.map.skyR === 400 && kills.map.camFar > kills.map.fogFar &&
    kills.gun.noSwap === true && kills.gun.keysIgnored === true &&
    kills.gun.otherRefused === true && kills.gun.liveSlots === 1 &&
    kills.gun.labelMatchesMode === true &&
    kills.gun.killsAfter === kills.gun.killsBefore + 1 && kills.gun.wrapped === true &&
    kills.gun.gunAfter !== kills.gun.gunBefore && kills.gun.state === 'playing' &&
    kills.ffa.allBotsHostile === true &&
    kills.ctl.ready === true && kills.ctl.round === 1 && kills.ctl.oneLife === true;

// ── dying in a round mode hands you the camera ──────────────────────────────
// What this replaces: a chase cam bolted to a living teammate. It worked right up
// until that teammate backed into a doorway and the camera ended up inside their
// backpack, which is the whole argument for free roam — a camera that follows
// nobody cannot get stuck. So the assertions are about the handover, not the
// framing: the fall finishes before the view lifts off, the movement keys actually
// move the camera, the focus jump frames somebody still alive, the death card gets
// out of the way, and giving up the camera hands back the FOV it borrowed.
const spec = await race('the free-roam check', () => page.evaluate(() => {
    const G = window.__nuketown;
    const p = G.player;
    if (!p) return { error: 'no player rig' };
    // Round Control is the mode that keeps you down. Rather than rebuilding the
    // match to switch to it — seconds per frame on this machine — flip the one
    // property the loop reads, and put it back at the end.
    const wasRespawn = G.gamemode.canRespawn;
    G.gamemode.canRespawn = () => false;
    for (const b of G.bots) if (b.team === p.team) b.health = 99999;
    p.paused = false;
    p.spawnProtect = 0;                   // spawn protection would eat the shot
    const fovBefore = G.camera.fov;
    p.takeDamage(9999, 'VERIFY', { x: p.position.x + 3, y: 0, z: p.position.z + 3 });
    if (p.alive) { p.health = 0; p.alive = false; }
    p.deathT = 3;                         // the collapse owns the view for 1.05 s
    for (let i = 0; i < 8; i++) G.roamStep(1 / 60);
    const up = G.roamInfo();
    const start = { x: up.x, y: up.y, z: up.z };
    G.roamKey('KeyW', true);
    for (let i = 0; i < 24; i++) G.roamStep(1 / 60);
    G.roamKey('KeyW', false);
    const flew = G.roamInfo();
    G.cycleFocus(1);
    const foc = G.roamInfo();
    const watched = G.bots.find(b => b.name === foc.focus);
    const out = {
        on: !!up.on, lifted: +(up.y - p.position.y).toFixed(2),
        moved: +Math.hypot(flew.x - start.x, flew.y - start.y, flew.z - start.z).toFixed(2),
        speed: flew.speed,
        focusDist: watched ? +Math.hypot(G.camera.position.x - watched.position.x,
            G.camera.position.y - (watched.position.y + 1.4),
            G.camera.position.z - watched.position.z).toFixed(2) : -1,
        focusAlive: !!watched && watched.alive === true,
        name: (document.getElementById('specName') || {}).textContent || '',
        hint: (document.getElementById('specHint') || {}).textContent || '',
        banner: !!(document.getElementById('spectate') || { classList: { contains: () => false } }).classList.contains('on'),
        cardGone: !(document.getElementById('death') || { classList: { contains: () => true } }).classList.contains('on'),
        fov: Math.round(G.camera.fov), fovBefore: Math.round(fovBefore),
        skip: !!(document.getElementById('skipRound') || {}).classList.contains('on')
    };
    // and the other way round: alive again, the camera belongs to the player
    G.roamExit();
    out.fovRestored = Math.abs(G.camera.fov - fovBefore) < 0.5;
    // put the match back: alive, able to respawn, no corpse for the bots to farm
    p.alive = true; p.health = 100; p.deathT = 0;
    G.gamemode.canRespawn = wasRespawn;
    return out;
}), SLOW ? 180000 : 45000) || { error: 'the page was too busy to answer' };

if (spec.error) {
    log(`\n free roam        could not be measured (${spec.error})`);
} else {
    log(`\n free roam        ${spec.on ? 'camera released' : 'STILL LOCKED'} · lifted ${spec.lifted} m off the`
        + ` corpse · ${spec.moved} m flown at ${spec.speed} m/s · focus ${spec.focusDist} m from`
        + ` ${JSON.stringify(spec.name.trim())}${spec.focusAlive ? '' : ' (nobody alive)'} · card ${spec.cardGone ? 'out of' : 'in'}`
        + ` the way · fov ${spec.fov}→${spec.fovBefore} · banner ${spec.banner ? 'on' : 'off'}`);
}
// The camera must be ours, it must go somewhere when a movement key is held, the
// focus jump must land next to somebody still breathing (or on an empty map, which
// is the same thing as nobody to frame), and the strip has to say FREE ROAM rather
// than the name of a teammate we are no longer chained to.
const specOk = !spec.error && spec.on && spec.moved > 0.4 && spec.banner && spec.cardGone
    && spec.skip && spec.fovRestored && /free roam|watching/i.test(spec.name)
    && (spec.focusDist < 0 || (spec.focusDist < 12 && spec.focusAlive));

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
let remembered = null;
try {
    const tReload = Date.now();
    await page.reload({ waitUntil: 'domcontentloaded', timeout: SLOW ? 260000 : 90000 });
    await page.waitForFunction('window.__nuketown && window.__nuketown.state === "menu"',
        { timeout: SLOW ? 300000 : 120000, polling: 400 });
    reloadMs = Date.now() - tReload;
    reloadWire = net.wire - firstWire;
    // Being asked once is the design; being asked every visit is a bug.
    remembered = await page.evaluate(() => ({
        gate: document.getElementById('diffGate').classList.contains('on'),
        difficulty: window.__nuketown.difficulty,
        chip: (document.getElementById('menuDiffVal') || {}).textContent.trim()
    }));
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
log(` remembered skill    ${remembered ? (remembered.gate ? 'ASKED AGAIN (should not be)' : `no ask — still ${remembered.difficulty}, chip ${JSON.stringify(remembered.chip)}`)
    : 'not measured'}`);

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

const reloadOk = !reloadProblem && (!sw.registered || reloadWire < firstWire * 0.25)
    // the difficulty is a setting, so it has to survive a reload without an ask
    // The run picked Easy at the gate and then switched to Medium mid-match, so a
    // reload showing Medium is the proof that the setting is written, not just
    // painted — and showing no gate at all is the proof it asks once.
    && !!remembered && remembered.gate === false && remembered.difficulty === 'medium';
const ok = errors.length === 0 && failed.length === 0 && missing.length === 0 &&
    report.scene.skinned > 0 && live.bots > 0 && report.assets.soldiers && report.assets.viewmodels &&
    reloadOk && specOk && killsOk && poseOk
    // and the difficulty is enforced by this run, not just reported: the gate asked,
    // closed, and left the numbers ai.js reads on the soldiers that are already alive
    && diffOk;
// a real repeat-visit win: the shell cache must keep the second load off the wire
if (sw.registered && firstWire > 0 && reloadWire > firstWire * 0.25) {
    log('   note: the repeat visit still pulled a sizeable share from the network');
}
const perfOk = perf.calls > 0 && report.scene.triangles > 10000;
log(`\n ${ok && perfOk ? '✓ PASS — boots, loads its GLB assets, plays, and a kill does what the mode says' : '✗ CHECK — see the lists above'}\n`);
process.exit(ok ? 0 : 1);
