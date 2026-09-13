// ============================================================================
// main.js — bootstrap, game loop and glue.
// ============================================================================
import * as THREE from 'three';
import { buildNuketown, SPAWN_A, SPAWN_B, MAP_BOUNDS } from './map.js';
import { CollisionWorld } from './physics.js';
import { ViewModel } from './viewmodel.js';
import { Player } from './player.js';
import { Bot } from './ai.js';
import { HUD } from './hud.js';
import { Effects } from './effects.js';
import { Killstreaks } from './killstreaks.js';
import { createMode, MODES } from './modes.js';
import { selectedMode as pickedMode, onModeChange } from './hud.js';
import { createPostFX } from './shaders.js';
import { characterAssets } from './character.js';
import { vmAssets, vmAssetsReady } from './vmassets.js';
import { upgradeTextures, photoStatus } from './materials.js';
import { mergeStaticScene, mergeRig, pruneShadowCasters } from './optimize.js';
import { WEAPON_DEFS } from './weapons.js';
import { TEAM_A, TEAM_B, BOT_NAMES_A, BOT_NAMES_B, randElement, clamp, shuffle } from './utils.js';
import * as A from './audio.js';

const canvas = document.getElementById('gameCanvas');
const $ = id => document.getElementById(id);

let renderer, scene, camera, sun, composerFX, sky, dust;
let cw, effects, vm, player, hud, streaks, gamemode;
let bots = [];
let state = 'loading';           // loading | menu | playing | paused | ended
let last = 0, elapsed = 0;
// One whole frame's GPU work, for the F readout. three resets renderer.info on
// every render() call, and the post composer renders several passes per frame,
// so reading info directly reports the last pass only — it always looked like
// "1 draw". Accumulate instead and hand the finished frame to the HUD.
const frameStats = { calls: 0, triangles: 0 };
// adaptive resolution — targets 60 fps (16.7 ms)
const DEVICE_DPR = window.devicePixelRatio || 1;
let maxDpr = 1.15, curDpr = 1.0, frameAvg = 16, dprCooldown = 0;
const DPR_FLOOR = 0.6;
let charShadowsEnabled = true;
// The menu picker owns the choice; mirror it here so startMatch can read it.
let selectedMode = pickedMode() || MODES[0].id;
onModeChange(id => { selectedMode = id; });
// Auto quality: accumulates seconds of comfortably-fast frames before stepping
// the preset up. Locked once the player picks a preset by hand.
let qualityHeadroom = 0, autoQualityLocked = false;
const dprCooldownStep = 1.0;
let fpsAccum = 0, fpsFrames = 0;
let respawnTimer = 0;
let deadInfo = null;
let boardOpen = false;
let shadowTick = 0;
const RESPAWN_TIME = 4.0;

// The three levers that actually move frame time on a weak GPU are: how many
// lights every material has to evaluate per pixel, how expensive the shadow
// filter is, and how many full-screen post passes run. Resolution is a fourth,
// handled separately by the adaptive scaler.
const QUALITY = [
    {
        name: 'Low', shadow: 1024, shadowEvery: 3, dprCap: 0.90, post: 0,
        shadowType: THREE.BasicShadowMap, interiorLights: false, charShadows: false
    },
    {
        name: 'Medium', shadow: 1024, shadowEvery: 2, dprCap: 1.15, post: 1,
        shadowType: THREE.PCFShadowMap, interiorLights: false, charShadows: true
    },
    {
        name: 'High', shadow: 2048, shadowEvery: 2, dprCap: 1.60, post: 2,
        shadowType: THREE.PCFSoftShadowMap, interiorLights: true, charShadows: true
    }
];
// Start on Low. A first run that stutters is a much worse first impression than
// one that looks slightly plainer, and the auto-tuner raises the preset within
// a few seconds on any machine with headroom to spare.
const DEFAULTS = { sens: 1.0, fov: 78, quality: 0 };
let settings = { ...DEFAULTS };

function loadSettings() {
    try {
        const raw = localStorage.getItem('nuketown.settings');
        if (raw) settings = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch { settings = { ...DEFAULTS }; }
}
function saveSettings() {
    try { localStorage.setItem('nuketown.settings', JSON.stringify(settings)); } catch { /* private mode */ }
}

const _v = new THREE.Vector3();

// A missing GPU blocklist entry or a disabled "hardware acceleration" flag used to
// mean an eternal loading bar. Say what is wrong instead.
function webglSupported() {
    try {
        const c = document.createElement('canvas');
        return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
        return false;
    }
}

/** Replaces the loader with a readable message. Also used for boot exceptions. */
function showBootError(title, detail, retry = true) {
    const loader = $('loader');
    if (!loader) return;
    loader.style.opacity = '1';
    loader.style.display = 'flex';
    loader.innerHTML =
        '<div class="bootErr">' +
        '<h1>NUKETOWN</h1>' +
        '<h2>' + title + '</h2>' +
        '<p>' + detail + '</p>' +
        (retry ? '<button class="menuBtn primary" id="btnRetry">Reload</button>' : '') +
        '</div>';
    const btn = $('btnRetry');
    if (btn) btn.onclick = () => location.reload();
}

// ── boot ────────────────────────────────────────────────────────────────────
async function boot() {
    if (!webglSupported()) {
        showBootError(
            'WebGL is unavailable',
            'This browser or device cannot render 3D. Try Chrome, Edge or Firefox on a ' +
            'laptop or desktop, and make sure hardware acceleration is enabled in the browser settings.'
        );
        return;
    }

    // The GLB models are the one part of startup that waits on the network, so
    // they are requested HERE, before the steps below start spending 200-400 ms
    // of pure CPU on the map, the shadow setup and the environment probe. The
    // two asset layers memoise their promises, so the await further down simply
    // picks up the download that is already in flight.
    const modelsInFlight = loadCharacters();

    const steps = [
        ['Compiling renderer', setupRenderer],
        ['Generating surfaces', () => { /* materials build lazily on first use */ }],
        ['Constructing Nuketown', setupWorld],
        ['Lighting the test site', setupLighting],
        // Assets must land before the player rig is built: the viewmodel picks
        // its meshes at construction, and bots pick theirs at spawn.
        ['Deploying operators', () => modelsInFlight],
        ['Assembling weapons', setupPlayerRig],
        ['Calibrating optics', setupPost],
        ['Ready', finishBoot]
    ];
    for (let i = 0; i < steps.length; i++) {
        $('loadMsg').textContent = steps[i][0];
        $('loadBar').style.width = ((i / steps.length) * 100).toFixed(0) + '%';
        // setTimeout, not rAF: the loader must still advance in a tab that is
        // not compositing frames.
        await new Promise(r => setTimeout(r, 24));
        try {
            const maybe = steps[i][1]();
            if (maybe && typeof maybe.then === 'function') await maybe;
        } catch (err) {
            $('loadMsg').textContent = 'Failed: ' + steps[i][0];
            console.error('[boot]', steps[i][0], err);
            throw err;
        }
    }
    $('loadBar').style.width = '100%';
}

/**
 * Pull in the skinned GLB soldiers before the first match so bots are built
 * with them. This resolves either way — if the assets are absent, ai.js falls
 * back to the procedural rig and the game plays identically.
 */
async function loadCharacters() {
    // Both resolve either way; a missing asset falls back to the procedural
    // model rather than failing the boot.
    await Promise.all([
        characterAssets.load('assets/models/'),
        vmAssets.load('assets/models/')
    ]);
}

/**
 * Compile everything the scene is going to ask for, off the render path.
 *
 * The single most common "the game froze for a second then carried on" in a
 * three.js game is shader compilation: a program is built the first frame a
 * material is on screen, and a post-processing chain has a dozen of them. With
 * KHR_parallel_shader_compile (Chrome, Edge, Firefox, Safari 17+) the driver
 * builds them in worker threads while the loading bar is still up; where the
 * extension is missing three falls back to a synchronous compile, which is just
 * the same work done in one go. Either way this never blocks a frame in play.
 */
function warmShaders() {
    if (!renderer || !scene || !camera) return;
    try {
        const p = renderer.compileAsync
            ? renderer.compileAsync(scene, camera)
            : Promise.resolve(renderer.compile(scene, camera));
        if (p && p.catch) p.catch(() => { /* warming is a nicety, never a dependency */ });
    } catch { /* older renderer without compile(): shaders build lazily */ }
}

/**
 * requestPointerLock returns a promise in current browsers and rejects if the
 * document is not eligible (embedded frame, too soon after an Escape exit).
 * Unhandled, every respawn threw an uncaught rejection into the console.
 */
function grabPointer() {
    const r = canvas.requestPointerLock();
    if (r && typeof r.catch === 'function') r.catch(() => { /* user can click to re-lock */ });
}

function setupRenderer() {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(curDpr);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.92;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // frameStats above: the counters are cleared once per frame by hand.
    renderer.info.autoReset = false;

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xcfc4ac, 110, 360);

    camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.06, 700);
    scene.add(camera);
}

function setupWorld() {
    cw = new CollisionWorld();
    const built = buildNuketown(scene, cw);
    sky = built.sky;
    dust = built.dust;
    // Batch the map before anything dynamic joins the scene. Collision lives in
    // separate AABBs, so this is purely a rendering optimisation.
    const pruned = pruneShadowCasters(scene);
    const stats = mergeStaticScene(scene);
    console.info(`[map] batched ${stats.before} meshes into ${stats.after} draw calls, ` +
                 `dropped ${pruned} small shadow casters`);
    effects = new Effects(scene);
}

function setupLighting() {
    // Afternoon desert sun, matching the sky shader's sun vector.
    sun = new THREE.DirectionalLight(0xfff0d6, 2.35);
    sun.position.set(-52, 68, 34);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 170;
    // Tight box that follows the player — keeps texel density high without a
    // cascaded setup.
    sun.shadow.camera.left = -34;
    sun.shadow.camera.right = 34;
    sun.shadow.camera.top = 34;
    sun.shadow.camera.bottom = -34;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.028;
    scene.add(sun);
    scene.add(sun.target);

    scene.add(new THREE.HemisphereLight(0x9dbde0, 0xbda482, 0.42));
    scene.add(new THREE.AmbientLight(0xffe9cf, 0.10));

    // Image-based lighting straight from the sky shader — this is what makes
    // metal, glass and skin read as real rather than plastic.
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const skyScene = new THREE.Scene();
    const probe = sky.clone();
    probe.material = sky.material;
    skyScene.add(probe);
    const env = pmrem.fromScene(skyScene, 0.04, 1, 900);
    scene.environment = env.texture;
    // The sky is very bright; full-strength IBL turns dark ground surfaces blue.
    scene.environmentIntensity = 0.55;
    pmrem.dispose();
    skyScene.remove(probe);
}

function setupPlayerRig() {
    vm = new ViewModel(TEAM_A);
    vm.setEnvironment(scene.environment);
    hud = new HUD();
    // A placeholder so anything constructed below has a mode to read; the real
    // one is built per match in startMatch() from the chosen playlist.
    gamemode = createMode(selectedMode, {
        player, getBots: () => bots, hud, effects, scene, audio: A
    });

    streaks = new Killstreaks({
        scene, effects, hud,
        getBots: () => bots,
        get player() { return player; },
        // A getter, not the object: startMatch builds a fresh mode each match,
        // so a captured reference would go stale after the first one.
        getMode: () => gamemode,
        gamemode,
        onStreakKill: (bot, label) => registerKill(bot, label, false, true),
        onNukeComplete: () => { gamemode.nukeWin(TEAM_A); endMatch(); },
        shake: (amt) => player && player.addShake(amt)
    });

    player = new Player(camera, cw, vm, {
        effects, hud,
        getBots: () => bots,
        onHit: onPlayerHit,
        onPlayerDeath: onPlayerDeath,
        useStreak: id => tryStreak(id)
    });

    hud.onStreakClick(tryStreak);
}

function setupPost() {
    composerFX = createPostFX(renderer, scene, camera, vm);
    warmShaders();
    loadSettings();
    applyQuality();
    if (player) {
        player.sensitivity = 0.0016 * settings.sens;
        player.baseFov = settings.fov;
        camera.fov = settings.fov;
        camera.updateProjectionMatrix();
    }
}

function finishBoot() {
    bindUI();
    state = 'menu';
    $('loader').style.opacity = '0';
    setTimeout(() => $('loader').style.display = 'none', 500);

    // Photo textures swap in behind the menu, one per frame. Deliberately not
    // awaited: the procedural surfaces are already on screen and correct, so
    // this only ever makes things look better, never delays getting in.
    upgradeTextures('assets/textures/').catch(() => { /* procedural stays */ });
    window.__nuketown = {
        get state() { return state; },
        get scene() { return scene; },
        get renderer() { return renderer; },
        get player() { return player; },
        get bots() { return bots; },
        get cw() { return cw; },
        get streaks() { return streaks; },
        get gamemode() { return gamemode; },
        // Which of the optional GLB/photo layers actually landed. Handy in the
        // console, and this is what scripts/verify.mjs asserts on.
        get perf() { return frameStats; },
        get quality() { return QUALITY[settings.quality].name; },
        get assets() {
            return {
                soldiers: characterAssets.ready,
                soldiersFailed: characterAssets.failed,
                viewmodels: vmAssetsReady(),
                photos: photoStatus()
            };
        },
        step: (n = 1, ms = 16) => { for (let i = 0; i < n; i++) loop(last + ms); },
        setState: s => { state = s; },
        startMatch, THREE
    };
    // Repeat visits skip the download entirely: the shell caches the models,
    // textures and fonts once they have been fetched. Skipped on http (the
    // local PLAY.bat flow) so a dev folder never gets stuck on a stale cache.
    const secure = location.protocol === 'https:' ||
        location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if ('serviceWorker' in navigator && secure) {
        navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => { /* optional */ });
    }

    // Pointer lock needs a mouse. Say so up front on a phone rather than
    // letting someone click "Deploy" and find a frozen crosshair.
    if (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) {
        const foot = $('menuFoot');
        if (foot) foot.innerHTML = 'NUKETOWN needs a keyboard and mouse &nbsp;•&nbsp; open this link on a laptop or desktop';
        $('menuPick').style.display = 'none';
    }

    requestAnimationFrame(loop);
}

// ── UI wiring ───────────────────────────────────────────────────────────────
function bindUI() {
    $('btnStart').onclick = () => { A.unlockAudio(); startMatch(); };
    $('btnControls').onclick = () => $('panel').style.display = 'flex';
    $('btnPanelClose').onclick = () => $('panel').style.display = 'none';
    $('btnMute').onclick = () => {
        const m = A.toggleMute();
        $('btnMute').textContent = 'Sound: ' + (m ? 'Off' : 'On');
    };
    $('btnHudMute').onclick = e => {
        e.stopPropagation();
        const m = A.toggleMute();
        $('btnHudMute').classList.toggle('off', m);
        $('btnHudMute').innerHTML = m ? '&#128264;' : '&#128266;';
    };
    $('btnHudPause').onclick = e => { e.stopPropagation(); pause(true); };
    $('btnResume').onclick = () => pause(false);
    $('btnPauseControls').onclick = () => $('panel').style.display = 'flex';
    $('btnQuit').onclick = () => toMenu();
    $('btnAgain').onclick = () => { hud.hideEnd(); startMatch(); };
    $('btnMenu').onclick = () => { hud.hideEnd(); toMenu(); };

    const sens = $('sensRange'), sensOut = $('sensOut');
    sens.value = Math.round(settings.sens * 100);
    sensOut.textContent = settings.sens.toFixed(2);
    sens.oninput = () => {
        settings.sens = sens.value / 100;
        sensOut.textContent = settings.sens.toFixed(2);
        player.sensitivity = 0.0016 * settings.sens;
        saveSettings();
    };

    const fov = $('fovRange'), fovOut = $('fovOut');
    fov.value = settings.fov;
    fovOut.textContent = settings.fov;
    fov.oninput = () => {
        settings.fov = +fov.value;
        fovOut.textContent = settings.fov;
        player.baseFov = settings.fov;
        saveSettings();
    };

    const qual = $('qualitySel');
    qual.value = String(settings.quality);
    qual.onchange = () => {
        settings.quality = +qual.value;
        // A hand-picked preset stops the auto-tuner overriding the choice.
        autoQualityLocked = true;
        applyQuality();
        saveSettings();
    };

    canvas.addEventListener('click', () => {
        if (state === 'playing' && !document.pointerLockElement) grabPointer();
    });
    document.addEventListener('pointerlockchange', () => {
        const locked = document.pointerLockElement === canvas;
        if (player) player.locked = locked;
        document.body.classList.toggle('playing', locked);
        if (!locked && state === 'playing' && player.alive) pause(true);
    });
    window.addEventListener('keydown', e => {
        if (e.code === 'Escape') {
            if ($('panel').style.display === 'flex') { $('panel').style.display = 'none'; return; }
            if (state === 'playing') pause(true);
            else if (state === 'paused') pause(false);
        }
        if (e.code === 'Tab' && state === 'playing') { e.preventDefault(); boardOpen = true; }
        if (e.code === 'KeyF') $('perfHud').classList.toggle('hidden');
        // spectator: space or A/D also cycle, for anyone who does not want to click
        if (specTarget && (e.code === 'Space' || e.code === 'KeyD')) cycleSpectate(1);
        else if (specTarget && e.code === 'KeyA') cycleSpectate(-1);
    });

    // Click while spectating moves to the next surviving teammate. Bound on the
    // canvas so it does not fire when the skip button itself is clicked.
    canvas.addEventListener('mousedown', e => {
        if (state !== 'playing' || player.alive || !specTarget) return;
        cycleSpectate(e.button === 2 ? -1 : 1);
    });

    $('skipRound').addEventListener('click', () => {
        if (gamemode.skipRound && gamemode.skipRound()) {
            hud.banner('ROUND SKIPPED', '#FFC24A', 'Next round starting');
            endSpectate();
        }
    });
    window.addEventListener('keyup', e => { if (e.code === 'Tab') boardOpen = false; });

    window.addEventListener('resize', onResize);
}

function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(curDpr);
    renderer.setSize(w, h);
    composerFX.setSize(w * curDpr, h * curDpr);
    vm.resize(w / h);
}

/**
 * Hold 60 fps by scaling render resolution rather than dropping frames.
 * Reacts down quickly (1 s) and back up slowly (3 s) so it settles instead of
 * oscillating around the threshold.
 */
function adaptResolution(dt) {
    frameAvg += (dt * 1000 - frameAvg) * 0.06;
    dprCooldown -= dt;
    if (dprCooldown > 0) return;

    // Resolution is the first lever.
    let next = curDpr;
    if (frameAvg > 17.5 && curDpr > DPR_FLOOR) { next = Math.max(DPR_FLOOR, curDpr - 0.12); dprCooldown = 1.0; }
    else if (frameAvg < 12.5 && curDpr < maxDpr) { next = Math.min(maxDpr, curDpr + 0.10); dprCooldown = 3.0; }
    if (next !== curDpr) {
        curDpr = next;
        frameAvg = 15;
        onResize();
        return;
    }

    // Already at the floor and still missing the budget: resolution alone
    // cannot save this machine, so step the whole preset down. Shadow map size
    // and post effects only change with the preset, and on a weak GPU those are
    // what is actually costing the frame.
    if (curDpr <= DPR_FLOOR + 1e-6 && frameAvg > 19 && settings.quality > 0) {
        settings.quality--;
        applyQuality();
        saveSettings();
        hud.banner(`Quality lowered to ${QUALITY[settings.quality].name}`, '#FFC24A', 'holding frame rate');
        frameAvg = 15;
        dprCooldown = 6.0;
        qualityHeadroom = 0;
        return;
    }

    // The opposite case: running comfortably at full resolution with room to
    // spare. Step the preset back up so a capable machine is not left on Low
    // forever. Needs a sustained stretch of easy frames, and a long cooldown,
    // so this cannot ping-pong against the rule above.
    if (!autoQualityLocked && curDpr >= maxDpr - 1e-6 && frameAvg < 11 && settings.quality < QUALITY.length - 1) {
        qualityHeadroom += dprCooldownStep;
        if (qualityHeadroom > 8) {
            settings.quality++;
            applyQuality();
            saveSettings();
            hud.banner(`Quality raised to ${QUALITY[settings.quality].name}`, '#7FD97F', 'plenty of headroom');
            qualityHeadroom = 0;
            dprCooldown = 10.0;
        }
    } else {
        qualityHeadroom = 0;
    }
}

function applyQuality() {
    const q = QUALITY[settings.quality] || QUALITY[1];
    sun.shadow.mapSize.set(q.shadow, q.shadow);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = true;

    // Shadow filter cost varies enormously: PCFSoft takes many taps per pixel,
    // Basic takes one. This is one of the largest single levers available.
    if (renderer.shadowMap.type !== q.shadowType) {
        renderer.shadowMap.type = q.shadowType;
        scene.traverse(o => { if (o.isMesh && o.material) o.material.needsUpdate = true; });
    }

    // Interior fill lights are point lights, and every point light is evaluated
    // per pixel by every lit material on screen — indoors and out. Below High
    // the rooms lean on the sun, sky and environment map instead.
    let lightsChanged = false;
    scene.traverse(o => {
        if (!o.isLight) return;
        let want = o.visible;
        if (o.userData.interiorFill) want = q.interiorLights;
        else if (o.userData.fxLight) want = settings.quality > 0;
        if (o.visible !== want) { o.visible = want; lightsChanged = true; }
    });
    if (lightsChanged) scene.traverse(o => { if (o.isMesh && o.material) o.material.needsUpdate = true; });

    // Character shadows mean re-skinning every soldier a second time.
    charShadowsEnabled = q.charShadows;

    // keep the dropdown honest when the auto-tuner moves the preset
    const sel = $('qualitySel');
    if (sel && sel.value !== String(settings.quality)) sel.value = String(settings.quality);

    maxDpr = Math.min(q.dprCap, Math.max(1, DEVICE_DPR));
    // Jump straight to the new ceiling so picking a higher preset looks better
    // immediately; the adaptive scaler pulls it back within a second if the
    // frame budget cannot take it.
    curDpr = maxDpr;
    frameAvg = 15;
    dprCooldown = 1.5;
    composerFX.setQuality(q.post);
    onResize();
}

// ── match flow ──────────────────────────────────────────────────────────────
function startMatch() {
    $('menu').style.display = 'none';
    $('panel').style.display = 'none';
    hud.hideEnd(); hud.hideDeath();
    $('pause').classList.remove('on');
    hud.show(true);

    // Build the ruleset for the chosen playlist. Everything below asks the mode
    // how many soldiers to field and whether respawning is allowed, instead of
    // assuming Team Deathmatch.
    gamemode = createMode(selectedMode, {
        player, getBots: () => bots, hud, effects, scene, audio: A
    });
    gamemode.reset();
    streaks.reset();
    effects.clearHoles();

    for (const b of bots) b.dispose();
    bots = [];

    const nA = gamemode.botsA, nB = gamemode.botsB;
    const namesA = shuffle(BOT_NAMES_A).slice(0, nA);
    const namesB = shuffle(BOT_NAMES_B).slice(0, nB);
    for (let i = 0; i < nA; i++) {
        const b = new Bot(namesA[i], TEAM_A, scene, 0.34 + Math.random() * 0.3);
        b.spawn(); bots.push(b);
    }
    for (let i = 0; i < nB; i++) {
        const b = new Bot(namesB[i], TEAM_B, scene, 0.34 + Math.random() * 0.34);
        b.spawn(); bots.push(b);
    }

    // Bots bring their own materials with them. Nobody is moving during the
    // opening freeze, so this is the cheap moment to have them compiled.
    warmShaders();

    player.resetMatch();
    player.respawn(randElement(SPAWN_A));
    player.sensitivity = 0.0016 * settings.sens;
    player.baseFov = settings.fov;
    player.paused = false;
    respawnTimer = 0;
    deadInfo = null;

    state = 'playing';
    grabPointer();
    A.playAmbient();
    A.playMatchStart();
    hud.banner('TEAM DEATHMATCH', '#FF7A18', 'Nuketown — First to 75');
}

function toMenu() {
    state = 'menu';
    hud.show(false);
    hud.hideDeath();
    hud.hideEnd();
    $('pause').classList.remove('on');
    $('menu').style.display = 'flex';
    document.exitPointerLock();
    player.paused = true;
}

function pause(on) {
    if (state !== 'playing' && state !== 'paused') return;
    state = on ? 'paused' : 'playing';
    player.paused = on;
    $('pause').classList.toggle('on', on);
    if (on) document.exitPointerLock();
    else grabPointer();
}

function endMatch() {
    if (state === 'ended') return;
    state = 'ended';
    player.paused = true;
    document.exitPointerLock();
    hud.hideDeath();
    const won = gamemode.winner === TEAM_A;
    hud.showEnd(won, player);
    (won ? A.playVictory : A.playDefeat)();
}

// ── combat callbacks ────────────────────────────────────────────────────────
function onPlayerHit(bot, killed, head, def) {
    hud.hitmarker(killed, head);
    if (killed) {
        A.playKillConfirm();
        registerKill(bot, def.short, head, false);
    } else {
        head ? A.playHeadshot() : A.playHitmarker();
    }
}

function registerKill(bot, weaponLabel, head, fromStreak) {
    player.kills++;
    player.matchKills++;
    player.killStreak++;
    player.score += head ? 150 : 100;
    gamemode.addKill(TEAM_A);
    hud.killfeed('You', bot.name, weaponLabel, true, head);

    if (head) hud.banner('HEADSHOT', '#FFC24A', `+150  ${bot.name}`);
    else if (!fromStreak && player.killStreak > 1) {
        if (player.killStreak === 3) hud.banner('KILLSTREAK ×3', '#fff', 'On a roll');
        else if (player.killStreak === 5) hud.banner('KILLSTREAK ×5', '#FF9A3C', 'Dominating');
        else if (player.killStreak >= 8) hud.banner(`KILLSTREAK ×${player.killStreak}`, '#FF7A18', 'Unstoppable');
    }

    // announce newly available rewards
    for (const s of ['uav', 'air', 'nuke']) {
        const p = streaks.progress(s);
        if (p.ready && !streaks.announced?.[s]) {
            streaks.announced = streaks.announced || {};
            streaks.announced[s] = true;
            const meta = { uav: ['UAV READY', '#67c6ff', 'Press Z'], air: ['AIRSTRIKE READY', '#ffb02e', 'Press X'], nuke: ['☢ TACTICAL NUKE READY ☢', '#FF3B15', 'Press V to end this'] }[s];
            hud.banner(meta[0], meta[1], meta[2]);
        }
    }
}

function onPlayerDeath(killerName) {
    A.playDeath();
    streaks.onPlayerDeath();
    streaks.announced = {};
    respawnTimer = RESPAWN_TIME;
    deadInfo = { by: killerName || '—' };
    hud.showDeath(deadInfo.by, deadInfo.weapon || '');
    hud.respawnCountdown(respawnTimer, RESPAWN_TIME);
    // Pointer lock stays: the death camera should keep pointing where the fall
    // put it, and releasing the mouse here would pop the cursor over the screen.
}

function tryStreak(id) {
    if (state !== 'playing' || !player.alive) return;
    if (!streaks.canUse(id)) {
        const p = streaks.progress(id);
        if (!streaks.used[id]) hud.banner('NOT READY', 'rgba(255,255,255,.6)', `${p.have}/${p.need} kills`);
        return;
    }
    streaks.use(id);
}

// ── bot event handling ──────────────────────────────────────────────────────
function handleBotEvents(bot, events) {
    for (const e of events) {
        if (e.type === 'shot') {
            const d = e.position.distanceTo(camera.position);
            if (d < 4) A.playGunshot(bot.weapon.audioType);
            else A.playGunshotDistant(bot.weapon.audioType, d);
            if (d < 30) effects.gunFlash(e.position);
            if (bot.team !== TEAM_A) hud.noteEnemyFire(bot);
        } else if (e.type === 'miss') {
            effects.tracer(e.from, e.to, 300);
            if (e.normal) effects.impact(e.to, e.normal, 'default');
        } else if (e.type === 'hit') {
            effects.tracer(e.from, e.to, 300);
            const tgt = e.target;
            if (tgt === playerProxy) {
                // No world blood here — the hit point is the player's own chest,
                // which would paint a red billboard across the camera.
                player.takeDamage(e.damage, bot.name, e.from);
                if (!player.alive) {
                    gamemode.addKill(TEAM_B);
                    gamemode.onKill(bot, playerProxy, bot.weapon, e.head);
                    bot.kills++; bot.killStreak++; bot.score += 100;
                    hud.killfeed(bot.name, 'You', bot.weapon.short, false, e.head);
                    deadInfo = { by: bot.name, weapon: bot.weapon.name };
                    hud.showDeath(bot.name, bot.weapon.name);
                }
            } else if (tgt && tgt.takeDamage) {
                effects.blood(e.to, _v.set(0, 0, 0));
                const killed = tgt.takeDamage(e.damage, bot.name);
                if (killed) {
                    gamemode.addKill(bot.team);
                    gamemode.onKill(bot, tgt, bot.weapon, e.head);
                    gamemode.onBotDeath(tgt);
                    bot.kills++; bot.killStreak++; bot.score += 100;
                    hud.killfeed(bot.name, tgt.name, bot.weapon.short, false, e.head);
                }
            }
        }
    }
}

// ── spectator (round modes) ─────────────────────────────────────────────────
// While dead in a one-life round you ride a surviving teammate's eyes. Click to
// move to the next one. The camera sits on their eye line and takes their look
// direction directly, so it reads as their first person view rather than a
// floating chase cam.
let specTarget = null;

function livingTeammates() {
    return bots.filter(b => b.team === player.team && b.alive);
}

function cycleSpectate(dir = 1) {
    const mates = livingTeammates();
    if (!mates.length) { specTarget = null; return; }
    const i = mates.indexOf(specTarget);
    specTarget = mates[(((i < 0 ? 0 : i + dir) % mates.length) + mates.length) % mates.length];
}

function updateSpectator() {
    const mates = livingTeammates();
    if (!mates.length) {
        specTarget = null;
        hud.spectate(null);
        return;
    }
    // whoever we were watching may have just died
    if (!specTarget || !specTarget.alive) cycleSpectate(0);
    const t = specTarget;
    if (!t) return;

    camera.position.set(t.position.x, t.position.y + (t.isCrouching ? 1.05 : 1.55), t.position.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.y = t.yaw;
    camera.rotation.x = t.aimPitch || 0;
    camera.rotation.z = 0;
    if (camera.fov !== player.baseFov) {
        camera.fov = player.baseFov;
        camera.updateProjectionMatrix();
    }
    hud.spectate(t.name, mates.length);
}

function endSpectate() {
    specTarget = null;
    hud.spectate(null);
}

// A lightweight stand-in so bots can treat the player like any other entity.
const playerProxy = {
    position: new THREE.Vector3(), alive: true, team: TEAM_A, isCrouching: false,
    name: 'You', spawnProtect: 0,
    takeDamage() { return false; }
};

// ── loop ────────────────────────────────────────────────────────────────────
function loop(ts) {
    requestAnimationFrame(loop);
    const _info = renderer.info.render;
    frameStats.calls = _info.calls;
    frameStats.triangles = _info.triangles;
    renderer.info.reset();
    const dt = Math.min((ts - last) / 1000, 0.05) || 0;
    last = ts;
    elapsed += dt;

    if (sky && sky.material.uniforms) sky.material.uniforms.time.value = elapsed;

    if (state === 'menu' || state === 'loading') {
        // slow cinematic orbit over the map
        const t = elapsed * 0.09;
        camera.position.set(Math.cos(t) * 46, 17 + Math.sin(t * 0.7) * 5, Math.sin(t) * 40);
        camera.lookAt(Math.sin(t * 0.5) * 6, 4.5, Math.cos(t * 0.5) * 4);
        camera.fov = 62; camera.updateProjectionMatrix();
        if (composerFX) {
            composerFX.vmPass.enabled = false;
            composerFX.grade.uniforms.time.value = elapsed;
            composerFX.composer.render();
        }
        return;
    }

    if (state === 'paused') { composerFX.composer.render(); return; }

    if (state === 'ended') {
        effects.update(dt, camera);
        composerFX.grade.uniforms.time.value = elapsed;
        composerFX.composer.render();
        return;
    }

    // ── playing ──
    // the viewmodel is not drawn once the death camera takes over
    composerFX.vmPass.enabled = player.alive;
    adaptResolution(dt);

    // Shadows only need refreshing every other frame; at 60 fps the lag is
    // invisible and it halves the cost of the most expensive pass.
    const q = QUALITY[settings.quality] || QUALITY[1];
    shadowTick = (shadowTick + 1) % q.shadowEvery;
    sun.shadow.needsUpdate = (shadowTick === 0);

    const nowSec = ts / 1000;

    gamemode.update(dt);
    streaks.update(dt);

    // During a round's frozen setup nobody may move or shoot.
    const frozen = gamemode.isFrozen && gamemode.isFrozen();
    player.paused = frozen;

    if (player.alive) {
        if (specTarget) endSpectate();
        player.update(dt, nowSec);
        if (!frozen) player.tryFire(nowSec);
    } else if (!gamemode.canRespawn(player)) {
        // Round modes own the respawn cycle: the player stays down until the
        // round flips. Rather than stare at the sky, ride a surviving
        // teammate's eyes until then.
        player.update(dt, nowSec);
        updateSpectator(dt);
    } else {
        player.update(dt, nowSec);
        respawnTimer -= dt;
        hud.respawnCountdown(respawnTimer, RESPAWN_TIME);
        if (respawnTimer <= 0) {
            player.respawn(pickSafeSpawn());
            hud.hideDeath();
            endSpectate();
            grabPointer();
        }
    }

    // keep the bot-facing view of the player current
    playerProxy.position.copy(player.position);
    playerProxy.alive = player.alive;
    playerProxy.isCrouching = player.isCrouching;
    playerProxy.spawnProtect = player.spawnProtect;

    const entities = [playerProxy, ...bots];
    for (const bot of bots) {
        bot.respawnBlocked = !gamemode.canRespawn(bot);
        bot.frozen = frozen;
        const ev = bot.update(dt, ts, entities, cw, charShadowsEnabled ? camera.position : null);
        if (!charShadowsEnabled && bot.rig.setShadows) bot.rig.setShadows(false);
        if (ev && ev.length) handleBotEvents(bot, ev);
    }

    effects.update(dt, camera);

    // sun shadow box follows the player so shadows stay crisp
    sun.position.set(player.position.x - 52, 68, player.position.z + 34);
    sun.target.position.set(player.position.x, 0, player.position.z);
    sun.target.updateMatrixWorld();

    // drifting dust
    if (dust) {
        dust.position.x = player.position.x;
        dust.position.z = player.position.z;
        dust.rotation.y = elapsed * 0.008;
    }

    // HUD
    hud.update(dt, {
        player, bots,
        teamA: gamemode.teamAScore, teamB: gamemode.teamBScore,
        timeLeft: gamemode.timeRemaining,
        uav: streaks.uavOnline,
        killstreaks: streaks,
        scopeAmount: vm.scopeAmount
    });
    hud.scope(vm.scopeAmount || 0);
    hud.scoreboard(boardOpen, player, bots, gamemode.teamAScore, gamemode.teamBScore);

    // grade uniforms
    const g = composerFX.grade.uniforms;
    g.time.value = elapsed;
    g.damage.value = clamp((1 - player.health / 100) * 0.5, 0, 0.5) * (player.alive ? 1 : 0);
    g.death.value = player.deathProgress * 0.82;
    g.whiteout.value = streaks.nukeFired
        ? clamp(1 - (streaks.nukeT - 5.0) / 2.2, 0, 1) : 0;
    composerFX.bloom.strength = 0.34 + (streaks.nukeFired ? 1.4 : 0) * g.whiteout.value;

    // live fps readout — settings panel and the on-screen perf strip
    fpsAccum += dt; fpsFrames++;
    if (fpsAccum >= 0.5) {
        const fps = Math.round(fpsFrames / fpsAccum);
        const el = $('fpsOut');
        if (el) el.textContent = fps + ' fps';
        const strip = $('perfHud');
        if (strip && !strip.classList.contains('hidden')) {
            const cls = fps >= 55 ? '' : fps >= 40 ? 'mid' : 'bad';
            strip.innerHTML = `<b class="${cls}">${fps} FPS</b> · ${frameStats.calls} draws · ` +
                `${(frameStats.triangles / 1000).toFixed(0)}k tris · ${(curDpr * 100).toFixed(0)}% res · ` +
                `${QUALITY[settings.quality].name}`;
        }
        fpsAccum = 0; fpsFrames = 0;
    }

    if (gamemode.matchOver) { endMatch(); return; }

    composerFX.composer.render();
}

/** Prefer a spawn no enemy is standing on top of. */
function pickSafeSpawn() {
    const list = SPAWN_A;
    let best = list[0], bestD = -1;
    for (const s of list) {
        let nearest = 1e9;
        for (const b of bots) {
            if (!b.alive || b.team === TEAM_A) continue;
            nearest = Math.min(nearest, Math.hypot(b.position.x - s.x, b.position.z - s.z));
        }
        if (nearest > bestD) { bestD = nearest; best = s; }
    }
    return best;
}

void MAP_BOUNDS; void SPAWN_B; void WEAPON_DEFS; void TEAM_B;

boot().catch(err => {
    console.error('[boot]', err);
    showBootError('The game could not start', String((err && err.message) || err));
});
