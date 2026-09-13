// ============================================================================
// soldier.js — rigged, animated soldier character
//
// The model is a real bone hierarchy (hips → spine → chest → head / arms / legs)
// driven procedurally.  Both hands are placed on the weapon every frame with a
// two-bone IK solver, so the grip is always correct no matter what the torso is
// doing.  Legs are IK'd onto a foot-planting walk cycle.
//
// CONVENTION: the model faces -Z (Three.js forward).  Callers must therefore
// set root.rotation.y so that local -Z points where the soldier is looking.
// ============================================================================
import * as THREE from 'three';
import * as M from './materials.js';
import { createWorldWeapon, WEAPON_GRIPS } from './weapons.js';
import { mergeRig } from './optimize.js';

const DOWN = new THREE.Vector3(0, -1, 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ── proportions (metres) ────────────────────────────────────────────────────
const P = {
    hipY: 0.94,
    thigh: 0.44, shin: 0.42, ankle: 0.09,
    spine: 0.15, chest: 0.16,
    shoulderY: 0.30, shoulderX: 0.205,
    upperArm: 0.29, foreArm: 0.27,
    neckY: 0.30, headY: 0.14
};

// ── shared per-team material sets (built once) ──────────────────────────────
const TEAM_MATS = [null, null];
function teamMaterials(team) {
    if (TEAM_MATS[team]) return TEAM_MATS[team];
    const blue = team === 0;
    const set = {
        uniform: blue ? M.camoBlue() : M.camoRed(),
        // Vest sits several shades off the uniform so the silhouette reads.
        vest:    M.vestFabric(blue ? 'a' : 'b', blue ? '#2b3327' : '#4d3f28'),
        pouch:   M.vestFabric(blue ? 'ap' : 'bp', blue ? '#232a20' : '#3d3220'),
        helmet:  M.plain(blue ? 0x434b3a : 0x6b5b41, 0.62, 0.12),
        glove:   M.glove(),
        boot:    M.bootLeather(),
        hard:    M.plain(0x1a1c1e, 0.42, 0.55),
        strap:   M.plain(0x24261f, 0.85, 0.02),
        lens:    new THREE.MeshStandardMaterial({ color: 0x1b2a33, roughness: 0.08, metalness: 0.9, envMapIntensity: 1.3 }),
        // Team identifier: a cloth patch, not a glowing beacon.
        marker:  M.plain(blue ? 0x2a5590 : 0x933024, 0.88, 0.0)
    };
    // Knee pads share the `hard` material: fewer distinct materials means the
    // per-bone merge collapses into fewer meshes, which means fewer draw calls.
    set.knee = set.hard;
    TEAM_MATS[team] = set;
    return set;
}

const SKIN_TONES = ['#c99b6f', '#a97c52', '#7d5636', '#e0b58a', '#5f4028'];
function skinMat(i) { return M.skin(SKIN_TONES[i % SKIN_TONES.length]); }

// ── mesh helper ────────────────────────────────────────────────────────────
function part(parent, geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
}
const boxG = (w, h, d, seg = 1) => new THREE.BoxGeometry(w, h, d, seg, seg, seg);

// Rounded-ish limb: a box with slightly tapered ends reads better than a raw cube.
function limbGeo(top, bottom, len, depth) {
    const g = new THREE.CylinderGeometry(top, bottom, len, 8, 1);
    g.scale(1, 1, depth);
    return g;
}

// ============================================================================
// TWO-BONE IK
// Bones run along their own -Y axis.  `root` is the shoulder/hip group,
// `mid` is the elbow/knee group parented at (0,-upperLen,0).
// ============================================================================
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
function solveIK(root, mid, upperLen, foreLen, target, poleAngle, bendSign) {
    _v.copy(target).sub(root.position);
    let d = _v.length();
    if (d < 1e-5) return;
    const minD = Math.abs(upperLen - foreLen) + 0.005;
    const maxD = upperLen + foreLen - 0.005;
    const dir = _v.normalize();
    d = clamp(d, minD, maxD);

    _q.setFromUnitVectors(DOWN, dir);
    if (poleAngle) {
        _q2.setFromAxisAngle(dir, poleAngle);
        _q.premultiply(_q2);
    }
    const cosA = (upperLen * upperLen + d * d - foreLen * foreLen) / (2 * upperLen * d);
    const cosB = (upperLen * upperLen + foreLen * foreLen - d * d) / (2 * upperLen * foreLen);
    const a = Math.acos(clamp(cosA, -1, 1));
    const b = Math.acos(clamp(cosB, -1, 1));

    root.quaternion.copy(_q);
    root.rotateX(bendSign * a);
    mid.rotation.set(-bendSign * (Math.PI - b), 0, 0);
}

// ============================================================================
// BUILD
// ============================================================================
function buildArm(chest, side, mats, skin) {
    // side: -1 = left, +1 = right
    const shoulder = new THREE.Group();
    shoulder.position.set(side * P.shoulderX, P.shoulderY, 0);
    chest.add(shoulder);

    // deltoid cap sits at the joint
    part(shoulder, new THREE.SphereGeometry(0.075, 10, 8), mats.uniform, 0, 0.01, 0);
    part(shoulder, limbGeo(0.062, 0.050, P.upperArm, 0.92), mats.uniform, 0, -P.upperArm / 2, 0);
    // unit patch on the sleeve
    part(shoulder, boxG(0.008, 0.038, 0.038), mats.marker, side * 0.062, -0.055, 0);

    const elbow = new THREE.Group();
    elbow.position.set(0, -P.upperArm, 0);
    shoulder.add(elbow);
    part(elbow, new THREE.SphereGeometry(0.052, 8, 6), mats.uniform, 0, 0, 0);
    // sleeve covers most of the forearm; only the wrist is bare
    part(elbow, limbGeo(0.052, 0.045, P.foreArm * 0.76, 0.92), mats.uniform, 0, -P.foreArm * 0.38, 0);
    part(elbow, limbGeo(0.043, 0.039, P.foreArm * 0.26, 0.92), skin, 0, -P.foreArm * 0.87, 0);

    const hand = new THREE.Group();
    hand.position.set(0, -P.foreArm, 0);
    elbow.add(hand);
    buildFist(hand, side, mats);

    return { shoulder, elbow, hand };
}

/** Compact gloved fist, curled as if wrapped around a grip. */
function buildFist(hand, side, mats) {
    const g = new THREE.Group();
    hand.add(g);
    // glove cuff
    part(g, new THREE.CylinderGeometry(0.045, 0.042, 0.05, 8), mats.glove, 0, 0.005, 0);
    // palm
    part(g, boxG(0.052, 0.085, 0.075), mats.glove, 0, -0.055, -0.005);
    // knuckle guard
    part(g, boxG(0.05, 0.03, 0.045), mats.hard, 0, -0.088, -0.03);
    // curled fingers (two rows to suggest four fingers)
    for (let i = 0; i < 4; i++) {
        const fy = -0.075 - i * 0.016;
        part(g, boxG(0.05, 0.014, 0.055), mats.glove, 0, fy, -0.045 + i * 0.004);
        part(g, boxG(0.048, 0.016, 0.024), mats.glove, 0, fy - 0.014, -0.068);
    }
    // thumb across the top
    part(g, boxG(0.02, 0.05, 0.024), mats.glove, side * -0.03, -0.062, -0.038, 0.5, 0, side * 0.35);
    return g;
}

function buildLeg(hips, side, mats) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.105, -0.02, 0);
    hips.add(hip);
    part(hip, limbGeo(0.085, 0.068, P.thigh, 0.95), mats.uniform, 0, -P.thigh / 2, 0);

    const knee = new THREE.Group();
    knee.position.set(0, -P.thigh, 0);
    hip.add(knee);
    part(knee, boxG(0.10, 0.075, 0.085), mats.knee, 0, -0.005, -0.028);  // knee pad
    part(knee, limbGeo(0.066, 0.052, P.shin, 0.95), mats.uniform, 0, -P.shin / 2, 0);
    // blousing over the boot
    part(knee, new THREE.CylinderGeometry(0.062, 0.058, 0.07, 8), mats.uniform, 0, -P.shin + 0.05, 0);

    const ankle = new THREE.Group();
    ankle.position.set(0, -P.shin, 0);
    knee.add(ankle);
    part(ankle, boxG(0.095, 0.075, 0.12), mats.boot, 0, -0.04, -0.012);   // ankle
    part(ankle, boxG(0.10, 0.055, 0.245), mats.boot, 0, -0.075, -0.055);  // foot
    part(ankle, boxG(0.105, 0.028, 0.25), mats.hard, 0, -0.098, -0.058);  // sole

    return { hip, knee, ankle };
}

function buildHead(chest, mats, skinM, faceIdx) {
    const neck = new THREE.Group();
    neck.position.set(0, P.neckY, 0);
    chest.add(neck);
    part(neck, new THREE.CylinderGeometry(0.055, 0.065, 0.08, 8), skinM, 0, 0.02, 0);

    const head = new THREE.Group();
    head.position.set(0, P.headY, 0);
    neck.add(head);

    // skull
    const sk = part(head, new THREE.SphereGeometry(0.105, 14, 12), skinM, 0, 0.01, 0.005);
    sk.scale.set(0.94, 1.12, 1.02);
    // jaw
    part(head, boxG(0.135, 0.075, 0.15), skinM, 0, -0.065, -0.012);
    // nose
    part(head, boxG(0.028, 0.045, 0.035), skinM, 0, -0.022, -0.098);
    // brow
    part(head, boxG(0.16, 0.022, 0.03), skinM, 0, 0.028, -0.09);
    // eyes — one shared dark material; at combat range the sclera never reads
    for (const sx of [-0.042, 0.042]) {
        part(head, new THREE.SphereGeometry(0.015, 8, 6), mats.hard, sx, 0.002, -0.088);
    }
    // ears
    for (const sx of [-0.098, 0.098]) part(head, boxG(0.02, 0.05, 0.035), skinM, sx, -0.01, 0.005);

    // shemagh / neck gaiter pulled up over the mouth on some soldiers
    if (faceIdx % 2 === 0) {
        part(head, boxG(0.145, 0.09, 0.155), mats.strap, 0, -0.062, -0.008);
    }

    // helmet shell
    const shell = part(head, new THREE.SphereGeometry(0.128, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), mats.helmet, 0, 0.028, 0.004);
    shell.scale.set(1.02, 1.12, 1.06);
    part(head, new THREE.TorusGeometry(0.128, 0.011, 6, 20), mats.helmet, 0, 0.028, 0.004, Math.PI / 2);
    // brim
    part(head, boxG(0.2, 0.016, 0.055), mats.helmet, 0, 0.038, -0.108);
    // NVG mount
    part(head, boxG(0.05, 0.045, 0.03), mats.hard, 0, 0.072, -0.118);
    part(head, boxG(0.03, 0.03, 0.05), mats.hard, 0, 0.058, -0.135);
    // side rails + counterweight pouch
    for (const sx of [-1, 1]) part(head, boxG(0.012, 0.03, 0.11), mats.hard, sx * 0.118, 0.03, -0.01);
    part(head, boxG(0.1, 0.06, 0.05), mats.pouch, 0, 0.045, 0.108);
    // chin strap
    part(head, boxG(0.185, 0.014, 0.014), mats.strap, 0, -0.055, -0.04);
    for (const sx of [-1, 1]) part(head, boxG(0.012, 0.09, 0.014), mats.strap, sx * 0.09, -0.02, -0.02);

    // goggles pushed up on the helmet
    part(head, boxG(0.19, 0.05, 0.05), mats.lens, 0, 0.05, -0.085);
    part(head, boxG(0.2, 0.02, 0.055), mats.strap, 0, 0.075, -0.06);

    return { neck, head };
}

function buildTorso(chest, mats) {
    // ribcage / uniform
    const t = part(chest, boxG(0.34, 0.42, 0.21), mats.uniform, 0, 0.09, 0);
    t.geometry = new THREE.BoxGeometry(0.34, 0.42, 0.21, 2, 2, 2);
    // shoulders taper
    part(chest, boxG(0.42, 0.12, 0.22), mats.uniform, 0, 0.26, 0);

    // plate carrier
    part(chest, boxG(0.355, 0.34, 0.245), mats.vest, 0, 0.11, 0);
    part(chest, boxG(0.30, 0.30, 0.02), mats.pouch, 0, 0.11, -0.128);   // front plate face
    // mag pouches across the chest
    for (const sx of [-0.10, 0.0, 0.10]) part(chest, boxG(0.085, 0.115, 0.055), mats.pouch, sx, 0.06, -0.148);
    for (const sx of [-0.10, 0.10]) part(chest, boxG(0.08, 0.06, 0.045), mats.pouch, sx, 0.175, -0.145);
    // radio on the left shoulder strap
    part(chest, boxG(0.05, 0.09, 0.04), mats.hard, -0.13, 0.22, -0.125);
    part(chest, new THREE.CylinderGeometry(0.006, 0.004, 0.18, 5), mats.hard, -0.13, 0.32, -0.12, 0.2);
    // shoulder straps
    for (const sx of [-1, 1]) part(chest, boxG(0.075, 0.13, 0.03), mats.vest, sx * 0.115, 0.245, -0.11);
    // back pack
    part(chest, boxG(0.29, 0.34, 0.14), mats.pouch, 0, 0.12, 0.165);
    part(chest, boxG(0.24, 0.10, 0.10), mats.pouch, 0, -0.02, 0.19);
    part(chest, new THREE.CylinderGeometry(0.035, 0.035, 0.20, 8), mats.hard, 0.10, 0.20, 0.225);  // canteen
    // collar
    part(chest, boxG(0.20, 0.06, 0.17), mats.uniform, 0, 0.29, 0);
}

function buildHips(hips, mats) {
    part(hips, boxG(0.31, 0.17, 0.20), mats.uniform, 0, -0.03, 0);
    part(hips, boxG(0.335, 0.055, 0.215), mats.strap, 0, 0.03, 0);       // belt
    part(hips, boxG(0.055, 0.05, 0.03), mats.hard, 0, 0.03, -0.115);     // buckle
    // drop pouches
    part(hips, boxG(0.075, 0.11, 0.06), mats.pouch, -0.13, -0.03, -0.09);
    part(hips, boxG(0.075, 0.11, 0.06), mats.pouch, 0.13, -0.03, -0.09);
    part(hips, boxG(0.07, 0.13, 0.05), mats.pouch, 0.145, -0.06, 0.055); // holster
}

// ============================================================================
// SOLDIER RIG
// ============================================================================
export class SoldierRig {
    constructor(team, weaponType = 'rifle', variantSeed = 0) {
        const mats = teamMaterials(team);
        this.mats = mats;
        this.team = team;
        const skinM = skinMat(variantSeed);

        this.root = new THREE.Group();
        this.root.name = 'soldier';

        this.hips = new THREE.Group();
        this.hips.position.y = P.hipY;
        this.root.add(this.hips);
        buildHips(this.hips, mats);

        this.spine = new THREE.Group();
        this.spine.position.y = P.spine;
        this.hips.add(this.spine);

        this.chest = new THREE.Group();
        this.chest.position.y = P.chest;
        this.spine.add(this.chest);
        buildTorso(this.chest, mats);

        const hd = buildHead(this.chest, mats, skinM, variantSeed);
        this.neck = hd.neck;
        this.head = hd.head;

        this.armL = buildArm(this.chest, -1, mats, skinM);
        this.armR = buildArm(this.chest, 1, mats, skinM);
        this.legL = buildLeg(this.hips, -1, mats);
        this.legR = buildLeg(this.hips, 1, mats);

        // weapon lives on a mount driven by the animation, hands IK to it
        this.weaponMount = new THREE.Group();
        this.chest.add(this.weaponMount);
        this.weaponType = null;
        this.setWeapon(weaponType);

        // batch the static primitives inside each bone before anything animates
        mergeRig(this.root);

        // muzzle flash + light (built after merging so the billboards stay separate)
        this.muzzle = new THREE.Group();
        this.muzzle.userData.noMerge = true;
        this.weaponMount.add(this.muzzle);
        const flashMat = new THREE.MeshBasicMaterial({
            color: 0xffd27a, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending
        });
        this.flashA = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), flashMat);
        this.flashB = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.22, 6), flashMat.clone());
        this.flashB.rotation.x = -Math.PI / 2;
        this.flashB.position.z = -0.12;
        this.muzzle.add(this.flashA, this.flashB);
        // No per-soldier point light: nine of them would triple the scene's
        // light count and every material pays for it every frame. Bots borrow
        // the shared effects light pool instead (see main.js).

        // animation state
        this.cycle = Math.random() * 10;
        this.aimBlend = 0;
        this.crouchBlend = 0;
        this.recoil = 0;
        this.flashTimer = 0;
        this.breath = Math.random() * 6;
        this.deadT = -1;
        this.deathStyle = 0;
        this.headYaw = 0; this.headPitch = 0;
        this._tmp = new THREE.Vector3();
    }

    setWeapon(type) {
        if (this.weaponType === type) return;
        if (this.weapon) {
            this.weaponMount.remove(this.weapon);
            this.weapon.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
        }
        this.weaponType = type;
        this.weapon = createWorldWeapon(type);
        mergeRig(this.weapon);
        this.weaponMount.add(this.weapon);
        this.grips = WEAPON_GRIPS[type] || WEAPON_GRIPS.rifle;
        this.muzzleLocal = this.grips.muzzle;
    }

    // ── death ───────────────────────────────────────────────────────────────
    startDeath() {
        this.deadT = 0;
        this.deathStyle = (Math.random() * 3) | 0;
        this.deathYaw = (Math.random() - 0.5) * 1.4;
        // drop the weapon out of the hands so it reads as a real death
        if (this.weapon) {
            this.weapon.rotation.set(Math.random(), Math.random(), Math.random());
        }
    }

    resetPose() {
        this.deadT = -1;
        this.root.rotation.set(0, this.root.rotation.y, 0);
        this.root.position.y = 0;
        this.hips.position.set(0, P.hipY, 0);
        this.hips.rotation.set(0, 0, 0);
        this.spine.rotation.set(0, 0, 0);
        this.chest.rotation.set(0, 0, 0);
        this.head.rotation.set(0, 0, 0);
        this.aimBlend = 0;
        this.crouchBlend = 0;
        if (this.weapon) this.weapon.rotation.set(0, 0, 0);
    }

    fireFlash() {
        this.flashTimer = 0.055;
        this.recoil = 1;
    }

    /**
     * state = {
     *   speed:      horizontal m/s
     *   aiming:     bool
     *   crouching:  bool
     *   aimPitch:   radians, + = up
     *   lookYaw:    radians offset for head/torso twist
     * }
     */
    update(dt, state) {
        if (this.deadT >= 0) { this._updateDeath(dt); return; }

        const speed = state.speed || 0;
        const running = speed > 0.1;

        // blends
        const aimT = state.aiming ? 1 : 0;
        this.aimBlend += (aimT - this.aimBlend) * Math.min(1, dt * 9);
        const crT = state.crouching ? 1 : 0;
        this.crouchBlend += (crT - this.crouchBlend) * Math.min(1, dt * 8);
        this.recoil *= Math.pow(0.001, dt);
        this.breath += dt;

        const cr = this.crouchBlend;
        const aim = this.aimBlend;

        // ── locomotion cycle ────────────────────────────────────────────────
        const strideLen = 1.35;
        if (running) this.cycle += (speed / strideLen) * Math.PI * 2 * dt;
        else this.cycle += dt * 1.1;               // slow idle sway

        const walkAmt = clamp(speed / 5.5, 0, 1);
        const c = this.cycle;

        // ── hips: bob, sway, crouch drop ────────────────────────────────────
        const bob = running ? Math.sin(c * 2) * 0.028 * walkAmt : Math.sin(this.breath * 1.6) * 0.006;
        const sway = running ? Math.sin(c) * 0.022 * walkAmt : 0;
        this.hips.position.y = P.hipY - cr * 0.36 + bob;
        this.hips.position.x = sway;
        this.hips.rotation.z = running ? Math.sin(c) * 0.06 * walkAmt : 0;
        this.hips.rotation.y = running ? Math.sin(c) * 0.10 * walkAmt : 0;
        this.hips.rotation.x = cr * 0.22 + walkAmt * 0.05;

        // ── spine / chest: lean into the run, counter-rotate against hips ───
        const lean = walkAmt * (state.aiming ? 0.06 : 0.16) + cr * 0.16;
        this.spine.rotation.x = lean;
        this.spine.rotation.y = running ? -Math.sin(c) * 0.11 * walkAmt : 0;
        this.chest.rotation.x = -lean * 0.35 + Math.sin(this.breath * 1.6) * 0.008;
        this.chest.rotation.y = clamp(state.lookYaw || 0, -0.7, 0.7) * (0.35 + aim * 0.3);
        this.chest.rotation.z = running ? Math.sin(c) * 0.035 * walkAmt : 0;

        // ── head: look at target, stabilise against body motion ─────────────
        const tgtYaw = clamp((state.lookYaw || 0) * 0.55, -0.8, 0.8);
        const tgtPitch = clamp(-(state.aimPitch || 0) * 0.6, -0.6, 0.6);
        this.headYaw += (tgtYaw - this.headYaw) * Math.min(1, dt * 8);
        this.headPitch += (tgtPitch - this.headPitch) * Math.min(1, dt * 8);
        this.head.rotation.y = this.headYaw - this.chest.rotation.y;
        this.head.rotation.x = this.headPitch - this.spine.rotation.x;
        this.head.rotation.z = running ? -Math.sin(c) * 0.03 * walkAmt : 0;

        // ── legs: IK to a foot-planting walk cycle ──────────────────────────
        this._legIK(this.legL, c, walkAmt, cr, -1, speed);
        this._legIK(this.legR, c + Math.PI, walkAmt, cr, 1, speed);

        // ── weapon mount: low-ready → shouldered ────────────────────────────
        const recoilKick = this.recoil;
        // Low ready: butt still in the shoulder pocket, muzzle angled down.
        const lowP = new THREE.Vector3(0.125, 0.175, -0.15);
        const lowR = new THREE.Vector3(0.52, -0.20, 0.06);
        // Shouldered: stock tucked against the right shoulder, barrel on line.
        const aimP = new THREE.Vector3(0.130, 0.275, -0.17);
        const aimR = new THREE.Vector3(0, -0.045, 0);

        const mp = this.weaponMount.position;
        mp.lerpVectors(lowP, aimP, aim);
        mp.z += recoilKick * 0.05;
        mp.y += (running ? Math.sin(c * 2 + 1) * 0.012 * walkAmt : Math.sin(this.breath * 1.7) * 0.004);

        const rx = lowR.x + (aimR.x - lowR.x) * aim;
        const ry = lowR.y + (aimR.y - lowR.y) * aim;
        const rz = lowR.z + (aimR.z - lowR.z) * aim;
        this.weaponMount.rotation.set(
            rx - (state.aimPitch || 0) * aim - recoilKick * 0.35,
            ry + (running ? Math.sin(c) * 0.05 * walkAmt : 0),
            rz
        );
        this.weaponMount.updateMatrix();

        // muzzle transform for flash + tracer origin
        this.muzzle.position.copy(this.muzzleLocal);

        // ── arms: IK both hands onto the weapon grips ───────────────────────
        this._handIK();

        // ── muzzle flash ────────────────────────────────────────────────────
        if (this.flashTimer > 0) {
            this.flashTimer -= dt;
            const o = clamp(this.flashTimer / 0.055, 0, 1);
            this.flashA.material.opacity = o;
            this.flashB.material.opacity = o * 0.9;
            const s = 0.8 + Math.random() * 0.7;
            this.flashA.scale.setScalar(s);
            this.flashB.scale.set(s, 1, s);
            this.flashB.rotation.z = Math.random() * 3;
        } else if (this.flashA.material.opacity !== 0) {
            this.flashA.material.opacity = 0;
            this.flashB.material.opacity = 0;
        }
    }

    _legIK(leg, phase, walkAmt, crouch, side, speed) {
        const hipWorldY = this.hips.position.y;
        // foot target in hips space
        const stride = 0.34 * walkAmt;
        const lift = 0.20 * walkAmt;
        const sp = Math.sin(phase), cp = Math.cos(phase);

        // elliptical foot path: forward/back from sin, height from a clipped cos
        let fz = -sp * stride;
        let fy = -hipWorldY + P.ankle + Math.max(0, cp) * lift;

        // stance width + crouch tuck
        const fx = side * 0.105 + side * crouch * 0.045;
        fz += crouch * 0.06;
        fy += crouch * 0.02;

        // idle: subtle weight shift instead of a frozen T
        if (walkAmt < 0.02) {
            fz = crouch * 0.06 + (side < 0 ? 0.015 : -0.01);
            fy = -hipWorldY + P.ankle;
        }

        this._tmp.set(fx, fy, fz);
        // hip group sits at (side*0.105, -0.02, 0); solveIK works in hips space
        solveIK(leg.hip, leg.knee, P.thigh, P.shin, this._tmp, side * 0.06, 1);

        // roll the foot through toe-off / heel-strike
        leg.ankle.rotation.x = this._footPitch(phase, walkAmt, crouch);
        void speed;
    }

    _footPitch(phase, walkAmt, crouch) {
        // toe-off then heel-strike
        const p = Math.sin(phase + 0.6) * 0.35 * walkAmt;
        return p + crouch * 0.25;
    }

    _handIK() {
        const wm = this.weaponMount;
        wm.updateMatrix();
        // grip points expressed in chest space
        // Firing hand: elbow tucked down and slightly out to the right.
        const rTarget = this._tmp.copy(this.grips.rear).applyMatrix4(wm.matrix);
        solveIK(this.armR.shoulder, this.armR.elbow, P.upperArm, P.foreArm, rTarget, -0.28, -1);
        this.armR.hand.rotation.set(-1.35, 0, 0);

        // Support hand: elbow drops under the weapon rather than flaring out.
        const fTarget = this._tmp.copy(this.grips.front).applyMatrix4(wm.matrix);
        solveIK(this.armL.shoulder, this.armL.elbow, P.upperArm, P.foreArm, fTarget, 0.30, -1);
        this.armL.hand.rotation.set(-1.5, 0, 0.35);
    }

    _updateDeath(dt) {
        this.deadT += dt;
        const t = this.deadT;
        const k = clamp(t / 0.85, 0, 1);        // collapse progress
        const e = k * k * (3 - 2 * k);          // smoothstep

        const style = this.deathStyle;
        // hips drop and the body rotates onto the ground
        this.hips.position.y = P.hipY - e * (P.hipY - 0.20);
        this.root.rotation.z = 0;

        if (style === 0) {          // fall backwards
            this.root.rotation.x = e * 1.45;
            this.spine.rotation.x = -e * 0.55 + Math.sin(t * 8) * 0.03 * (1 - e);
            this.head.rotation.x = -e * 0.5;
        } else if (style === 1) {   // face plant
            this.root.rotation.x = -e * 1.5;
            this.spine.rotation.x = e * 0.45;
            this.head.rotation.x = e * 0.35;
        } else {                    // crumple sideways
            this.root.rotation.z = (this.deathYaw > 0 ? 1 : -1) * e * 1.4;
            this.root.rotation.x = e * 0.35;
            this.spine.rotation.z = -this.root.rotation.z * 0.4;
            this.hips.position.y = P.hipY - e * (P.hipY - 0.28);
        }
        this.root.rotation.y += this.deathYaw * dt * (1 - e) * 2;

        // limbs go limp
        const limp = Math.min(1, t * 2.2);
        for (const arm of [this.armL, this.armR]) {
            arm.shoulder.quaternion.slerp(_q.setFromEuler(new THREE.Euler(0.35 + Math.sin(t * 3) * 0.1, 0, 0)), limp * 0.25);
            arm.elbow.rotation.x += (0.35 - arm.elbow.rotation.x) * limp * 0.2;
        }
        for (const leg of [this.legL, this.legR]) {
            leg.knee.rotation.x += (-0.55 - leg.knee.rotation.x) * limp * 0.15;
        }

        // let the dropped weapon settle
        if (this.weapon && t < 1.2) {
            this.weapon.position.y -= dt * 1.6 * (1 - e);
            this.weapon.rotation.x += dt * 2 * (1 - e);
        }

        // fade out at the end of the body's lifetime
        if (t > 4.0) {
            const f = clamp(1 - (t - 4.0) / 1.0, 0, 1);
            this.root.traverse(o => {
                if (o.isMesh && o.material) {
                    if (!o.material.transparent) { o.material = o.material.clone(); o.material.transparent = true; }
                    o.material.opacity = f;
                }
            });
        }
    }

    /** Matches AnimatedSoldier so callers do not care which rig they hold. */
    setShadows(on) {
        if (this._shadows === on) return;
        this._shadows = on;
        this.root.traverse(o => { if (o.isMesh) o.castShadow = on; });
    }

    dispose() {
        this.root.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    }
}

/** World-space muzzle position of a rig (for tracers/impacts). */
export function muzzleWorld(rig, out) {
    rig.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(rig.muzzle.matrixWorld);
}
