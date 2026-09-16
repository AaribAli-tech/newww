// ============================================================================
// tester.js — a bare room to try a character model in.
//
// Nothing here imports the game. It is the shortest possible loop that lets you
// judge a rig: move, sprint, crouch, jump, shoot, and watch the skeleton do it,
// in an empty world with a firing range to aim at. If a model looks wrong here it
// will look wrong in Nuketown, and fixing it here is much faster.
//
// The one model wired up by default is the "Modern Rebel Soldier" from
// github.com/AaribAli-tech/call-of-duty-asset-for-person, which arrives as a
// binary FBX with:
//   · a mixamorig:* skeleton, so bone names are the standard ones,
//   · no animation clips at all (the file has no AnimationStack), so every pose
//     below is produced procedurally from the walk phase, and
//   · texture paths pointing at the author's own C:\ drive, so the three PNGs are
//     rebound here by material name (Body_Material / Head_Material /
//     BootAndSkin_Material) instead of trusting the file.
//
// Build it with:  node scripts/build-tester.mjs      →  public/tester/
// ============================================================================
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

// Asset paths are root-relative: the page is reachable as /tester/ or /tester,
// and a bare relative path would resolve differently depending on the redirect.
// Named as the FBX calls them: three's loader fires at the texture paths baked
// into the file (BodyTexture.png and friends), so serving the same names under
// /tester/assets/ keeps those requests quiet instead of three 404s per load.
const ASSET = {
    model: '/tester/assets/rebel.fbx', body: '/tester/assets/BodyTexture.png',
    head: '/tester/assets/HeadTexture.png', boots: '/tester/assets/BootsAndSkinTexture.png'
};

// ── renderer / scene ─────────────────────────────────────────────────────────
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));   // this is a test page, not a demo reel
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1014);
scene.fog = new THREE.Fog(0x0d1014, 34, 150);

const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 400);

const hemi = new THREE.HemisphereLight(0x9fb6cc, 0x2a2620, 0.75);
const sun = new THREE.DirectionalLight(0xffe7c4, 1.55);
sun.position.set(14, 22, 9);
scene.add(hemi, sun);

// Floor: one big quad plus a grid, so scale and speed are readable.
const RANGE = 90;                       // half-extent of the walkable square
const floorMat = new THREE.MeshStandardMaterial({ color: 0x30363d, roughness: 0.95, metalness: 0.02 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(RANGE * 2, RANGE * 2), floorMat);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.GridHelper(RANGE * 2, 90, 0x59646f, 0x3b424a);
grid.material.transparent = true; grid.material.opacity = 0.35;
grid.position.y = 0.002;
scene.add(grid);

// A low wall so you can run into something and see the model brace for it.
const blockers = [];
const solids = [];                      // everything a bullet can hit that is not a target
function crate(x, z, w = 2, h = 1.2, d = 2, colour = 0x4a4238) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
        new THREE.MeshStandardMaterial({ color: colour, roughness: 0.8 }));
    m.position.set(x, h / 2, z);
    scene.add(m);
    blockers.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top: h });
    solids.push(m);
    return m;
}
for (const [x, z] of [[-8, -14], [-4, -14], [0, -14], [4, -14], [8, -14], [-16, 4], [16, -4]]) {
    crate(x, z, 2.4, 1.25 + (Math.abs(x) % 3) * 0.2, 2.4);
}
// Sight walls at the far end so impacts have something to mark.
crate(0, -34, 44, 3, 1, 0x3a4046);

// ── targets ──────────────────────────────────────────────────────────────────
// Deliberately crude: they exist so a shot has a yes/no answer.
const targets = [];
const torsoGeo = new THREE.BoxGeometry(0.55, 0.75, 0.32);
const headGeo = new THREE.SphereGeometry(0.14, 14, 12);
for (let i = 0; i < 7; i++) {
    const x = -15 + i * 5, z = -26 - (i % 3) * 3;
    const g = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xb8443a, roughness: 0.7 });
    const torso = new THREE.Mesh(torsoGeo, skin); torso.position.y = 1.05;
    const head = new THREE.Mesh(headGeo, skin.clone()); head.position.y = 1.56;
    torso.userData.part = 'body'; head.userData.part = 'head';
    g.add(torso, head);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 8),
        new THREE.MeshStandardMaterial({ color: 0x6f6a60, roughness: 0.6 }));
    post.position.y = 0.35; g.add(post);
    g.position.set(x, 0, z);
    g.userData.target = { hits: 0, alive: true, pop: 0, head: head, torso, mats: [torso.material, head.material], x, z };
    scene.add(g);
    targets.push(g);
}

// ── the player ───────────────────────────────────────────────────────────────
const P = {
    pos: new THREE.Vector3(0, 0, 8),
    vel: new THREE.Vector3(),
    yaw: 0,                         // yaw 0 looks down -Z, i.e. at the range
    pitch: 0,                         // level, so a shot from the chest reaches the range
    eye: 1.62, crouchEye: 1.02,
    height: 1.62,                   // live, lerps between stand and crouch
    onGround: true,
    crouch: 0,                      // 0..1
    walk: 3.1, run: 6.0,            // m/s
    step: 0,                        // accumulates distance, drives the leg cycle
    ammo: 30, mag: 30, reserve: 120,
    fireCd: 0, reload: 0,
    recoil: 0, kick: 0,
    hits: 0, shots: 0, headshots: 0, hitFlinch: 0
};
const GRAV = 22;

// blob shadow instead of a shadow map — a test page should not pay for one
const blob = new THREE.Mesh(new THREE.CircleGeometry(0.42, 22),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.34, depthWrite: false }));
blob.rotation.x = -Math.PI / 2; blob.position.y = 0.01;
scene.add(blob);

// ── FX pools ─────────────────────────────────────────────────────────────────
const tracerGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const tracers = [];
for (let i = 0; i < 18; i++) {
    const l = new THREE.Line(tracerGeo.clone(), new THREE.LineBasicMaterial({
        color: 0xffd27a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    l.frustumCulled = false; l.userData.life = 0; scene.add(l); tracers.push(l);
}
let tracerCursor = 0;
function tracer(a, b) {
    const l = tracers[tracerCursor = (tracerCursor + 1) % tracers.length];
    const pos = l.geometry.attributes.position;
    pos.setXYZ(0, a.x, a.y, a.z); pos.setXYZ(1, b.x, b.y, b.z);
    pos.needsUpdate = true; l.geometry.computeBoundingSphere();
    l.userData.life = 0.07; l.material.opacity = 0.95;
}
const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
const sparks = [];
for (let i = 0; i < 24; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), sparkMat.clone());
    m.visible = false; m.userData = { life: 0, v: new THREE.Vector3() }; scene.add(m); sparks.push(m);
}
let sparkCursor = 0;
function burst(at, n = 7) {
    for (let i = 0; i < n; i++) {
        const s = sparks[sparkCursor = (sparkCursor + 1) % sparks.length];
        s.visible = true; s.position.copy(at); s.material.opacity = 1; s.userData.life = 0.22 + Math.random() * 0.14;
        s.userData.v.set((Math.random() - 0.5) * 3.4, Math.random() * 3.0, (Math.random() - 0.5) * 3.4);
    }
}
const holes = [];
const holeGeo = new THREE.CircleGeometry(0.035, 10);
const holeMat = new THREE.MeshBasicMaterial({ color: 0x0a0c0e, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide });
function decal(point, normal) {
    const m = new THREE.Mesh(holeGeo, holeMat.clone());
    m.position.copy(point).addScaledVector(normal, 0.006);
    m.lookAt(point.clone().add(normal));
    m.userData.life = 14; scene.add(m); holes.push(m);
    if (holes.length > 90) { const old = holes.shift(); old.parent && old.parent.remove(old); }
}
const flash = new THREE.PointLight(0xffc070, 0, 6, 2);
scene.add(flash);
const flashSprite = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.36),
    new THREE.MeshBasicMaterial({ color: 0xffe6a8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
scene.add(flashSprite);

// ── audio: synthesised, so the page needs no files ───────────────────────────
let ac = null, noise = null;
function audio() {
    if (!ac) {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        const len = ac.sampleRate * 0.4 | 0;
        noise = ac.createBuffer(1, len, ac.sampleRate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
}
function gunshot(lvl = 1) {
    try {
        const a = audio(), t = a.currentTime;
        const src = a.createBufferSource(); src.buffer = noise;
        const lp = a.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1500 + 900 * lvl;
        const g = a.createGain(); g.gain.setValueAtTime(0.34 * lvl, t); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.16);
        src.connect(lp).connect(g).connect(a.destination); src.start(t); src.stop(t + 0.2);
        const o = a.createOscillator(); o.type = 'square'; o.frequency.setValueAtTime(160, t);
        o.frequency.exponentialRampToValueAtTime(48, t + 0.09);
        const g2 = a.createGain(); g2.gain.setValueAtTime(0.16 * lvl, t); g2.gain.exponentialRampToValueAtTime(0.0006, t + 0.1);
        o.connect(g2).connect(a.destination); o.start(t); o.stop(t + 0.11);
    } catch { /* audio is a nicety here */ }
}
function blip(freq = 620, dur = 0.05, gain = 0.1) {
    try {
        const a = audio(), t = a.currentTime;
        const o = a.createOscillator(); o.frequency.value = freq; o.type = 'triangle';
        const g = a.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
        o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch { }
}

// ── the model ────────────────────────────────────────────────────────────────
const modelRoot = new THREE.Group();          // yaw follows the player
scene.add(modelRoot);
const rig = {
    ready: false, group: null, bones: {}, meshCount: 0, tris: 0,
    rawHeight: 0, targetHeight: 1.80, scale: 1, footOffset: 0,
    clips: [], mixer: null, activeClip: -1, texMap: [], skinned: false, animMode: 'procedural'
};
// Longest first: "leftupleg" must not be claimed by the "LeftLeg" entry.
const BONE_KEYS = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
    'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
    'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
    'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
    'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];
const BONE_LONG_FIRST = [...BONE_KEYS].sort((a, b) => b.length - a.length);
const normBone = n => (n || '').toLowerCase()
    .replace(/^mixamorig[:_\s-]?/, '').replace(/\.[0-9]+$/, '').replace(/[:_\s-]/g, '');
const boneTargets = {};   // angle targets, lerped toward every frame
for (const k of BONE_KEYS) boneTargets[k] = { rx: 0, rz: 0, ry: 0 };

new FBXLoader().load(ASSET.model, (root) => {
    rig.group = root;
    modelRoot.add(root);              // the group below follows the player's yaw
    root.traverse(o => {
        // Bone names survive an FBX round trip badly: Blender appends ".001",
        // Unreal exports keep "mixamorig:", some exporters keep only the tail. So
        // normalise, then match the longest key the name ends with — and accept
        // any object, because a limb node is not always a THREE.Bone by the time
        // the loader is done with it.
        if (o.isBone || o.isObject3D) {
            const nm = normBone(o.name);
            for (const k of BONE_LONG_FIRST) {
                if (!rig.bones[k] && nm.endsWith(k.toLowerCase())) { rig.bones[k] = o; break; }
            }
        }
        if (o.isMesh || o.isSkinnedMesh) {
            rig.meshCount++; o.frustumCulled = false;
            if (o.isSkinnedMesh) rig.skinned = true;
            const list = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of list) {
                if (!m) continue;
                m.side = THREE.FrontSide;
                if (m.transparent && m.opacity >= 0.999) { m.transparent = false; }
            }
        }
        if (o.isMesh) rig.tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    });

    // measure, then stand the character on 1.80 m and on the floor
    const box = new THREE.Box3().setFromObject(root);
    rig.rawHeight = Math.max(0.001, box.max.y - box.min.y);
    applyScale();

    // the FBX texture paths are the author's local disk, so bind by material name
    const want = [[/boot|skin/i, ASSET.boots], [/head|face/i, ASSET.head], [/body|cloth|vest|gear/i, ASSET.body]];
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin('anonymous');
    const loaded = {};
    const jobs = [];
    root.traverse(o => {
        if (!(o.isMesh || o.isSkinnedMesh) || !o.material) return;
        const list = Array.isArray(o.material) ? o.material : [o.material];
        list.forEach((m, i) => {
            const key = `${o.name || 'mesh'}/${m.name || 'mat'}`;
            const hit = want.find(([re]) => re.test(m.name || '') || re.test(o.name || '')) || want[2];
            if (!loaded[hit[1]]) loaded[hit[1]] = new Promise(res => loader.load(hit[1], t => res(t), undefined, () => res(null)));
            jobs.push(loaded[hit[1]].then(tex => {
                if (!tex) { rig.texMap.push([key, 'MISSING ' + hit[1]]); return; }
                const t = tex.clone();
                t.colorSpace = THREE.SRGBColorSpace;
                t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
                t.wrapS = t.wrapT = THREE.RepeatWrapping;
                t.needsUpdate = true;
                m.map = t; m.color && m.color.setRGB(1, 1, 1); m.needsUpdate = true;
                rig.texMap.push([key, hit[1].replace('assets/', '')]);
                void i;
            }));
        });
    });
    Promise.all(jobs).then(() => { rig.texMap = rig.texMap.slice(); });

    if (root.animations && root.animations.length) {
        rig.clips = root.animations;
        rig.mixer = new THREE.AnimationMixer(root);
        rig.animMode = 'clips';
        playClip(0);
    }
    rig.allObjects = (() => { let n = 0; root.traverse(() => n++); return n; })();
    rig.missing = BONE_KEYS.filter(k => !rig.bones[k]);
    rig.ready = true;
    hud.note = `${rig.meshCount} meshes / ${rig.allObjects} objects · ${rig.skinned ? 'skinned' : 'no skinning'}` +
        ` · bones ${Object.keys(rig.bones).length}/${BONE_KEYS.length}` +
        `${rig.missing.length ? ' (missing ' + rig.missing.slice(0, 4).join(',') + ')' : ''}` +
        ` · ${rig.clips.length ? rig.clips.length + ' clips' : 'no clips → procedural'}`;
}, undefined, (err) => {
    hud.note = 'FBX failed to load: ' + ((err && (err.message || err.url)) || err);
    hud.error = true;
});

function playClip(i) {
    if (!rig.mixer || !rig.clips[i]) return;
    if (rig.action) rig.action.stop();
    rig.action = rig.mixer.clipAction(rig.clips[i]);
    rig.activeClip = i;
    rig.action.reset().play();
    rig.animMode = 'clips';
}

function applyScale() {
    if (!rig.group) return;
    rig.scale = rig.targetHeight / rig.rawHeight;
    rig.group.scale.setScalar(rig.scale);
    rig.group.position.y = 0;
    const box = new THREE.Box3().setFromObject(rig.group);
    rig.footOffset = -box.min.y;              // rest the shoes on the floor
    rig.group.position.y = rig.footOffset;
}

// ── procedural pose (what runs when the file has no clips) ───────────────────
function pose(dt) {
    const b = rig.bones;
    if (!b.Hips) return;
    const speed = Math.hypot(P.vel.x, P.vel.z);
    const moving = speed > 0.35 && P.onGround;
    const amp = Math.min(1, speed / P.run);
    const ph = P.step;

    const lunge = Math.sin(ph) * (0.35 + 0.75 * amp);
    const knee = (0.18 + 0.55 * amp) * (0.5 + 0.5 * Math.sin(ph));
    const arm = (0.16 + 0.45 * amp) * Math.sin(ph + Math.PI / 2);

    for (const k of BONE_KEYS) boneTargets[k].rx = boneTargets[k].rz = boneTargets[k].ry = 0;
    const t = boneTargets;
    t.LeftUpLeg.rx = lunge; t.RightUpLeg.rx = -lunge;
    t.LeftLeg.rx = -knee; t.RightLeg.rx = -knee;
    t.LeftFoot.rx = knee * 0.4; t.RightFoot.rx = knee * 0.4;
    t.LeftToeBase.rx = knee * 0.25; t.RightToeBase.rx = knee * 0.25;
    t.LeftArm.rx = arm - 0.18; t.RightArm.rx = -arm - 0.18;
    t.LeftForeArm.rx = -0.32 - 0.14 * amp; t.RightForeArm.rx = -0.32 - 0.14 * amp;

    // aim: hands come up and forward, the torso takes the yaw lead
    t.RightArm.rx = -1.32; t.RightForeArm.rx = -0.28;
    t.LeftArm.rx = -1.16; t.LeftForeArm.rx = -0.66;
    t.LeftShoulder.ry = 0.12; t.RightShoulder.ry = -0.12;

    if (P.crouch > 0.02) {
        const c = P.crouch;
        t.Spine.rx = 0.20 * c; t.Spine1.rx = 0.10 * c;
        t.Hips.rx = -0.16 * c;
        t.LeftUpLeg.rx += 0.55 * c; t.RightUpLeg.rx += 0.55 * c;
        t.LeftLeg.rx -= 1.15 * c; t.RightLeg.rx -= 1.15 * c;
        t.LeftFoot.rx += 0.55 * c; t.RightFoot.rx += 0.55 * c;
    }
    if (!P.onGround) {   // tuck a little in the air
        t.LeftUpLeg.rx += 0.32; t.RightUpLeg.rx += 0.22;
        t.LeftLeg.rx -= 0.5; t.RightLeg.rx -= 0.35;
    }
    // recoil rides the spine so the gun "kicks" without needing an animation
    const r = P.recoil;
    t.Spine.rx -= 0.30 * r; t.Spine1.rx -= 0.16 * r; t.Neck.rx -= 0.10 * r;
    t.RightForeArm.rx -= 0.5 * r; t.LeftForeArm.rx -= 0.35 * r;
    if (P.hitFlinch > 0) t.Spine2.rx = 0.35 * P.hitFlinch;

    const k = 1 - Math.exp(-dt * 14);
    for (const key of BONE_KEYS) {
        const bone = b[key]; if (!bone) continue;
        const tg = boneTargets[key];
        bone.rotation.x += (tg.rx - bone.rotation.x) * k;
        bone.rotation.y += (tg.ry - bone.rotation.y) * k;
        bone.rotation.z += (tg.rz - bone.rotation.z) * k;
    }
    // hips ride the step so the whole body has weight
    const bob = (moving ? Math.abs(Math.sin(ph)) * 0.045 * (0.4 + amp) : Math.sin(performance.now() * 0.0011) * 0.008)
        - P.crouch * 0.30;
    b.Hips.position.y = (b.Hips.userData.baseY ?? (b.Hips.userData.baseY = b.Hips.position.y)) + bob;
}

// ── camera ───────────────────────────────────────────────────────────────────
let camMode = 0;                     // 0 follow · 1 first person · 2 inspect orbit
const camDist = { v: 4.3 };
const _cv = new THREE.Vector3();
const _aim = new THREE.Vector3();
/** Unit vector the character is pointing: the game's yaw convention, lifted by pitch. */
function aimDir(out) {
    const cp = Math.cos(P.pitch);
    return out.set(-Math.sin(P.yaw) * cp, Math.sin(P.pitch), -Math.cos(P.yaw) * cp).normalize();
}
function putCamera(dt) {
    const head = _cv.set(P.pos.x, P.pos.y + P.height * 0.92, P.pos.z);
    const a = aimDir(_aim);
    if (camMode === 1) {
        camera.position.copy(head).add(new THREE.Vector3(0, 0.06, 0));
        camera.lookAt(head.x + a.x * 40, head.y + a.y * 40, head.z + a.z * 40);
    } else if (camMode === 2) {
        const t = performance.now() * 0.00022;
        camera.position.set(P.pos.x + Math.sin(t) * 3.6, P.pos.y + 1.5 + Math.sin(t * 0.7) * 0.5, P.pos.z + Math.cos(t) * 3.6);
        camera.lookAt(P.pos.x, P.pos.y + 1.05, P.pos.z);
    } else {
        // sit on the aim line, not above it: a camera that looks down at the head
        // puts the crosshair a few degrees above where the gun actually points
        camera.position.copy(head).addScaledVector(a, -camDist.v);
        camera.position.y += 0.30;
        if (camera.position.y < 0.4) camera.position.y = 0.4;
        camera.lookAt(head.x + a.x * 40, head.y + a.y * 40, head.z + a.z * 40);
    }
    camera.rotation.z = 0;
    void dt;
}

// ── input ────────────────────────────────────────────────────────────────────
const keys = Object.create(null);
let locked = false, dragging = false, firing = false, lastClick = 0;
addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    keys[k] = true;
    if (k === 'c' || k === 'control') e.preventDefault();
    if (k === 'r') reload();
    if (k === 'f') { firing = true; shoot(); }     // tap fires once, hold keeps firing
    if (k === 'v') { camMode = (camMode + 1) % 3; blip(520); }
    if (k === 'l') toggleLock();
    if (k === 'b') rig.showBones = !rig.showBones, syncBones();
    if (k === 'x') rig.wire = !rig.wire, syncWire();
    if (k === 't') { rig.texOff = !rig.texOff; syncTex(); }
    if (k === 'g') { grid.visible = !grid.visible; floor.visible = !floor.visible; }
    if (k === 'j') rig.faceFlip = !rig.faceFlip;      // model faces the other way
    if (k === 'p') rig.freeze = !rig.freeze;
    if (k === 'z') rig.targetHeight = Math.max(0.4, rig.targetHeight - 0.05), applyScale();
    if (k === 'h') rig.targetHeight = Math.min(3.2, rig.targetHeight + 0.05), applyScale();
    if (/^[1-9]$/.test(k) && rig.clips.length) playClip(Math.min(rig.clips.length - 1, +k - 1));
    if (k === 'u') resetPos();
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; if (e.key.toLowerCase() === 'f') firing = false; });

function toggleLock() {
    if (locked) { document.exitPointerLock && document.exitPointerLock(); return; }
    const p = canvas.requestPointerLock && canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => { hud.note = 'pointer lock refused — drag to look instead'; });
}
document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    canvas.classList.toggle('locked', locked);
});
addEventListener('mousemove', e => {
    if (locked) { look(e.movementX * 0.0022, e.movementY * 0.0022); }
    else if (dragging) { look(e.movementX * 0.004, e.movementY * 0.004); }
});
canvas.addEventListener('mousedown', e => {
    audio();
    lastClick = performance.now();
    if (e.button === 0) { if (locked) { firing = true; shoot(); } else dragging = true; }
    if (e.button === 2) dragging = true;
});
addEventListener('mouseup', () => { dragging = false; firing = false; });
addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
    camDist.v = Math.min(9, Math.max(1.4, camDist.v + Math.sign(e.deltaY) * 0.5));
    e.preventDefault();
}, { passive: false });

function look(dx, dy) {
    P.yaw -= dx;
    P.pitch = Math.max(-1.15, Math.min(0.85, P.pitch - dy));
}
function resetPos() { P.pos.set(0, 0, 8); P.vel.set(0, 0, 0); P.yaw = 0; P.pitch = 0; }

// ── movement ─────────────────────────────────────────────────────────────────
const fwd = new THREE.Vector3(), side = new THREE.Vector3(), wish = new THREE.Vector3();
function move(dt) {
    const wantCrouch = !!(keys['c'] || keys['control'] || keys['shift'] && keys['c']);
    P.crouch += ((wantCrouch ? 1 : 0) - P.crouch) * (1 - Math.exp(-dt * 12));
    P.height = P.eye + (P.crouchEye - P.eye) * P.crouch;

    fwd.set(-Math.sin(P.yaw), 0, -Math.cos(P.yaw));
    side.set(fwd.z, 0, -fwd.x);
    wish.set(0, 0, 0);
    if (keys['w'] || keys['arrowup']) wish.add(fwd);
    if (keys['s'] || keys['arrowdown']) wish.sub(fwd);
    if (keys['d'] || keys['arrowright']) wish.add(side);
    if (keys['a'] || keys['arrowleft']) wish.sub(side);
    const sprint = !!(keys['shift'] && !wantCrouch);
    if (wish.lengthSq() > 0) {
        wish.normalize();
        const spd = P.crouch > 0.5 ? 1.55 : (sprint && P.crouch < 0.3) ? P.run : P.walk;
        P.vel.x = wish.x * spd; P.vel.z = wish.z * spd;
    } else {
        P.vel.x *= Math.exp(-dt * 14); P.vel.z *= Math.exp(-dt * 14);
    }

    P.vel.y -= GRAV * dt;
    if (keys[' '] && P.onGround) { P.vel.y = 7.2; P.onGround = false; blip(300, 0.04, 0.06); }

    const R = 0.36;
    // Try each axis on its own — that is what makes running into a crate feel
    // like brushing past it rather than being stopped dead.
    const blocked = (x, z) => {
        if (P.pos.y > 0.5) return false;                       // above it: jumping over
        for (const c of blockers) {
            if (x > c.minX - R && x < c.maxX + R && z > c.minZ - R && z < c.maxZ + R && P.height > c.top - 0.2) return true;
        }
        return false;
    };
    const nx = P.pos.x + P.vel.x * dt, nz = P.pos.z + P.vel.z * dt;
    if (!blocked(nx, P.pos.z)) P.pos.x = nx;
    if (!blocked(P.pos.x, nz)) P.pos.z = nz;
    P.pos.x = Math.max(-RANGE + 1, Math.min(RANGE - 1, P.pos.x));
    P.pos.z = Math.max(-RANGE + 1, Math.min(RANGE - 1, P.pos.z));
    P.pos.y += P.vel.y * dt;
    if (P.pos.y <= 0) {
        if (!P.onGround) blip(180, 0.05, 0.05);
        P.pos.y = 0; P.vel.y = 0; P.onGround = true;
    }

    const dist = Math.hypot(P.vel.x, P.vel.z) * dt;
    P.step += dist * (sprint ? 2.4 : 1.9);
    P.hitFlinch = Math.max(0, (P.hitFlinch || 0) - dt * 3);
}

// ── shooting ─────────────────────────────────────────────────────────────────
const ray = new THREE.Raycaster();
function shoot() {
    if (P.reload > 0 || P.fireCd > 0) return;
    if (P.ammo <= 0) { blip(1200, 0.03, 0.05); P.reload = 0.001; reload(); return; }
    P.ammo--; P.shots++;
    P.fireCd = 0.105;
    P.recoil = Math.min(1, P.recoil + 0.55);
    P.pitch = Math.min(0.85, P.pitch + 0.014);
    P.yaw += (Math.random() - 0.5) * 0.004;
    gunshot(1);

    // Fire along the aim, from the chest — the follow camera is a few hundred
    // centimetres off that line, and a ray out of the lens visibly missed what the
    // crosshair was on.
    const dir = aimDir(new THREE.Vector3());
    const origin = new THREE.Vector3(P.pos.x, P.pos.y + P.height * 0.86, P.pos.z).addScaledVector(dir, 0.35);
    // a little spread so sustained fire is visible on the wall
    dir.x += (Math.random() - 0.5) * 0.006; dir.y += (Math.random() - 0.5) * 0.006; dir.z += (Math.random() - 0.5) * 0.006;
    dir.normalize();
    ray.set(origin, dir);
    ray.far = 120;

    const muzzle = new THREE.Vector3(
        origin.x + dir.x * 0.6 + Math.cos(P.yaw) * 0.16,
        origin.y + dir.y * 0.6 - 0.14,
        origin.z + dir.z * 0.6 - Math.sin(P.yaw) * 0.16
    );
    flash.position.copy(muzzle); flash.intensity = 6;
    flashSprite.position.copy(muzzle); flashSprite.material.opacity = 0.9;
    flashSprite.lookAt(origin);

    const h = ray.intersectObjects([...targets, ...solids, floor], true)[0];
    if (!h) { tracer(muzzle, origin.clone().addScaledVector(dir, 60)); return; }
    tracer(muzzle, h.point);
    const target = findTarget(h.object);
    burst(h.point, target ? 9 : 5);
    if (!target) decal(h.point, h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : dir.clone().negate());
    if (target) {
        const d = target.userData.target;
        d.hits++; P.hits++;
        if (h.object.userData.part === 'head') P.headshots++;
        d.pop = 1;
        blip(h.object.userData.part === 'head' ? 1400 : 900, 0.04, 0.08);
        if (d.hits % 5 === 0) {                       // five hits and it drops, then resets
            d.alive = false;
            setTimeout(() => { d.alive = true; d.hits = 0; target.scale.setScalar(1); }, 900);
        }
    }
}
function findTarget(obj) {
    let o = obj;
    while (o) { if (o.userData && o.userData.target) return o; o = o.parent; }
    return null;
}
function reload() {
    if (P.reload > 0 || P.ammo === P.mag || P.reserve <= 0) return;
    P.reload = 1.55; blip(420, 0.09, 0.07);
}

// ── visual toggles ───────────────────────────────────────────────────────────
let boneHelper = null;
function syncBones() {
    if (boneHelper) { scene.remove(boneHelper); boneHelper = null; }
    if (rig.showBones && rig.group) {
        boneHelper = new THREE.SkeletonHelper(rig.group);
        boneHelper.material.linewidth = 2;
        scene.add(boneHelper);
    }
}
function syncWire() {
    if (!rig.group) return;
    rig.group.traverse(o => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.wireframe = !!rig.wire); });
}
const texBackup = new WeakMap();
function syncTex() {
    if (!rig.group) return;
    rig.group.traverse(o => {
        if (!(o.isMesh || o.isSkinnedMesh) || !o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
            if (!m) return;
            if (!rig.texOff) { if (texBackup.has(m)) { m.map = texBackup.get(m); texBackup.delete(m); } }
            else if (m.map) { texBackup.set(m, m.map); m.map = null; }
            m.needsUpdate = true;
        });
    });
}

// ── loop ─────────────────────────────────────────────────────────────────────
const hud = { note: 'loading model…', error: false, fps: 0 };
// A test page you cannot inspect from devtools is a bad test page.
window.__rig = rig; window.__P = P;
const el = {
    state: document.getElementById('state'), note: document.getElementById('note'),
    perf: document.getElementById('perf'), cross: document.getElementById('cross'),
    ammo: document.getElementById('ammo')
};
let last = performance.now(), acc = 0, frames = 0, fpsT = 0;
function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    acc += dt; frames++; fpsT += dt;
    // an EMA of the real frame time, so a slow first frame reads as "6 fps",
    // not "0 fps" next to a page that is clearly painting
    hud.fps = hud.fps ? hud.fps + (1 / Math.max(dt, 0.001) - hud.fps) * 0.08 : 1 / Math.max(dt, 0.001);
    void fpsT; void frames;

    if (!rig.freeze) move(dt);
    P.fireCd = Math.max(0, P.fireCd - dt);
    if (firing) shoot();
    P.recoil = Math.max(0, P.recoil - dt * 3.4);
    if (P.reload > 0) {
        P.reload -= dt;
        if (P.reload <= 0) {
            const need = P.mag - P.ammo, take = Math.min(need, P.reserve);
            P.ammo += take; P.reserve -= take;
        }
    }

    // model follows the player; yaw is shared, pitch only tilts the torso
    modelRoot.position.set(P.pos.x, P.pos.y, P.pos.z);
    modelRoot.rotation.set(0, P.yaw + Math.PI + (rig.faceFlip ? Math.PI : 0), 0);
    if (rig.ready) {
        if (rig.group) {
            rig.group.position.set(0, rig.footOffset, 0);
            rig.group.rotation.set(0, 0, 0);
            rig.group.visible = camMode !== 1;
        }
        if (rig.animMode === 'clips' && rig.mixer && !rig.freeze) rig.mixer.update(dt);
        else pose(dt);
    }
    blob.position.set(P.pos.x, 0.012, P.pos.z);
    blob.scale.setScalar(Math.max(0.45, 1 - P.pos.y * 0.14));

    for (const l of tracers) if (l.userData.life > 0) { l.userData.life -= dt; l.material.opacity = Math.max(0, l.userData.life / 0.07) * 0.95; }
    for (const s of sparks) if (s.userData.life > 0) {
        s.userData.life -= dt;
        s.userData.v.y -= 9 * dt;
        s.position.addScaledVector(s.userData.v, dt);
        s.material.opacity = Math.max(0, s.userData.life * 3.2);
        s.scale.setScalar(0.6 + s.userData.life * 2);
    }
    for (const h of holes) { h.userData.life -= dt; if (h.userData.life < 1) h.material.opacity = Math.max(0, h.userData.life) * 0.85; }
    flash.intensity = Math.max(0, flash.intensity - dt * 60);
    flashSprite.material.opacity = Math.max(0, flashSprite.material.opacity - dt * 18);
    for (const tg of targets) {
        const d = tg.userData.target;
        if (d.pop > 0) d.pop = Math.max(0, d.pop - dt * 4);
        // a hit punches the dummy forward a little; a dead one folds and dims
        tg.scale.setScalar(d.alive ? 1 : 0.85);
        tg.rotation.x = d.alive ? -0.16 * d.pop : -1.2;
        tg.position.y = d.alive ? 0 : -0.25;
        const lit = d.alive ? 1 : 0.42;
        for (const m of d.mats) m.color.setRGB(0xB8 / 255 * lit, 0x44 / 255 * lit, 0x3A / 255 * lit);
    }

    putCamera(dt);
    hudTick(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
}

let hudAcc = 0;
function hudTick(dt) {
    hudAcc += dt;
    if (hudAcc < 0.12) return;
    hudAcc = 0;
    const speed = Math.hypot(P.vel.x, P.vel.z);
    const st = rig.group && rig.group.visible === false ? 'first person' : camMode === 2 ? 'inspect orbit' : 'follow';
    el.state.textContent =
        `pose ${P.crouch > 0.4 ? 'CROUCH' : !P.onGround ? 'AIR' : speed > 0.35 ? (keys['shift'] ? 'SPRINT' : 'WALK') : 'IDLE'}` +
        ` · ${speed.toFixed(2)} m/s · ground ${P.onGround ? 'y' : 'n'} · hip ${P.height.toFixed(2)} m` +
        ` · anim ${rig.animMode}${rig.clips.length ? '' : ' (no clips in file)'} · model ${st}`;
    el.note.textContent = hud.error ? '⚠ ' + hud.note : hud.note;
    el.note.className = hud.error ? 'bad' : '';
    const info = renderer.info;
    el.perf.textContent =
        `${hud.fps.toFixed(0)} fps · ${info.render.calls} calls · ${(info.render.triangles / 1000).toFixed(1)}k tris` +
        ` · scale ${rig.rawHeight ? (rig.rawHeight.toFixed(2) + ' m → ' + rig.targetHeight.toFixed(2) + ' m') : '—'}` +
        ` · tex ${rig.texMap.length ? rig.texMap.map(([m, t]) => m.split('/').pop() + '→' + t).slice(0, 3).join(', ') : '—'}` +
        ` · hits ${P.hits}/${P.shots}${P.headshots ? ' (' + P.headshots + ' head)' : ''}`;
    el.ammo.textContent = `${P.ammo} / ${P.reserve}${P.reload > 0 ? '  reloading…' : ''}`;
    el.cross.classList.toggle('hit', P.recoil > 0.35);
}

addEventListener('resize', () => {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
});
canvas.addEventListener('click', () => { if (!locked && performance.now() - lastClick < 400 && !dragging) toggleLock(); });
dispatchEvent(new Event('resize'));
requestAnimationFrame(tick);
