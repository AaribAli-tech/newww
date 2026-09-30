// ============================================================================
// test-touch-node.mjs — the touch layer, driven in Node against the real classes.
//
// scripts/test-touch.mjs is the one that matters: it runs Chrome with a phone
// emulated and taps the actual pixels. This one exists because a browser is not
// always available (in a container with no Chrome and no way to fetch one), and
// the parts of the touch HUD that are *code* can still be checked honestly against
// the real `Player`, the real `CollisionWorld` and the real weapon defs:
//
//   • the stick's vector maths → walk at half a throw, sprint at the rim
//   • the look drag → the same yaw/pitch path the mouse uses, ADS scaling included
//   • hold-to-fire, tap-for-semi, the aim toggle and the hold mode
//   • jump, crouch, reload, swap, scoreboard, skip
//   • three fingers at once, each on its own pointer id
//   • a button press never doubles as a camera drag
//   • a desktop still gets keys, mouse-look and no `.touch` class
//
// The DOM is a shim; everything behind it is the shipping code.
// ============================================================================

// ── a DOM small enough to run touch.js, honest enough to catch a real bug ───
const VIEW = { w: 844, h: 390 };
class ClassList {
    constructor() { this.set = new Set(); }
    add(...c) { c.forEach(x => this.set.add(x)); }
    remove(...c) { c.forEach(x => this.set.delete(x)); }
    contains(c) { return this.set.has(c); }
    toggle(c, force) {
        const on = force === undefined ? !this.set.has(c) : !!force;
        if (on) this.set.add(c); else this.set.delete(c);
        return on;
    }
}
class El {
    constructor(id) {
        this.id = id;
        this.classList = new ClassList();
        this.style = new Proxy({}, { set: (t, k, v) => { t[k] = v; return true; } });
        this.style.setProperty = (k, v) => { this.style[k] = v; };
        this.style.getPropertyValue = k => this.style[k] ?? '';
        this._l = new Map();
        this.textContent = '';
        this.disabled = false;
        this.children = [];
        this.dataset = {};
    }
    appendChild(c) { this.children.push(c); c.parent = this; return c; }
    addEventListener(t, f) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(f); }
    removeEventListener(t, f) { (this._l.get(t) || []).splice((this._l.get(t) || []).indexOf(f) >>> 0, 1); }
    dispatchEvent(e) {
        e.target = e.target || this;
        if (!e.currentTarget) e.currentTarget = this;
        for (const f of (this._l.get(e.type) || []).slice()) f(e);
        if (e.bubbles && this.parent) this.parent.dispatchEvent(e);
        return !e.defaultPrevented;
    }
    // `host.innerHTML = ''` is how both menu lists are cleared before a rebuild, so
    // the shim has to honour it — otherwise a rebuild doubles the list instead of
    // replacing it and the count in the test stops meaning anything.
    get innerHTML() { return this._html || ''; }
    set innerHTML(v) { this._html = v; if (!v) this.children.length = 0; }
    closest(sel) { return sel === '#touchUI' ? el('touchUI') : null; }
    setPointerCapture(id) { this.captured = id; }
    releasePointerCapture() { this.captured = null; }
    querySelectorAll() { return []; }
    getBoundingClientRect() {
        const r = RECT[this.id] || { x: 0, y: 0, w: 40, h: 40 };
        return { x: r.x, y: r.y, left: r.x, top: r.y, width: r.w, height: r.h, right: r.x + r.w, bottom: r.y + r.h };
    }
}
const els = new Map();
const el = id => { if (!els.has(id)) els.set(id, new El(id)); return els.get(id); };
const RECT = {
    stickZone: { x: 0, y: 0, w: VIEW.w * 0.4, h: VIEW.h },
    lookZone: { x: VIEW.w * 0.4, y: 0, w: VIEW.w * 0.6, h: VIEW.h },
    touchUI: { x: 0, y: 0, w: VIEW.w, h: VIEW.h }
};
for (const id of ['stick', 'stickKnob', 'tFire', 'tFire2', 'tAds', 'tJump', 'tCrouch', 'tReload',
    'tSwap', 'tSprint', 'tBoard', 'tSkip', 'tUp', 'tDown', 'tNext', 'tFull', 'menuFull']) {
    const size = id === 'tFire' ? 62 : id === 'stick' ? 92 : 42;
    RECT[id] = { x: 20, y: 20, w: size, h: size };
}
// Three buttons that share the top-centre row keep their own rectangles.
RECT.tBoard = { x: VIEW.w / 2 - 20, y: 8, w: 42, h: 42 };
RECT.tSkip = { x: VIEW.w / 2 + 26, y: 8, w: 42, h: 42 };
RECT.tFull = { x: VIEW.w / 2 - 96, y: 8, w: 42, h: 42 };
RECT.tFire = { x: VIEW.w - 80, y: VIEW.h - 80, w: 62, h: 62 };
RECT.tAds = { x: VIEW.w - 160, y: VIEW.h - 70, w: 42, h: 42 };
RECT.tJump = { x: VIEW.w - 80, y: VIEW.h - 160, w: 42, h: 42 };
RECT.tCrouch = { x: VIEW.w - 150, y: VIEW.h - 160, w: 42, h: 42 };
RECT.tReload = { x: VIEW.w - 220, y: VIEW.h - 70, w: 42, h: 42 };
RECT.tSwap = { x: VIEW.w - 280, y: VIEW.h - 70, w: 42, h: 42 };
RECT.tSprint = { x: VIEW.w - 220, y: VIEW.h - 160, w: 42, h: 42 };
RECT.tFire2 = { x: 24, y: VIEW.h - 200, w: 45, h: 45 };
RECT.stickZone = { x: 0, y: 0, w: VIEW.w * 0.4, h: VIEW.h };
RECT.lookZone = { x: VIEW.w * 0.4, y: 0, w: VIEW.w * 0.6, h: VIEW.h };

class PE {
    constructor(type, init = {}) {
        this.type = type;
        this.pointerId = init.pointerId ?? 1;
        this.clientX = init.clientX ?? 0;
        this.clientY = init.clientY ?? 0;
        this.button = init.button ?? 0;
        this.bubbles = !!init.bubbles;
        this.defaultPrevented = false;
    }
    preventDefault() { this.defaultPrevented = true; }
    stopPropagation() { this.stopped = true; }
}
const winListeners = new Map();
globalThis.window = globalThis;
globalThis.location = { search: '', protocol: 'https:', hostname: 'localhost' };
globalThis.addEventListener = (t, f) => {
    if (!winListeners.has(t)) winListeners.set(t, []);
    winListeners.get(t).push(f);
};
globalThis.removeEventListener = () => { };
globalThis.PointerEvent = PE;
globalThis.innerWidth = VIEW.w;
globalThis.innerHeight = VIEW.h;
globalThis.matchMedia = q => ({ matches: /coarse|hover: *none/.test(q), addEventListener() { }, addListener() { } });
globalThis.document = {
    body: el('body'), documentElement: el('html'),
    getElementById: id => el(id),
    createElement: tag => new El(tag),
    addEventListener() { }, removeEventListener() { },
    fullscreenElement: null,
    exitFullscreen: () => Promise.resolve()
};
globalThis.document.documentElement.requestFullscreen = () => Promise.resolve();
globalThis.screen = { orientation: { lock: () => Promise.resolve() } };
const buzzes = [];
Object.defineProperty(globalThis, 'navigator', {
    value: { vibrate: ms => { buzzes.push(ms); return true; } }, configurable: true
});
globalThis.localStorage = { getItem: () => null, setItem: () => { } };

// audio.js is reached by player.js; the same stand-in the rules harness uses.
const node = new Proxy(function () { }, {
    get: (o, k) => (k === 'value' || k === 'length' ? 1 : node),
    apply: () => node, set: () => true, has: () => true
});
class FakeCtx {
    constructor() { this.currentTime = 0; this.sampleRate = 48000; this.state = 'running'; this.destination = node; this.listener = { setPosition() { }, positionX: { value: 0 } }; }
    createGain() { return node; } createOscillator() { return node; } createBiquadFilter() { return node; }
    createBufferSource() { return node; } createStereoPanner() { return node; } createDynamicsCompressor() { return node; }
    createWaveShaper() { return node; } createConvolver() { return node; } createDelay() { return node; }
    createPanner() { return node; } createChannelMerger() { return node; } createPeriodicWave() { return node; }
    createBuffer(ch, len) { return { length: len, numberOfChannels: ch, sampleRate: 48000, getChannelData: () => new Float32Array(len) }; }
    resume() { return Promise.resolve(); } close() { return Promise.resolve(); }
}
globalThis.AudioContext = FakeCtx;
globalThis.webkitAudioContext = FakeCtx;

// ── the real modules ───────────────────────────────────────────────────────
const THREE = await import('three');
const { CollisionWorld } = await import('../src/js/physics.js');
const { Player } = await import('../src/js/player.js');
const { WEAPON_DEFS } = await import('../src/js/weapons.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`   ok   ${name}${detail ? '   — ' + detail : ''}`); }
    else { fail++; console.log(`   FAIL ${name}${detail ? '   — ' + detail : ''}`); }
};
const group = t => console.log(`\n ${t}`);

function makeRig() {
    const cw = new CollisionWorld();
    // A floor, and nothing else: the numbers under test are the input path's, and a
    // wall next to the spawn turns "how fast did he walk" into "how hard did the
    // solver push". The real map is exercised by the rules test.
    cw.addAABB(-200, 0, -200, 200, 0.2, 200, 'ground');
    const camera = new THREE.PerspectiveCamera(78, VIEW.w / VIEW.h, 0.06, 700);
    const vm = {
        switchT: 0, sprint: 0,
        update() { }, addLook() { }, muzzleWorld(_c, out) { return out.set(0, 0, 0); },
        startReload() { }, cancelReload() { }, onLand() { }, requestSwitch() { return true; },
        onFire() { }, prebuild() { }, resize() { }
    };
    const calls = { streaks: [], banners: [] };
    const ctx = {
        effects: { shell() { }, impact() { }, tracer() { }, muzzle() { }, muzzleSmoke() { }, debris() { } },
        hud: new Proxy({ banner: t => calls.banners.push(t) }, {
            get: (o, k) => (k in o ? o[k] : () => { })     // every HUD call is a no-op
        }),
        getBots: () => [], onHit() { }, onPlayerDeath() { }, onLoadout() { }, onRefusedSwap() { },
        useStreak: id => calls.streaks.push(id)
    };
    const player = new Player(camera, cw, vm, ctx);
    player.alive = true;
    player.locked = true;
    return { player, cw, vm, ctx, calls, camera };
}

const settings = {
    touchSens: 1, ctrlSize: 1, ctrlOpacity: 0.5, adsMode: 'tap',
    sens: 1, fov: 78, quality: 0, difficulty: 'medium'
};
let saved = 0;
let showControls = true, roamActive = false, canSkip = false, skips = 0, nexts = 0, board = null;
const roamKeys = new Map();
const roamLooks = [];
const roam = { key: (c, v) => roamKeys.set(c, v), look: (dx, dy, s) => roamLooks.push([dx, dy, s]) };
const hooks = {
    getPlayer: () => rig.player,
    settings: () => settings,
    saveSettings: () => saved++,
    state: () => 'playing',
    menuOpen: () => false,
    visible: () => showControls,
    roaming: () => roamActive,
    canSkip: () => canSkip,
    roam,
    skip: () => { skips++; },
    nextPlayer: d => { nexts += d; },
    scoreboard: v => { board = v; }
};

const rig = makeRig();
const { initTouch } = await import('../src/js/touch.js');
const touchCtl = initTouch(hooks);
ok('the touch layer starts on a coarse pointer', !!touchCtl);
ok('and marks the page', document.body.classList.contains('touch'));
ok('the player got a touch state bag', !!rig.player.touch);
ok('the state bag is inert until a finger touches it',
    rig.player.touch.moveX === 0 && rig.player.touch.fire === false && rig.player.touch.ads === false);

// ── input helpers ──────────────────────────────────────────────────────────
const at = (id) => { const r = RECT[id]; return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };
function finger(id, start) {
    const e = (type, x, y) => new PE(type, { pointerId: id, clientX: x, clientY: y, bubbles: true });
    return {
        down: (x = start.x, y = start.y) => start.el.dispatchEvent(e('pointerdown', x, y)),
        move: (x, y) => {
            if (x && typeof x === 'object') { y = x.y; x = x.x; }
            start.el.dispatchEvent(e('pointermove', x, y));
        },
        up: (x = start.x, y = start.y) => start.el.dispatchEvent(e('pointerup', x, y)),
        cancel: (x = start.x, y = start.y) => start.el.dispatchEvent(e('pointercancel', x, y))
    };
}
// player.js stamps the reload timer and the fire interval with performance.now(),
// so the harness clock has to be the same clock: it advances a frame at a time and
// is never allowed to fall behind the wall, or a timer set "now + 2.2 s" would
// expire on the next synthetic frame.
let now = performance.now() / 1000;
/** Line the harness clock back up with the wall clock. player.js stamps the reload
    timer from the wall, while the fire interval is compared against the clock the
    game is handed; when the synthetic clock has drifted ahead of the wall, a reload
    would expire the moment it is set, so a test that starts one rebases first and
    clears the one timestamp the game keeps in the future. */
const resync = () => { now = performance.now() / 1000; rig.player.lastFire = 0; };
const step = (n = 1, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) {
        now = Math.max(performance.now() / 1000, now + dt);
        touchCtl.frame();
        rig.player.update(dt, now);
        rig.player.tryFire(now);
    }
};
const stickAt = (x, y) => { const r = RECT.stickZone; return { x: r.x + x, y: r.y + y }; };
const stick = finger(11, { el: el('stickZone'), ...stickAt(150, 260) });
const look = finger(12, { el: el('lookZone'), x: 600, y: 200 });
const tap0 = (id, pid = 31) => { press(id, pid); release(id, pid); };   // no frame: for pure handlers
const press = (id, pid) => { const p = at(id); el(id).dispatchEvent(new PE('pointerdown', { pointerId: pid, clientX: p.x, clientY: p.y, bubbles: true })); };
const release = (id, pid) => { const p = at(id); el(id).dispatchEvent(new PE('pointerup', { pointerId: pid, clientX: p.x, clientY: p.y, bubbles: true })); };
const tap = (id, pid = 31) => { press(id, pid); step(1); release(id, pid); step(1); };

// ── 1 · the stick: dead zone, walk, run, release ───────────────────────────
group('the stick');
stick.down();
step(2);
ok('the base appears where the thumb landed',
    el('stick').classList.contains('on') && /left|top/.test(Object.keys(el('stick').style).join(' ')),
    `${el('stick').style.left} ${el('stick').style.top}`);
stick.move(stickAt(150, 258));            // a 2 px nudge: inside the dead zone
step(20);
ok('a dead zone means a resting thumb does not creep',
    rig.player.touch.moveX === 0 && rig.player.touch.moveY === 0
    && Math.hypot(rig.player.velocity.x, rig.player.velocity.z) < 0.05);
stick.move(stickAt(150, 260 - 22));       // ~half the throw
step(29);
const walk = Math.hypot(rig.player.velocity.x, rig.player.velocity.z);
const walkSprint = rig.player.isSprinting;
stick.move(stickAt(150, 260 - 150));      // past the rim
step(40);
const run = Math.hypot(rig.player.velocity.x, rig.player.velocity.z);
const runSprint = rig.player.isSprinting;
ok('half a throw walks, the rim runs, and the rim keeps running while held',
    walk > 3 && walk < 6.5 && run > 8.5 && !walkSprint && runSprint,
    `${walk.toFixed(2)} → ${run.toFixed(2)} m/s (walk 4.9, sprint 9.5)`);
ok('the stick never exceeds the sprint speed', run <= 9.6, `${run.toFixed(2)} m/s`);
stick.move(stickAt(150, 260 - 28));       // back below the release threshold
step(20);
ok('dropping back below the rim stops the sprint', !rig.player.isSprinting);
stick.up();
step(4);
ok('letting go zeroes the stick and hides the base',
    rig.player.touch.moveX === 0 && rig.player.touch.moveY === 0 && !el('stick').classList.contains('on'));

// ── 2 · the look drag: same path as the mouse, ADS scaling included ────────
group('the look drag');
rig.player.yaw = 0; rig.player.pitch = 0;
look.down(600, 200);
look.move(660, 200);
step(1);
const yawDrag = rig.player.yaw;
look.move(720, 180);
step(1);
const pitchDrag = rig.player.pitch;
look.up(720, 180);
step(1);
ok('a drag turns the camera', yawDrag < -0.001 && Math.abs(pitchDrag) > 0.001,
    `yaw ${(yawDrag * 57.3).toFixed(2)}°, pitch ${(pitchDrag * 57.3).toFixed(2)}°`);
ok('the deltas are spent exactly once', rig.player.touch.lookDX === 0 && rig.player.touch.lookDY === 0);
// pitch clamp: drag hard for a while
look.down(600, 200);
for (let i = 0; i < 40; i++) look.move(600, 200 - i * 20);
step(2);
const clamped = rig.player.pitch;
look.up(600, 0);
step(1);
ok('the pitch clamp holds on touch too',
    Math.abs(clamped) <= Math.PI * 0.49 + 1e-6 && Math.abs(clamped) > 0.9,
    `${(clamped * 57.3).toFixed(1)}° (limit ±${(Math.PI * 0.49 * 57.3).toFixed(1)}°)`);
// aiming through a scope turns the view less for the same drag
rig.player.yaw = 0;
look.down(600, 200); look.move(660, 200); step(1);
const hipYaw = Math.abs(rig.player.yaw);
look.up(660, 200);
rig.player.touch.ads = true;
step(30);                                            // let isADS and the fov settle
rig.player.yaw = 0;
look.down(600, 200); look.move(660, 200); step(1);
const adsYaw = Math.abs(rig.player.yaw);
look.up(660, 200);
rig.player.touch.ads = false;
step(2);
ok('the same drag turns less while aiming, exactly as with a mouse',
    adsYaw > 0 && adsYaw < hipYaw * 0.75, `${(hipYaw * 57.3).toFixed(2)}° hip → ${(adsYaw * 57.3).toFixed(2)}° scoped`);

// ── 3 · fire ───────────────────────────────────────────────────────────────
group('the triggers');
const mag = () => rig.player.mag;
mag().ammo = 30; mag().reloading = false;
press('tFire', 13);
step(30);
const held = mag().ammo;
ok('holding the trigger keeps firing',
    rig.player.touch.fire === true && 30 - held >= 3, `${30 - held} shots`);
ok('a burst buzzes once, not once per shot', buzzes.length === 1, JSON.stringify(buzzes));
release('tFire', 13);
step(2);
ok('releasing stops it', rig.player.touch.fire === false);
// semi-auto: one tap is one shot
rig.player.useSlot(WEAPON_DEFS.findIndex(w => w.fireMode === 'semi'));
rig.player.vm.requestSwitch = () => true;
step(30);
mag().ammo = 30; mag().reloading = false;
const beforeSemi = mag().ammo;
tap('tFire', 14);
step(6);
ok('a tap on a semi-automatic fires exactly once',
    beforeSemi - mag().ammo === 1, `${beforeSemi - mag().ammo} shot(s) on ${rig.player.def.short}`);
// the left-hand trigger
rig.player.useSlot(0); step(30);
mag().ammo = 30;
press('tFire2', 15);
step(24);
const leftShots = 30 - mag().ammo;
release('tFire2', 15);
step(2);
ok('the left-hand trigger fires too', leftShots >= 2, `${leftShots} shots`);

// ── 4 · aim, jump, crouch, reload, swap ────────────────────────────────────
group('the small controls');
tap('tAds', 16); step(3);
const adsOn = rig.player.isADS;
tap('tAds', 16); step(3);
ok('the aim button toggles the scope', adsOn === true && rig.player.isADS === false);
settings.adsMode = 'hold';
press('tAds', 16); step(3);
const holdOn = rig.player.isADS;
release('tAds', 16); step(3);
ok('in hold mode it aims only while pressed', holdOn === true && rig.player.isADS === false);
settings.adsMode = 'tap';
rig.player.onGround = true; rig.player._airborne = false; rig.player.velocity.y = 0;
tap('tJump', 17); step(1);
const jumpV = rig.player.velocity.y;
step(6);
ok('jump is a pulse, not a held key',
    jumpV > 1 && rig.player.touch.jump === false && rig.player.velocity.y < jumpV, `vy ${jumpV.toFixed(2)}`);
rig.player.onGround = true; rig.player.velocity.y = 0;
const crouch0 = rig.player.isCrouching;
tap('tCrouch', 18); step(2);
const crouch1 = rig.player.isCrouching;
tap('tCrouch', 18); step(2);
ok('crouch flips exactly like the C key', crouch1 !== crouch0 && rig.player.isCrouching === crouch0);
// The reload timer is stamped from the wall clock, so line the harness clock up
// *before* the press: a simulated clock running ahead would expire it instantly.
resync();
mag().ammo = 3; mag().reserve = 90; mag().reloading = false;
tap('tReload', 19);
ok('reload starts from its button', mag().reloading === true, `${mag().ammo}/${rig.player.def.magSize}`);
let guard = 0;
while (mag().reloading && guard++ < 600) step(1);
ok('and finishes, refilling the magazine', mag().ammo > 3, `${mag().ammo} rounds`);
const slot0 = rig.player.current;
tap('tSwap', 20); step(20);
ok('swap changes weapon', rig.player.current !== slot0, `${slot0} → ${rig.player.current}`);
press('tBoard', 21); step(1);
const boardUp = board === true;
release('tBoard', 21); step(1);
ok('the scoreboard button is a hold, like Tab', boardUp && board === false,
    `held ${boardUp}, released ${board}`);

// ── 5 · three fingers at once ──────────────────────────────────────────────
group('three fingers at once');
const p0 = { x: rig.player.position.x, z: rig.player.position.z, yaw: rig.player.yaw };
rig.player.yaw = 0;
rig.player.velocity.set(0, 0, 0);
mag().ammo = 30; mag().reloading = false;
stick.down(); look.down(600, 200); press('tFire', 13);
stick.move(stickAt(150, 200));
for (let i = 0; i < 30; i++) {
    look.move(600 + i * 5, 200);
    step(1);
}
const multi = {
    moved: Math.hypot(rig.player.position.x - p0.x, rig.player.position.z - p0.z),
    yaw: Math.abs(rig.player.yaw),
    shots: 30 - mag().ammo,
    live: Math.hypot(rig.player.touch.moveX, rig.player.touch.moveY) > 0.2 && rig.player.touch.fire === true,
    mx: rig.player.touch.moveX, my: rig.player.touch.moveY, fire: rig.player.touch.fire
};
stick.up(); look.up(750, 200); release('tFire', 13);
step(2);
ok('move, look and fire all hold at the same time',
    multi.moved > 0.3 && multi.yaw > 0.02 && multi.shots >= 2 && multi.live,
    `${multi.moved.toFixed(2)} m, ${(multi.yaw * 57.3).toFixed(1)}°, ${multi.shots} shots, ` +
    `stick ${multi.mx.toFixed(2)},${multi.my.toFixed(2)}, firing ${multi.fire}`);
ok('and all three release cleanly', rig.player.touch.fire === false
    && rig.player.touch.moveX === 0 && rig.player.touch.lookDX === 0);

// ── 6 · a button never doubles as a camera drag ────────────────────────────
group('the controls and the look pad do not overlap');
rig.player.yaw = 0;
const e = new PE('pointerdown', { pointerId: 41, clientX: at('tFire').x, clientY: at('tFire').y, bubbles: true });
el('tFire').dispatchEvent(e);
const dragBefore = rig.player.touch.lookDX;
el('tFire').dispatchEvent(new PE('pointermove', { pointerId: 41, clientX: at('tFire').x + 60, clientY: at('tFire').y, bubbles: true }));
step(1);
ok('pressing a button stops the event and never turns the view',
    e.defaultPrevented && e.stopped === true
    && rig.player.touch.lookDX === 0 && Math.abs(rig.player.yaw) < 0.001,
    'preventDefault + stopPropagation, no look delta');
release('tFire', 41);
ok('a second finger on the stick zone is ignored', (() => {
    stick.down();
    stick.move(stickAt(150, 100));
    step(1);
    const held = rig.player.touch.moveY;
    const second = finger(42, { el: el('stickZone'), ...stickAt(40, 320) });
    second.down();
    second.move(stickAt(40, 200));
    step(1);
    const still = rig.player.touch.moveY;
    second.up();
    stick.up();
    step(1);
    return held < -0.5 && still === held;
})());

// ── 7 · menus, death and the settings sliders ──────────────────────────────
group('what the HUD does when the screen is not the game');
showControls = false;
press('tFire', 13);
step(2);
ok('a menu takes the controls off screen and drops held input',
    !el('touchUI').classList.contains('on') && rig.player.touch.fire === false
    && rig.player.touch.ads === false && rig.player.touch.moveX === 0);
release('tFire', 13);
showControls = true;
step(2);
ok('and brings them back', el('touchUI').classList.contains('on'));
settings.ctrlSize = 1.25; settings.ctrlOpacity = 0.62;
step(1);
ok('the size and opacity sliders reach the stylesheet',
    String(el('touchUI').style['--tsize']) === '1.25' && String(el('touchUI').style['--topaque']) === '0.62',
    `${el('touchUI').style['--tsize']} / ${el('touchUI').style['--topaque']}`);
settings.ctrlOpacity = 5;      // a hand-edited profile must not blind anyone
step(1);
ok('and the opacity is clamped', parseFloat(el('touchUI').style['--topaque']) <= 0.95,
    String(el('touchUI').style['--topaque']));
settings.ctrlOpacity = 0.5;
// death drops everything
press('tFire', 13); stick.down(); stick.move(stickAt(150, 150));
step(1);
rig.player.spawnProtect = 0;
rig.player.takeDamage(999, 'TESTER', { x: 1, z: 0 });       // the real death path
step(2);
ok('dying drops every held control',
    rig.player.touch.fire === false && rig.player.touch.moveX === 0 && rig.player.touch.ads === false);
ok('and the combat buttons leave the screen with it', el('touchUI').classList.contains('dead'));
release('tFire', 13); stick.up();
rig.player.alive = true;
step(1);
ok('and come back on the next spawn', !el('touchUI').classList.contains('dead'));
rig.player.position.set(0, 0, 0);
rig.player.velocity.set(0, 0, 0);

// ── 8 · free roam ─────────────────────────────────────────────────────────
group('free roam, after death');
roamActive = true; canSkip = true;
stick.down(); stick.move(stickAt(150, 200));
look.down(600, 200); look.move(660, 210);
step(3);
ok('the stick becomes the roam camera\'s keys', roamKeys.get('KeyW') === true, JSON.stringify([...roamKeys]));
ok('the drag looks around while dead', roamLooks.length > 0 && rig.player.touch.lookDX === 0,
    JSON.stringify(roamLooks[0]));
tap('tNext', 51); tap('tSkip', 52); step(1);
ok('the roam tap targets reach next-player and skip',
    nexts === 1 && skips === 1 && el('tSkip').classList.contains('hide') === false);
stick.up(); look.up(660, 210);
canSkip = false;
step(1);
ok('the skip button hides itself when the round cannot be skipped',
    el('tSkip').classList.contains('hide'));
roamActive = false;
step(1);
ok('leaving roam clears the fly keys',
    roamKeys.get('KeyW') === false && roamKeys.get('Space') !== true);

// ── 8b · the rectangle the phone is really showing ─────────────────────────
group('the rectangle the device is really showing');
{
    const { viewportSize } = await import('../src/js/touch.js');
    const win = (inner, vv, box) => ({
        innerWidth: inner.w, innerHeight: inner.h,
        visualViewport: vv && { width: vv.w, height: vv.h },
        document: { documentElement: { clientWidth: box.w, clientHeight: box.h } }
    });
    const cut = viewportSize(win({ w: 844, h: 390 }, { w: 844, h: 346 }, { w: 844, h: 390 }));
    ok('a toolbar over the bottom of the page is not part of the screen',
        cut.w === 844 && cut.h === 346, `${cut.w}×${cut.h} of an 844×390 window`);
    const plain = viewportSize(win({ w: 844, h: 390 }, null, { w: 844, h: 390 }));
    ok('with no visual viewport it is the window', plain.w === 844 && plain.h === 390,
        `${plain.w}×${plain.h}`);
    const big = viewportSize(win({ w: 844, h: 390 }, { w: 900, h: 420 }, { w: 844, h: 390 }));
    ok('a visual viewport larger than the page does not grow the canvas',
        big.w === 844 && big.h === 390, `${big.w}×${big.h}`);

    // The pads are a second layer: a menu must take both away.
    showControls = false;
    step(2);
    ok('a menu hides the pads as well as the buttons',
        !el('touchUI').classList.contains('on') && !el('touchPads').classList.contains('on'));
    showControls = true;
    step(2);
    ok('and both come back together',
        el('touchUI').classList.contains('on') && el('touchPads').classList.contains('on'));

    // A drag nobody can use must not be spent the moment the player is back.
    roamActive = false;
    rig.player.alive = false;
    look.down(600, 200);
    for (let i = 1; i <= 5; i++) look.move(600 + i * 40, 200);
    step(2);
    const deadDX = rig.player.touch.lookDX;
    look.up(800, 200);
    rig.player.alive = true;
    rig.player.yaw = 0;
    step(1);
    ok('a drag while dead is dropped, not spent on respawn',
        deadDX === 0 && Math.abs(rig.player.yaw) < 0.001,
        `lookDX ${deadDX}, yaw ${rig.player.yaw.toFixed(3)}`);
}

// ── 9 · a desktop is untouched ─────────────────────────────────────────────
group('the desktop path');
{
    // Fresh module instance with the coarse-pointer query off.
    globalThis.matchMedia = q => ({ matches: false, addEventListener() { }, addListener() { } });
    globalThis.location.search = '?touch=0';
    const mod = await import(`../src/js/touch.js?desktop=${Date.now()}`);
    ok('IS_TOUCH is false on a fine pointer', mod.IS_TOUCH === false);
    ok('and initTouch declines to build a HUD', mod.initTouch(hooks) === null);
    document.body.classList.remove('touch');
    globalThis.location.search = '?touch=1';
    const forced = await import(`../src/js/touch.js?forced=${Date.now()}`);
    ok('?touch=1 still forces it on, for testing on a desktop', forced.IS_TOUCH === true);
    globalThis.location.search = '';
}
{
    const { player, cw: _cw } = rig;
    player.touch = { moveX: 0, moveY: 0, sprint: false, sprintBtn: false, fire: false, ads: false, jump: false, lookDX: 0, lookDY: 0 };
    player.locked = true; player.alive = true;
    player.position.set(0, 0, 0); player.velocity.set(0, 0, 0);
    player.yaw = 0; player.pitch = 0;
    const fire = (type, init) => { for (const f of (winListeners.get(type) || [])) f(init); };
    const down = () => fire('keydown', { code: 'KeyW', repeat: false, preventDefault() { } });
    const up = () => fire('keyup', { code: 'KeyW' });
    const wStart = { x: player.position.x, z: player.position.z };
    down();
    for (let i = 0; i < 40; i++) step(1);
    up();
    const walked = Math.hypot(player.position.x - wStart.x, player.position.z - wStart.z);
    ok('W still moves the player at walking speed',
        walked > 1.5 && walked < 6, `${walked.toFixed(1)} m in 0.67 s (walk 4.9 m/s)`);
    ok('and it was the keys, not the touch bag',
        player.touch.moveX === 0 && player.touch.fire === false);
    // mouse look, through the same handler a pointer-locked browser feeds
    const yaw0 = player.yaw;
    for (let i = 0; i < 10; i++) fire('mousemove', { movementX: 12, movementY: 0 });
    step(1);
    ok('the mouse still turns the camera', Math.abs(player.yaw - yaw0) > 0.05,
        `${((player.yaw - yaw0) * 57.3).toFixed(1)}°`);
    player.mouseDown = true;
    player.mag.ammo = 30;
    step(40);
    ok('the left mouse button still fires', 30 - player.mag.ammo >= 2, `${30 - player.mag.ammo} shots`);
    player.mouseDown = false;
    for (const f of (winListeners.get('keydown') || [])) f({ code: 'KeyC', repeat: false, preventDefault() { } });
    ok('C still toggles crouch', player.isCrouching === true);
}


// ── 10 · the phone leaving ─────────────────────────────────────────────────
// Nothing else pauses a touch match: the pointer-lock handler that pauses a
// desktop never runs, because a phone never takes a lock. So the layer pauses it
// when the page stops being the page the player is looking at, and asks the screen
// to stay awake while they play — a phone that dims is a phone you cannot see.
{
    const docListeners = new Map();
    globalThis.document.addEventListener = (t, f) => {
        if (!docListeners.has(t)) docListeners.set(t, []);
        docListeners.get(t).push(f);
    };
    const locks = { asked: 0, freed: 0 };
    Object.defineProperty(globalThis, 'navigator', {
        value: {
            vibrate: () => true,
            wakeLock: {
                request: async () => {
                    locks.asked++;
                    return { addEventListener() { }, release: async () => { locks.freed++; } };
                }
            }
        },
        configurable: true
    });
    const tick = () => new Promise(r => setTimeout(r, 0));
    let live = true, paused = null;
    const ctl = initTouch({ ...hooks, visible: () => live, pause: on => { paused = on; } });
    ok('a second layer can be built for the leaving test', !!ctl);
    ctl.frame();
    await tick();
    ok('a live match asks the screen to stay awake', locks.asked === 1 && locks.freed === 0,
        `${locks.asked} asked, ${locks.freed} freed`);

    globalThis.document.hidden = true;
    for (const f of (docListeners.get('visibilitychange') || [])) f({});
    await tick();
    ok('hiding the page pauses the match', paused === true);
    ok('and hands the wake lock back', locks.freed === 1, `${locks.freed} freed`);

    live = false; ctl.frame();
    live = true; ctl.frame();
    await tick();
    ok('tapping back into live play takes the lock again', locks.asked === 2, `${locks.asked} asked`);

    globalThis.document.hidden = false;
    for (const f of (winListeners.get('pagehide') || [])) f({});
    await tick();
    ok('pagehide is the other way out, and it is a pause too', paused === true && locks.freed === 2);
}


// ── 11 · how to play: the menu card, filled from the real catalogues ────────
// The card is the one place a new player is told how to play, so the test drives
// the real hud.js rather than reading the copy: whatever the game would print is
// what is asserted. Every mode has to arrive with its rules *and* its how-to line,
// and the reward rows have to name the count and how to fire them.
{
    await import('../src/js/hud.js');                 // builds the menu lists
    const { MODES } = await import('../src/js/modes.js');
    const { STREAKS } = await import('../src/js/killstreaks.js');
    await new Promise(r => setTimeout(r, 0));         // hud's own catalogue lands async

    const mh = el('howModes'), sh = el('howStreaks');
    ok('the how-to card lists every mode the menu offers',
        mh.children.length === MODES.length, `${mh.children.length} rows for ${MODES.length} modes`);
    ok('in the same order, with the name and the rules the menu shows',
        mh.children.every((r, i) => r.children.length === 3
            && r.children[0].textContent === MODES[i].name
            && r.children[1].textContent === MODES[i].desc),
        mh.children.map(r => r.children[0].textContent).join(' · '));
    ok('and every row says what you do in the mode, not only what it is',
        mh.children.every(r => r.children[2].textContent.length > 40),
        mh.children.map(r => r.children[2].textContent.length).join('/') + ' chars');

    ok('the reward rows are the game\'s own rewards, with their counts',
        sh.children.length === STREAKS.length && sh.children.every((r, i) =>
            r.children[0].textContent === STREAKS[i].label
            && r.children[1].textContent.indexOf(`${STREAKS[i].need} kills`) === 0),
        sh.children.map(r => r.children[1].textContent).join(' · '));
    ok('a run reward counts a run, and the nuke counts the match',
        /kills in a row/.test(sh.children[0].children[1].textContent)
        && /kills in the match/.test(sh.children[STREAKS.length - 1].children[1].textContent));
    ok('each reward says the key for a keyboard and the tile for a thumb',
        sh.children.every(r => {
            const key = r.children[1].children.find(c => c.className === 'deskRow');
            const tap = r.children[1].children.find(c => c.className === 'touchRow');
            return key && tap && /^ · [A-Z]$/.test(key.textContent) && /tap the tile/.test(tap.textContent);
        }),
        (sh.children[0].children[1].children.find(c => c.className === 'deskRow') || {}).textContent);
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed   (touch, no browser needed)\n`);
process.exit(fail === 0 ? 0 : 1);
