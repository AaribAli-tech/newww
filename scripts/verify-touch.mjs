// ============================================================================
// verify-touch.mjs — drives the built site as a phone and checks the touch layer.
//
// The desktop verifier can only prove the game boots. This one proves the parts a
// thumb actually touches:
//   • the device is read as touch, and the phone HUD (shrunken minimap/readouts)
//     and the control layer replace the mouse assumptions
//   • the move stick writes an analog vector that walks the player
//   • the look pad turns the view
//   • FIRE really shoots, and lets go when the finger lifts
//   • ADS / reload / crouch / weapon buttons reach the player
//   • the pause button pauses, and pauses release every held control so nothing
//     is stuck "down" when you come back
//   • portrait raises the rotate gate and auto-pauses; landscape clears it
//   • Round Control spectating is a THIRD PERSON shot of the teammate, not a
//     camera buried inside their head
//
// Physics assertions call the player's own update() instead of the debug step()
// helper, because step() renders — and a software GL stack in CI takes seconds per
// frame. Input state and one integration step are enough to prove the wiring.
//
//   npm run build && node scripts/serve.mjs 8420 &
//   CHROME_PATH=... VERIFY_PORT=8420 node scripts/verify-touch.mjs
// ============================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const URL_BASE = process.env.VERIFY_URL || `http://127.0.0.1:${process.env.VERIFY_PORT || 8420}`;
const SHOTS = path.join(ROOT, '.cache', 'shots');
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

let launcher = null;
for (const name of ['puppeteer', 'puppeteer-core']) {
    try { launcher = (await import(name)).default; break; } catch { /* next */ }
}
if (!launcher) { log('\n install puppeteer or puppeteer-core first\n'); process.exit(2); }

const browser = await launcher.launch({
    headless: true,
    protocolTimeout: Number(process.env.VERIFY_PROTOCOL_TIMEOUT || 420000),
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage();

const errors = [];
const failedReq = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('requestfailed', r => failedReq.push(r.url()));

const results = [];
const check = (name, pass, detail = '') => {
    results.push({ name, pass: !!pass, detail });
    log(`   ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   — ' + detail : ''}`);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// a landscape phone: ~860x400 css px, touch, no hover
const LAND = { width: 860, height: 400, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PORT = { width: 400, height: 860, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
await page.setViewport(LAND);

log('\n NUKETOWN touch build — ' + URL_BASE);
await page.goto(URL_BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
// interval polling: rAF polling blocks a single CDP call until the condition
// holds, which on a software renderer can exceed the protocol timeout
await page.waitForFunction('window.__nuketown && window.__nuketown.state === "menu"',
    { timeout: 180000, polling: 400 });

const detected = await page.evaluate(() => ({
    touchClass: document.body.classList.contains('touch'),
    coarse: matchMedia('(hover: none) and (pointer: coarse)').matches,
    ui: !!document.getElementById('touchUI'),
    fire: !!document.querySelector('.tbtn.fire'),
    rotateEl: !!document.getElementById('rotate'),
    dprCap: window.__nuketown.quality
}));
check('device read as touch, mouse-only notice gone', detected.touchClass && detected.coarse);
check('control layer installed', detected.ui && detected.fire && detected.rotateEl,
    `quality preset on phone: ${detected.dprCap}`);
check('keyboard/mode picker still available', await page.evaluate(
    () => getComputedStyle(document.getElementById('modePick')).display !== 'none'));

// no two readouts may share pixels on a screen this small
const overlaps = await page.evaluate(() => {
    const ids = ['#miniWrap', '#healthWrap', '#brWrap', '#matchBar', '#gameBtns', '#killfeed', '#nukeTrack'];
    const r = s => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
    const boxes = ids.map(s => [s, r(s)]).filter(([, b]) => b && b.width > 2 && b.height > 2);
    const out = [];
    for (let i = 0; i < boxes.length; i++) for (let k = i + 1; k < boxes.length; k++) {
        const [na, a] = boxes[i], [nb, b] = boxes[k];
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 3 && h > 3) out.push(`${na} × ${nb} (${Math.round(w)}×${Math.round(h)}px)`);
    }
    // and everything must stay inside the viewport
    const off = boxes.filter(([, b]) => b.right > innerWidth + 2 || b.bottom > innerHeight + 2 ||
        b.left < -2 || b.top < -2).map(([n]) => n);
    return { out, off };
});
check('no HUD blocks overlap each other on a phone', overlaps.out.length === 0, overlaps.out.join(', '));
check('no HUD block runs off screen', overlaps.off.length === 0, overlaps.off.join(', '));

// ── portrait gate ─────────────────────────────────────────────────────────────
await page.setViewport(PORT);
// viewport events are dispatched on the renderer's frame cadence — under a
// software GL stack that can take seconds, so wait for it instead of sleeping
const gateUp = await page.waitForFunction(
    'document.getElementById("rotate").classList.contains("on")', { timeout: 20000, polling: 300 }
).then(() => true).catch(() => false);
check('portrait raises the rotate gate', gateUp);
await page.screenshot({ path: path.join(SHOTS, 'mobile-portrait.png') }).catch(() => {});
await page.setViewport(LAND);
const cleared = await page.waitForFunction(
    '!document.getElementById("rotate").classList.contains("on")', { timeout: 8000 }
).then(() => true).catch(() => false);
check('landscape clears it again', cleared);

// ── deploy, then drive the controls with real touch events ───────────────────
await page.evaluate(() => document.getElementById('btnStart').click());
await page.waitForFunction('window.__nuketown.state === "playing"', { timeout: 120000, polling: 400 });
await sleep(800);

const boot = await page.evaluate(() => ({
    visible: document.getElementById('touchUI').classList.contains('on'),
    mode: window.__nuketown.player.touchMode,
    locked: !!document.pointerLockElement
}));
check('controls show in a live match', boot.visible);
check('player runs in touch mode without pointer lock', boot.mode && !boot.locked,
    `touchMode=${boot.mode} pointerLock=${boot.locked}`);

const scaled = await page.evaluate(() => {
    const n = s => {
        const m = getComputedStyle(document.querySelector(s)).transform.match(/matrix\(([-\d.]+)/);
        return m ? Number(m[1]) : 1;
    };
    return {
        mini: n('#miniWrap'), hp: n('#healthWrap'), ammo: n('#brWrap'),
        pause: document.querySelector('#gameBtns .gbtn').getBoundingClientRect().width,
        pauseText: getComputedStyle(document.getElementById('btnHudPause'), '::after').content,
        hudScale: n('#hud')
    };
});
check('minimap reduced 75% on mobile', Math.abs(scaled.mini - 0.25) < 0.02, `scale ${scaled.mini}`);
check('HP + ammo reduced 60%', Math.abs(scaled.hp - 0.4) < 0.02 && Math.abs(scaled.ammo - 0.4) < 0.02,
    `hp ${scaled.hp} · ammo ${scaled.ammo}`);
check('pause is a labelled 44px+ thumb target', scaled.pause >= 44 && /PAUSE/i.test(scaled.pauseText),
    `${Math.round(scaled.pause)}px · ${scaled.pauseText}`);

const geometry = await page.evaluate(() => {
    const r = id => document.getElementById(id).getBoundingClientRect();
    const stick = r('tStickZone'), look = r('tLookZone'), fire = document.querySelector('.tbtn.fire').getBoundingClientRect();
    const act = r('tActions');
    return {
        stickLeft: stick.left === 0 && stick.width < look.left + 10,
        lookRight: look.right >= window.innerWidth - 2 && look.left > window.innerWidth * 0.4,
        fireRight: fire.left > window.innerWidth * 0.5 && fire.bottom <= window.innerHeight + 2,
        fireBelowLook: fire.top > look.top + look.height * 0.5,
        actionsAboveFire: act.bottom <= fire.top + 2 && act.right > window.innerWidth * 0.5,
        rows: `actions ${Math.round(act.left)}..${Math.round(act.right)}×${Math.round(act.bottom)}`
            + ` · fire ${Math.round(fire.left)}..${Math.round(fire.top)}`,
        fireSize: Math.round(Math.min(fire.width, fire.height))
    };
});
check('move stick owns the left half', geometry.stickLeft);
check('look pad owns the right half', geometry.lookRight);
check('FIRE sits below the look area', geometry.fireRight && geometry.fireBelowLook,
    `${geometry.fireSize}px target`);
check('aim/reload/jump row sits above FIRE', geometry.actionsAboveFire, geometry.rows);

// ── move stick ────────────────────────────────────────────────────────────────
const before = await page.evaluate(() => {
    const p = window.__nuketown.player;
    return { x: p.position.x, z: p.position.z, yaw: p.yaw, ammo: p.mag.ammo };
});
const stick = await page.evaluate(() => {
    const r = document.getElementById('tStickZone').getBoundingClientRect();
    return { x: r.left + r.width * 0.45, y: r.top + r.height * 0.7 };
});
await page.touchscreen.touchStart(stick.x, stick.y);
await page.touchscreen.touchMove(stick.x, stick.y - 70);          // pushed up = forward
const axis = await page.evaluate(() => {
    const p = window.__nuketown.player;
    return { ax: p.axis.x, ay: p.axis.y, sprint: p.sprintTouch, pad: !!document.querySelector('.tpad.on') };
});
// 120 integration steps of the player alone — no render, so this is instant.
// player.paused is owned by the game loop (round-start freeze), so pin it here or
// the first frames after Deploy swallow the whole input test.
const drive = await page.evaluate(() => {
    const p = window.__nuketown.player;
    p.paused = false;
    const x0 = p.position.x, z0 = p.position.z;
    const t0 = performance.now() / 1000;
    for (let i = 0; i < 120; i++) p.update(1 / 60, t0 + i / 60);
    return {
        speed: Math.hypot(p.velocity.x, p.velocity.z),
        moved: Math.hypot(p.position.x - x0, p.position.z - z0),
        sprinting: p.isSprinting
    };
});
const movedBy = drive.moved;
await page.touchscreen.touchEnd();
check('stick pushes an analog forward vector', axis.ay > 0.8 && Math.abs(axis.ax) < 0.25,
    `axis ${axis.ax.toFixed(2)}, ${axis.ay.toFixed(2)} · pad visible ${axis.pad}`);
check('stick push actually accelerates the player', drive.speed > 2,
    `${drive.speed.toFixed(2)} m/s · ${movedBy.toFixed(2)} m of ground covered`);
check('full throw asks for a sprint', axis.sprint === true && drive.sprinting === true);
check('stick recentres on release', await page.evaluate(() => {
    const p = window.__nuketown.player;
    return p.axis.x === 0 && p.axis.y === 0 && !p.sprintTouch && !document.querySelector('.tpad.on');
}));

// ── look pad ──────────────────────────────────────────────────────────────────
const yawBefore = await page.evaluate(() => window.__nuketown.player.yaw);
const zone = await page.evaluate(() => {
    const r = document.getElementById('tLookZone').getBoundingClientRect();
    return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.35 };
});
await page.touchscreen.touchStart(zone.x, zone.y);
await page.touchscreen.touchMove(zone.x + 90, zone.y);
const yawAfter = await page.evaluate(() => window.__nuketown.player.yaw);
await page.touchscreen.touchEnd();
check('look pad turns the view', Math.abs(yawAfter - yawBefore) > 0.02,
    `Δyaw ${(yawAfter - yawBefore).toFixed(3)} rad`);

// ── fire ──────────────────────────────────────────────────────────────────────
const fireBox = await page.evaluate(() => {
    const r = document.querySelector('.tbtn.fire').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.touchscreen.touchStart(fireBox.x, fireBox.y);
const held = await page.evaluate(() => window.__nuketown.player.mouseDown);
const afterFire = await page.evaluate(() => {
    const p = window.__nuketown.player;
    const t0 = performance.now() / 1000;
    for (let i = 0; i < 40; i++) p.tryFire(t0 + i / 60);
    return p.mag.ammo;
});
await page.touchscreen.touchEnd();
check('FIRE holds the trigger down', held === true);
check('FIRE empties the mag while held', afterFire < before.ammo, `${before.ammo} → ${afterFire} rounds`);
check('FIRE releases when the finger lifts', await page.evaluate(
    () => window.__nuketown.player.mouseDown === false));
check('fire button repaints while pressed (no stuck visual)', await page.evaluate(
    () => !document.querySelector('.tbtn.fire').classList.contains('down')));

// ── secondary buttons ────────────────────────────────────────────────────────
const btns = await page.evaluate(() => {
    const p = window.__nuketown.player;
    const down = (el, id) => el.dispatchEvent(new PointerEvent('pointerdown',
        { bubbles: true, cancelable: true, pointerId: id }));
    const up = (el, id) => el.dispatchEvent(new PointerEvent('pointerup',
        { bubbles: true, cancelable: true, pointerId: id }));
    const out = {};
    const ads = document.querySelector('.tbtn.hold');
    down(ads, 11); out.adsDown = p.mouseRight === true;
    up(ads, 11);   out.adsUp = p.mouseRight === false;

    const slot2 = document.querySelectorAll('.tbtn.slot')[1];
    down(slot2, 12); up(slot2, 12);
    out.slot = p.current;

    out.crouch0 = p.isCrouching;
    const crh = document.querySelector('.tbtn.tog');
    down(crh, 13); out.crouch1 = p.isCrouching;
    down(crh, 14); out.crouch2 = p.isCrouching;

    // startReload() refuses a full mag, so empty it first
    p.mag.ammo = 4;
    const rld = document.querySelector('#tActions .tbtn:not(.hold):not(.tog)');
    down(rld, 15); up(rld, 15);
    out.reload = p.mag.reloading;
    return out;
});
check('ADS is hold-to-aim', btns.adsDown && btns.adsUp);
check('weapon slot switches gun', btns.slot === 1, `current ${btns.slot}`);
check('crouch toggles stance', btns.crouch0 === false && btns.crouch1 === true && btns.crouch2 === false);
check('reload starts', btns.reload === true);

// the slot highlight must follow the player even when the change came from keys
const highlight = await page.evaluate(async () => {
    const p = window.__nuketown.player;
    // switchTo can be refused mid-swap, so drive the state we mean to read back
    p.mag.reloading = false;
    p.current = 0;
    await new Promise(r => setTimeout(r, 260));
    p.current = 2;                                    // as if a key or wheel did it
    await new Promise(r => setTimeout(r, 460));       // the 200 ms poller
    const on = [...document.querySelectorAll('.tbtn.slot')].findIndex(b => b.classList.contains('on'));
    p.current = 0;
    return { on, cur: p.current };
});
check('weapon buttons track the live loadout', highlight.on === 2,
    `highlighted ${highlight.on + 1} while holding slot ${highlight.cur + 1}`);

// ── pause ────────────────────────────────────────────────────────────────────
// hold FIRE, then pause: the trigger must not survive into the resume
await page.touchscreen.touchStart(fireBox.x, fireBox.y);
const heldAgain = await page.evaluate(() => window.__nuketown.player.mouseDown);
await page.evaluate(() => document.getElementById('btnHudPause').click());
await sleep(150);
const paused = await page.evaluate(() => ({
    state: window.__nuketown.state,
    overlay: document.getElementById('pause').classList.contains('on'),
    uiHidden: !document.getElementById('touchUI').classList.contains('on'),
    mouse: window.__nuketown.player.mouseDown,
    axis: Math.abs(window.__nuketown.player.axis.x) + Math.abs(window.__nuketown.player.axis.y)
}));
check('pause button pauses the match', paused.state === 'paused' && paused.overlay && heldAgain === true);
check('pause hides the thumb controls', paused.uiHidden);
check('pause releases held input', paused.mouse === false && paused.axis < 1e-9);
await page.evaluate(() => document.getElementById('btnResume').click());
await sleep(150);
check('resume returns to play with controls back', await page.evaluate(() =>
    window.__nuketown.state === 'playing' && document.getElementById('touchUI').classList.contains('on')));

// portrait mid-match must pause, not just hide
await page.setViewport(PORT);
await page.waitForFunction('window.__nuketown.state === "paused"', { timeout: 20000, polling: 300 }).catch(() => {});
const rotPaused = await page.evaluate(() => ({
    state: window.__nuketown.state, gate: document.getElementById('rotate').classList.contains('on')
}));
check('rotating to portrait mid-match pauses the game', rotPaused.state === 'paused' && rotPaused.gate,
    `state ${rotPaused.state}`);
await page.evaluate(() => { const b = document.getElementById('btnResume'); if (b) b.click(); });
await page.setViewport(LAND);
await page.waitForFunction('window.__nuketown.state === "playing"', { timeout: 20000, polling: 300 }).catch(() => {});

// ── Round Control: third-person spectator ────────────────────────────────────
const spec = await page.evaluate(async () => {
    const G = window.__nuketown;
    // go back to the menu and pick a one-life round
    G.setState('menu');
    document.querySelector('#modePick .mode[data-id="ctl"]').click();
    G.startMatch();
    for (let i = 0; i < 5; i++) await new Promise(r => requestAnimationFrame(r));
    const p = G.player;
    p.takeDamage(500, 'TEST', { x: p.position.x + 3, y: 0, z: p.position.z + 3 });
    p.deathT = 3;                       // let the collapse finish (it owns 1.05 s)
    const mates = G.bots.filter(b => b.team === p.team && b.alive);
    if (!mates.length) return { error: 'no living teammates in the round' };
    // the loop owns the hand-over; drive a few frames of it directly
    for (let i = 0; i < 30; i++) G.spectateStep(1 / 60);
    const t = G.specTarget;
    if (!t) return { error: 'spectator never picked a teammate' };
    const head = { x: t.position.x, y: t.position.y + 1.6, z: t.position.z };
    const c = G.camera;
    const d = Math.hypot(c.position.x - head.x, c.position.y - head.y, c.position.z - head.z);
    const fwd = {
        x: -Math.sin(c.rotation.y) * Math.cos(c.rotation.x),
        y: Math.sin(c.rotation.x),
        z: -Math.cos(c.rotation.y) * Math.cos(c.rotation.x)
    };
    const vx = head.x - c.position.x, vy = head.y - c.position.y, vz = head.z - c.position.z;
    const vl = Math.hypot(vx, vy, vz) || 1;
    return {
        mates: mates.length, dist: d, fov: Math.round(c.fov), near: c.near,
        facing: (vx * fwd.x + vy * fwd.y + vz * fwd.z) / vl,
        above: c.position.y > t.position.y + 0.4,
        heightAboveGround: c.position.y - t.position.y,
        hud: document.getElementById('spectate').classList.contains('on'),
        hudName: document.getElementById('specName').textContent.trim()
    };
});
if (spec.error) {
    check('spectator engages in Round Control', false, spec.error);
} else {
    check('spectator sits behind the teammate (third person)', spec.dist > 1.6,
        `${spec.dist.toFixed(2)} m back · fov ${spec.fov}`);
    check('teammate is inside the frame, not behind the camera', spec.facing > 0.5,
        `facing ${spec.facing.toFixed(2)}`);
    check('camera is clear of the head mesh', spec.dist > spec.near * 4,
        `near plane ${spec.near}`);
    check('camera is raised above their feet (over-the-shoulder)', spec.above,
        `${spec.heightAboveGround.toFixed(2)} m above the ground line`);
    check('SPECTATING banner names the operator', spec.hud && spec.hudName.length > 4,
        JSON.stringify(spec.hudName));
}
await page.screenshot({ path: path.join(SHOTS, 'mobile-landscape.png') }).catch(() => {});

await browser.close();

log('\n────────────────────────────────────────────────────────────');
log(` console errors    ${errors.length ? '\n   ' + errors.slice(0, 6).join('\n   ') : 'none'}`);
log(` failed requests  ${failedReq.length ? '\n   ' + failedReq.slice(0, 6).join('\n   ') : 'none'}`);
const bad = results.filter(r => !r.pass);
log(bad.length === 0 && errors.length === 0
    ? '\n ✓ PASS — thumb controls and the third-person spectator check out\n'
    : `\n ✗ ${bad.length} check(s) failed${errors.length ? ' + console errors' : ''}\n`);
for (const b of bad) log('   - ' + b.name + (b.detail ? ' (' + b.detail + ')' : ''));
process.exit(bad.length === 0 && errors.length === 0 ? 0 : 1);
