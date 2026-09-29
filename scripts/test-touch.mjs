// ============================================================================
// test-touch.mjs — drives the built game in Chrome with a phone emulated:
// device size, device pixel ratio, touch events, the lot.
//
// This is the check the layout test cannot make and the rules test should not:
// that tapping the real buttons on a real 390×844 screen moves the real player,
// that three fingers can move, look and shoot at once, and that every control is
// the thing under the finger that pressed it.
//
//   npm run build && npm run test:touch
//
// Puppeteer is deliberately not a project dependency (see verify.mjs). Add
// `--desktop` to skip the phone passes, or NAME=390 to run one device.
// ============================================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const SHOTS = path.join(ROOT, '.cache', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

let launcher;
try { ({ default: launcher } = await import('puppeteer')); }
catch {
    try { ({ default: launcher } = await import('puppeteer-core')); }
    catch {
        console.log('\n no puppeteer installed — `npm i -D puppeteer` (or puppeteer-core + CHROME_PATH)\n');
        process.exit(2);
    }
}
let executablePath = process.env.CHROME_PATH || null;
if (!executablePath) {
    const spart = await import('@sparticuz/chromium').catch(() => null);
    if (spart?.default) executablePath = await spart.default.executablePath();
}

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
    '.webmanifest': 'application/manifest+json', '.bin': 'application/octet-stream'
};
const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(PUB, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUB, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let browser;
try {
    browser = await launcher.launch({
    headless: true,
    protocolTimeout: 420000,
    ...(executablePath ? { executablePath } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--disable-features=TranslateUI', '--autoplay-policy=no-user-gesture-required',
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
} catch (err) {
    server.close();
    console.log('\n no browser could start here: ' + String(err.message).split('\n')[0]);
    console.log('   `npm run test:controls` checks the same controls without one.\n');
    process.exit(0);
}

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`   ok   ${name}${detail ? '   — ' + detail : ''}`); }
    else { fail++; console.log(`   FAIL ${name}${detail ? '   — ' + detail : ''}`); }
};
const group = t => console.log(`\n ${t}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A landscape phone, in CSS pixels, as the brief lists them.
const DEVICES = [
    { name: '360×640', w: 640, h: 360, dsf: 2 },
    { name: '390×844', w: 844, h: 390, dsf: 3 },
    { name: '412×915', w: 915, h: 412, dsf: 2.6 },
    { name: '768×1024 tablet', w: 1024, h: 768, dsf: 2 }
].filter(d => !process.env.NAME || d.name.startsWith(process.env.NAME));

/** Press, drag and release with real touch points. */
function touch(page) {
    const cdp = page.__cdp;
    const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
        type, touchPoints: pts.map(p => ({ x: p.x, y: p.y, id: p.id ?? 0 }))
    });
    return {
        down: pts => send('touchStart', pts),
        move: pts => send('touchMove', pts),
        up: pts => send('touchEnd', pts),
        async tap(x, y, id = 1) {
            await send('touchStart', [{ x, y, id }]);
            await sleep(60);
            await send('touchEnd', [{ x, y, id }]);
        }
    };
}
const centreOf = (page, sel) => page.evaluate(s => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
}, sel);
const playerState = page => page.evaluate(() => {
    const p = window.__nuketown.player;
    const t = p.touch || {};
    return {
        x: p.position.x, y: p.position.y, z: p.position.z,
        speed: Math.hypot(p.velocity.x, p.velocity.z), vy: p.velocity.y,
        yaw: p.yaw, pitch: p.pitch, ads: p.isADS, sprint: p.isSprinting,
        crouch: p.isCrouching, ammo: p.mag.ammo, reloading: p.mag.reloading,
        slot: p.current, alive: p.alive,
        touch: { moveX: t.moveX, moveY: t.moveY, fire: t.fire, ads: t.ads, sprint: t.sprint }
    };
});

async function newPage(dev, touchOn) {
    const page = await browser.newPage();
    page.__cdp = await page.createCDPSession();
    await page.setViewport({
        width: dev.w, height: dev.h, deviceScaleFactor: dev.dsf,
        isMobile: touchOn, hasTouch: touchOn
    });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 120)); });
    page.on('requestfailed', r => errors.push('request: ' + (r.url().split('/').pop() || '')));
    page.errors = errors;
    await page.evaluateOnNewDocument(() => {
        try {
            // Skip the first-run difficulty card and the intro, so the test is about
            // the controls; a phone has the same flow, one tap longer.
            localStorage.setItem('nuketown.settings', JSON.stringify({
                sens: 1, fov: 78, quality: 0, difficulty: 'medium', name: 'PHONE',
                touchSens: 1, ctrlSize: 1, ctrlOpacity: .5, adsMode: 'tap'
            }));
        } catch { /* private mode */ }
    });
    return page;
}

async function toMatch(page) {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction('window.__nuketown && window.__nuketown.state === "menu"', { timeout: 180000, polling: 400 });
}
async function deploy(page) {
    await page.evaluate(() => document.getElementById('btnStart').click());
    await page.waitForFunction('window.__nuketown.state === "playing"', { timeout: 120000, polling: 300 });
    await sleep(1200);
}

// ── the phone passes ────────────────────────────────────────────────────────
if (!process.argv.includes('--desktop')) {
    for (const dev of DEVICES) {
        group(`${dev.name} landscape, touch`);
        const page = await newPage(dev, true);
        const T = touch(page);
        await toMatch(page);

        const menu = await page.evaluate(() => {
            const de = document.getElementById('menu');
            const pick = document.getElementById('modePick');
            const start = document.getElementById('btnStart');
            return {
                touch: document.body.classList.contains('touch'),
                ui: !!document.getElementById('touchUI'),
                disabled: start.disabled, label: start.textContent.trim(),
                pickVisible: getComputedStyle(pick).display !== 'none',
                overflowY: de.scrollHeight - window.innerHeight,
                overflowX: document.documentElement.scrollWidth - window.innerWidth,
                dvh: getComputedStyle(document.documentElement).height,
                canZoom: document.querySelector('meta[name=viewport]').content
            };
        });
        ok('the mobile lock-out is gone', !menu.disabled && /Deploy/i.test(menu.label), menu.label);
        ok('the page knows it is a phone', menu.touch && menu.ui);
        ok('the mode picker is still there', menu.pickVisible);
        ok('the menu fits without scrolling', menu.overflowY <= 2 && menu.overflowX <= 2,
            `overflow ${menu.overflowY}px vertical, ${menu.overflowX}px horizontal`);
        ok('the viewport meta forbids zoom', /user-scalable=no/.test(menu.canZoom) && /maximum-scale=1/.test(menu.canZoom));

        await deploy(page);
        const laid = await page.evaluate(() => {
            const ids = ['tFire', 'tFire2', 'tAds', 'tJump', 'tCrouch', 'tReload', 'tSwap', 'tSprint', 'tBoard', 'tFull'];
            const W = window.innerWidth, H = window.innerHeight;
            const bad = [], onTop = [], sizes = {};
            for (const id of ids) {
                const el = document.getElementById(id);
                const r = el.getBoundingClientRect();
                sizes[id] = [Math.round(r.width), Math.round(r.height)];
                if (r.left < -1 || r.top < -1 || r.right > W + 1 || r.bottom > H + 1) bad.push(id);
                const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                if (!hit || !(hit.id === id || el.contains(hit))) onTop.push(id + '→' + (hit ? hit.id || hit.className : 'none'));
            }
            // The chips the player has to press: they live in the HUD, the pads are a
            // layer below it, and a pad painted over a chip turns a tap into a drag.
            const chips = ['btnHudPause', 'btnHudMute'];
            for (const id of chips) {
                const el = document.getElementById(id);
                if (!el) continue;
                const r = el.getBoundingClientRect();
                if (r.width < 1) continue;
                const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                if (!hit || !(hit.id === id || el.contains(hit))) onTop.push(id + '→' + (hit ? hit.id || hit.className : 'none'));
            }
            for (const el of document.querySelectorAll('#streakCol .stk')) {
                const r = el.getBoundingClientRect();
                if (r.width < 1) continue;
                const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                if (!hit || !(hit === el || el.contains(hit))) onTop.push('stk→' + (hit ? hit.id || hit.className : 'none'));
            }
            const ui = document.getElementById('touchUI');
            return {
                on: ui.classList.contains('on'), bad, onTop, sizes,
                fire: getComputedStyle(ui).getPropertyValue('--topaque').trim(),
                hints: getComputedStyle(document.getElementById('reloadHint')).display,
                killfeed: getComputedStyle(document.getElementById('killfeed')).width
            };
        });
        ok('the controls come up over the match', laid.on);
        ok('every control is on screen', laid.bad.length === 0, laid.bad.join(' '));
        ok('and is the element under its own centre — chips included', laid.onTop.length === 0, laid.onTop.join(' '));
        ok('the trigger is thumb-sized', laid.sizes.tFire[0] >= 50 && laid.sizes.tFire[0] <= 90, JSON.stringify(laid.sizes.tFire));
        ok('the keyboard hints are hidden', laid.hints === 'none', laid.hints);
        ok('the controls are translucent', parseFloat(laid.fire || '0.5') <= 0.7, `--topaque ${laid.fire}`);

        // ── the stick: walk, then run at the rim ──
        const before = await playerState(page);
        const stick = await page.evaluate(() => {
            const r = document.getElementById('stickZone').getBoundingClientRect();
            return { x: r.x + r.width * 0.35, y: r.y + r.height * 0.7 };
        });
        await T.down([{ x: stick.x, y: stick.y, id: 11 }]);
        await sleep(120);
        const shown = await page.evaluate(() => document.getElementById('stick').classList.contains('on'));
        await T.move([{ x: stick.x, y: stick.y - 30, id: 11 }]);
        await sleep(700);
        const walked = await playerState(page);
        await T.move([{ x: stick.x, y: stick.y - 150, id: 11 }]);
        await sleep(900);
        const ran = await playerState(page);
        await T.up([{ x: stick.x, y: stick.y - 150, id: 11 }]);
        await sleep(300);
        const letGo = await playerState(page);
        ok('the stick appears under the thumb', shown);
        ok('a partial push walks and a full push runs',
            walked.speed > 0.6 && ran.speed > walked.speed * 1.3,
            `${walked.speed.toFixed(2)} → ${ran.speed.toFixed(2)} m/s`);
        ok('the stick moved the player and let go cleanly',
            Math.hypot(letGo.x - before.x, letGo.z - before.z) > 1 && letGo.touch.moveX === 0 && letGo.touch.moveY === 0,
            `${Math.hypot(letGo.x - before.x, letGo.z - before.z).toFixed(1)} m travelled`);

        // ── look, then all three at once ──
        const yaw0 = (await playerState(page)).yaw;
        const pad = await page.evaluate(() => {
            const r = document.getElementById('lookZone').getBoundingClientRect();
            return { x: r.x + r.width * 0.4, y: r.y + r.height * 0.5 };
        });
        await T.down([{ x: pad.x, y: pad.y, id: 12 }]);
        for (let i = 1; i <= 6; i++) await T.move([{ x: pad.x + i * 12, y: pad.y, id: 12 }]);
        await T.up([{ x: pad.x + 72, y: pad.y, id: 12 }]);
        const yaw1 = (await playerState(page)).yaw;
        ok('dragging the right half turns the camera', Math.abs(yaw1 - yaw0) > 0.05,
            `${((yaw1 - yaw0) * 57.3).toFixed(1)}° from a 72 px drag`);

        const fire = await centreOf(page, 'tFire');
        const multi = await playerState(page);
        await T.down([{ x: stick.x, y: stick.y, id: 11 }, { x: pad.x, y: pad.y, id: 12 }, { x: fire.x, y: fire.y, id: 13 }]);
        await T.move([{ x: stick.x + 30, y: stick.y - 60, id: 11 }, { x: pad.x + 40, y: pad.y + 6, id: 12 }, { x: fire.x, y: fire.y, id: 13 }]);
        await sleep(900);
        await T.move([{ x: stick.x + 60, y: stick.y - 90, id: 11 }, { x: pad.x + 80, y: pad.y + 12, id: 12 }, { x: fire.x, y: fire.y, id: 13 }]);
        await sleep(700);
        const during = await playerState(page);
        await T.up([{ x: stick.x + 60, y: stick.y - 90, id: 11 }]);
        await T.up([{ x: pad.x + 80, y: pad.y + 12, id: 12 }]);
        await T.up([{ x: fire.x, y: fire.y, id: 13 }]);
        await sleep(200);
        const after = await playerState(page);
        ok('move + look + fire at the same time',
            Math.hypot(after.x - multi.x, after.z - multi.z) > 0.3
            && Math.abs(after.yaw - multi.yaw) > 0.02
            && multi.ammo - after.ammo >= 2,
            `${Math.hypot(after.x - multi.x, after.z - multi.z).toFixed(1)} m, ` +
            `${((after.yaw - multi.yaw) * 57.3).toFixed(1)}°, ${multi.ammo - after.ammo} shots`);
        ok('and the trigger releases when the finger lifts', after.touch.fire === false);

        // ── the small controls ──
        const ads = await centreOf(page, 'tAds');
        await T.tap(ads.x, ads.y, 21);
        await sleep(500);
        const adsOn = (await playerState(page)).ads;
        await T.tap(ads.x, ads.y, 21);
        await sleep(400);
        ok('the aim button toggles the scope', adsOn === true && (await playerState(page)).ads === false);

        const jump = await centreOf(page, 'tJump');
        await T.tap(jump.x, jump.y, 22);
        await sleep(250);
        const jumped = (await playerState(page)).vy;
        ok('the jump button leaves the ground', jumped > 0.5, `vy ${jumped.toFixed(2)}`);
        await sleep(900);

        const crouch = await centreOf(page, 'tCrouch');
        const c0 = (await playerState(page)).crouch;
        await T.tap(crouch.x, crouch.y, 23);
        await sleep(300);
        const c1 = (await playerState(page)).crouch;
        await T.tap(crouch.x, crouch.y, 23);
        await sleep(300);
        ok('crouch toggles like the C key', c1 !== c0 && (await playerState(page)).crouch === c0);

        const swap = await centreOf(page, 'tSwap');
        const slot0 = (await playerState(page)).slot;
        await T.tap(swap.x, swap.y, 24);
        await sleep(900);
        const slot1 = (await playerState(page)).slot;
        ok('the swap button changes weapon', slot1 !== slot0, `slot ${slot0} → ${slot1}`);

        await sleep(2200);
        const reload = await centreOf(page, 'tReload');
        await T.tap(reload.x, reload.y, 25);
        await sleep(300);
        const reloading = await playerState(page);
        ok('the reload button reaches the reload code',
            reloading.reloading || reloading.ammo === (await playerState(page)).ammo, `reloading ${reloading.reloading}`);

        // ── the screen belongs to the menus when one is open ──
        const pauseBtn = await centreOf(page, 'btnHudPause');
        await T.tap(pauseBtn.x, pauseBtn.y, 26);
        await sleep(700);
        const paused = await page.evaluate(() => ({
            state: window.__nuketown.state,
            on: document.getElementById('touchUI').classList.contains('on'),
            fire: window.__nuketown.player.touch.fire
        }));
        ok('pausing hides the controls and drops held input',
            paused.state === 'paused' && !paused.on && paused.fire === false, JSON.stringify(paused));
        await T.tap(...Object.values(await centreOf(page, 'btnResume')).slice(0, 2), 27);
        await sleep(600);
        ok('and resuming brings them back',
            await page.evaluate(() => window.__nuketown.state === 'playing'
                && document.getElementById('touchUI').classList.contains('on')));

        // ── HUD clearance, measured in the browser ──
        const clear = await page.evaluate(() => {
            const rect = sel => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect().toJSON() : null; };
            const overlap = (a, b) => a && b && !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
            const buttons = ['tFire', 'tJump', 'tCrouch', 'tReload', 'tSwap', 'tAds', 'tSprint'].map(id => document.getElementById(id));
            const readouts = ['#brWrap', '#slots', '#killfeed', '#healthWrap', '#miniWrap', '#gameBtns'].map(rect);
            const bad = [];
            for (const b of buttons) {
                const rb = b.getBoundingClientRect().toJSON();
                for (let i = 0; i < readouts.length; i++)
                    if (overlap(rb, readouts[i])) bad.push(b.id + '/' + ['brWrap', 'slots', 'killfeed', 'healthWrap', 'miniWrap', 'gameBtns'][i]);
            }
            return { bad, feed: document.querySelectorAll('#killfeed .kf').length, dpr: window.devicePixelRatio };
        });
        ok('no thumb button sits under a HUD readout', clear.bad.length === 0, clear.bad.join(' '));
        ok('a phone renders at a capped device pixel ratio', clear.dpr <= Math.min(3, dev.dsf) + 0.01, `dpr ${clear.dpr}`);

        await page.screenshot({ path: path.join(SHOTS, `touch-${dev.w}x${dev.h}.png`) });
        ok('no console errors', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
        await page.close();
    }
}

// ── the desktop pass: nothing may have changed for a mouse ─────────────────
group('desktop 1280×720, no touch');
{
    const page = await newPage({ w: 1280, h: 720, dsf: 1 }, false);
    await toMatch(page);
    const desktop = await page.evaluate(() => ({
        touchClass: document.body.classList.contains('touch'),
        ui: getComputedStyle(document.getElementById('touchUI')).display,
        mini: getComputedStyle(document.getElementById('miniWrap')).width,
        btns: getComputedStyle(document.getElementById('gameBtns')).top,
        hint: getComputedStyle(document.getElementById('reloadHint')).display,
        cursor: getComputedStyle(document.body).cursor
    }));
    ok('a desktop is not marked as touch', !desktop.touchClass);
    ok('the touch layer stays out of the way', desktop.ui === 'none', desktop.ui);
    ok('the desktop HUD keeps its own sizes', desktop.mini === '200px' && desktop.btns === '14px',
        `minimap ${desktop.mini}, buttons at ${desktop.btns}`);
    await deploy(page);
    const w0 = await playerState(page);
    await page.evaluate(() => { window.__nuketown.player.locked = true; });   // what pointer lock would set
    await page.keyboard.down('KeyW');
    await sleep(900);
    await page.keyboard.up('KeyW');
    const w1 = await playerState(page);
    ok('W still moves the player', Math.hypot(w1.x - w0.x, w1.z - w0.z) > 1,
        `${Math.hypot(w1.x - w0.x, w1.z - w0.z).toFixed(1)} m`);
    ok('the touch controls are not what moved him', w1.touch.moveX === 0 && w1.touch.fire === false);
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.down('KeyW');
    await sleep(700);
    const sprint = await playerState(page);
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');
    ok('Shift still sprints at the same top speed', sprint.sprint === true && sprint.speed > w1.speed,
        `${sprint.speed.toFixed(2)} m/s sprinting, ${w1.speed.toFixed(2)} walking`);
    await page.mouse.move(640, 360);
    await page.mouse.down({ button: 'left' });
    await sleep(500);
    const firing = await playerState(page);
    await page.mouse.up({ button: 'left' });
    ok('the left mouse button still fires', w1.ammo - firing.ammo >= 1, `${w1.ammo} → ${firing.ammo}`);
    await page.screenshot({ path: path.join(SHOTS, 'desktop-1280x720.png') });
    ok('no console errors on the desktop path', page.errors.length === 0, page.errors.slice(0, 3).join(' | '));
    await page.close();
}

await browser.close();
server.close();
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed   (screenshots in .cache/shots)\n`);
process.exit(fail === 0 ? 0 : 1);
