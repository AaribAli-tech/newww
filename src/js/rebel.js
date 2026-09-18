// ============================================================================
// rebel.js — the "Modern Rebel Soldier" (github.com/AaribAli-tech/call-of-duty-asset-for-person)
// as a drop-in bot rig.
//
// It exposes exactly the surface ai.js uses on the other two rigs — root, muzzle,
// setWeapon, update(dt, state), fireFlash, startDeath, resetPose, setOpacity,
// setShadows, dispose — so a bot cannot tell which one it got, and `rigFor()`
// picks between the three. If the FBX is absent or fails, nothing changes: the
// game keeps the GLB soldiers, and keeps the procedural ones if those are absent.
//
// Two properties of this particular file shaped the code below, and both are
// worth knowing before the model goes anywhere near a shipped build:
//
//   • It has NO ANIMATION CLIPS. The export carries a `mixamorig:` skeleton but
//     no AnimationStack, so there is nothing for an AnimationMixer to play and
//     locomotion is generated here from the bot's own speed, crouch and aim —
//     the same trick the model tester in src/tester/ uses. It will never look as
//     good as the GLB soldiers' canned clips until real clips are authored (or
//     the existing anim_*.glb are retargeted onto this skeleton, which is a
//     matching bone set, so it is feasible).
//   • Its texture paths are the author's own `C:\Users\...`, which no browser can
//     read, so materials are rebound here by name (Body / Head / BootAndSkin)
//     from the three PNGs that ship beside the FBX.
//
// The mesh is 15 separate skinned pieces. Merging them into three (one per
// material) would cut ~120 draw calls on a full lobby, but merging skinned
// geometries has to agree with each piece's bind matrix, and a wrong guess shows
// up as a twitching soldier, so it is deliberately left alone: correctness first.
// ============================================================================
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { createWorldWeapon, WEAPON_GRIPS } from './weapons.js';
import { AnimatedSoldier, charactersReady } from './character.js';
import { SoldierRig } from './soldier.js';
import { TEAM_B } from './utils.js';
import { STAND_FLIP, ARMS, TARGET_HEIGHT, fitFactor } from './rebel-pose.js';

const BASE = 'assets/characters/';
const RUN_SPEED = 5.6;             // m/s at which the stride reaches full amplitude

// The 24 names the game's own rigs use. The FBX prefixes them with "mixamorig:"
// and Blender may suffix ".001", so names are normalised before matching, and the
// longest key wins so "leftupleg" is never claimed by "LeftLeg".
const BONES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
    'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
    'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
    'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
    'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];
const BONES_LONG_FIRST = [...BONES].sort((a, b) => b.length - a.length);
const normBone = n => (n || '').toLowerCase()
    .replace(/^mixamorig[:_\s-]?/, '').replace(/\.[0-9]+$/, '').replace(/[:_\s-]/g, '');

const TEXTURES = [
    [/boot|skin/i, 'BootsAndSkinTexture.png'],
    [/head|face/i, 'HeadTexture.png'],
    [/body|cloth|vest|gear/i, 'BodyTexture.png']
];

// One line to flip when the model is approved: 'off' | 'enemy' | 'all'.
const DEFAULT_MODE = 'off';

// ── shared loaded state ──────────────────────────────────────────────────────
const S = {
    status: 'off',        // off · loading · ready · failed
    mode: 'off',          // off · enemy (opposing team only) · all
    proto: null, height: 0, calibrated: false, drew: 0,
    parts: 0, tris: 0, rawHeight: 0, bones: 0, missing: [], err: ''
};

// The model is being signed off on /tester/ first, so the match keeps its own
// soldiers until then. Add ?rebel=all (or ?rebel=enemy for one side) to the game
// URL to wear it now, or flip the default here once the tester gets a yes.
// Nothing is downloaded at all when the mode is off.
try {
    const q = new URLSearchParams(location.search).get('rebel');
    if (q === 'off' || q === 'all' || q === 'enemy') S.mode = q;
    else if (q === null) S.mode = DEFAULT_MODE;
} catch { /* no URL to read */ }

export function rebelMode() { return S.mode; }
export function setRebelMode(m) {
    if (m === 'off' || m === 'all' || m === 'enemy') S.mode = m;
    return S.mode;
}
export function rebelInfo() {
    return {
        status: S.status, mode: S.mode, parts: S.parts, tris: S.tris,
        rawHeight: +S.rawHeight.toFixed(2), height: S.drew || TARGET_HEIGHT,
        bones: S.bones, missing: S.missing, error: S.err
    };
}

/** Load the FBX and its textures once, normalised, as the clone template. */
export async function loadRebel(base = BASE) {
    if (S.mode === 'off') return false;
    if (S.status === 'ready') return true;
    S.status = 'loading';
    try {
        const root = await new FBXLoader().loadAsync(base + 'rebel.fbx');

        const tl = new THREE.TextureLoader();
        tl.setCrossOrigin('anonymous');
        const tex = {};
        await Promise.all([...new Set(TEXTURES.map(([, f]) => f))].map(f =>
            new Promise(res => tl.load(base + f, t => { tex[f] = t; res(); }, undefined, () => res(null)))
        ));

        const bones = {};
        root.traverse(o => {
            if (!o.isMesh) return;
            S.parts++;
            S.tris += (o.geometry.index ? o.geometry.index.count
                : o.geometry.attributes.position.count) / 3;
            o.castShadow = true;
            o.receiveShadow = true;
            // A skinned mesh's bounds come from the bind pose and go stale once
            // limbs swing, so they are inflated rather than culled off — same fix
            // the GLB soldiers use (see character.js).
            if (o.isSkinnedMesh) {
                o.geometry.computeBoundingSphere();
                if (o.geometry.boundingSphere) o.geometry.boundingSphere.radius *= 2.2;
            }
            const list = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of list) {
                if (!m) continue;
                m.roughness = 0.86; m.metalness = 0;
                const hit = TEXTURES.find(([re]) => re.test(m.name || '') || re.test(o.name || ''));
                const t = hit && tex[hit[1]];
                if (t) {
                    t.colorSpace = THREE.SRGBColorSpace;
                    t.anisotropy = 4;
                    t.wrapS = t.wrapT = THREE.RepeatWrapping;
                    m.map = t;
                    if (m.color) m.color.setRGB(1, 1, 1);
                }
                m.needsUpdate = true;
            }
        });
        root.traverse(o => {
            const key = normBone(o.name);
            for (const b of BONES_LONG_FIRST) if (!bones[b] && key.endsWith(b.toLowerCase())) { bones[b] = o; break; }
        });

        // stand the rig up, then measure it: the size of a soldier is what the whole
        // scale/foot-offset pair is derived from, and a folded ragdoll measures a
        // different height. The matrices are primed by hand because a freshly loaded
        // FBX has never been rendered, so Box3.setFromObject() would otherwise read
        // the stale matrixWorld each node was built with.
        for (const [name, v] of Object.entries(STAND_FLIP)) {
            const b = bones[name]; if (!b) continue;
            b.rotation.x = v;
        }
        (function prime(o) { o.updateMatrix(); for (const c of o.children) prime(c); })(root);
        root.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(root);
        S.rawHeight = Math.max(0.001, box.max.y - box.min.y);
        root.scale.setScalar(TARGET_HEIGHT / S.rawHeight);
        root.position.y = 0;
        (function prime(o) { o.updateMatrix(); for (const c of o.children) prime(c); })(root);
        root.updateMatrixWorld(true);
        const box2 = new THREE.Box3().setFromObject(root);
        root.position.y = -box2.min.y;

        S.bones = Object.keys(bones).length;
        S.missing = BONES.filter(b => !bones[b]);
        if (S.bones < 8) throw new Error(`only ${S.bones} usable bones found`);
        S.proto = root;
        S.status = 'ready';
        return true;
    } catch (err) {
        S.status = 'failed';
        S.err = String((err && err.message) || err);
        console.warn('[rebel] model unavailable, soldiers stay as they were —', S.err);
        return false;
    }
}

/** The rig a bot should get, given the team it was built on. */
export function rigFor(team, weaponType) {
    if (S.status === 'ready' && (S.mode === 'all' || (S.mode === 'enemy' && team === TEAM_B))) {
        return new RebelSoldier(team, weaponType);
    }
    return charactersReady()
        ? new AnimatedSoldier(team, weaponType)
        : new SoldierRig(team, weaponType, (Math.random() * 5) | 0);
}

// ============================================================================
// THE RIG
// ============================================================================
const _wp = new THREE.Vector3();

// A team patch, because this model's own texture says nothing about who is who —
// and a soldier you cannot assign to a side is how Free For All got reported as
// "enemies I can't hit" in the first place.
const PATCH = {
    0: new THREE.MeshStandardMaterial({ color: 0x2a5590, roughness: 0.8 }),
    1: new THREE.MeshStandardMaterial({ color: 0x933024, roughness: 0.8 })
};
const PATCH_GEO = new THREE.BoxGeometry(0.055, 0.03, 0.006);

export class RebelSoldier {
    constructor(team, weaponType = 'rifle') {
        this.isRebel = true;
        this.team = team;
        this.root = new THREE.Group();

        this.model = skeletonClone(S.proto);
        this.root.add(this.model);

        this.bones = {};
        this.model.traverse(o => {
            const key = normBone(o.name);
            for (const b of BONES_LONG_FIRST) {
                if (!this.bones[b] && key.endsWith(b.toLowerCase())) { this.bones[b] = o; break; }
            }
        });
        // rest orientations, so a respawn starts from the file's pose and not the
        // last frame of a death
        this.rest = new Map();
        for (const [k, b] of Object.entries(this.bones)) this.rest.set(k, { q: b.quaternion.clone(), y: b.position.y });
        this.hipsRestY = this.bones.Hips ? this.bones.Hips.position.y : 0;

        // the death tilt lives on a group under root, because ai.js writes
        // root.position and root.rotation.y every frame
        this.tilt = new THREE.Group();
        this.root.remove(this.model);
        this.tilt.add(this.model);
        this.root.add(this.tilt);

        const chest = this.bones.Spine2 || this.bones.Spine1 || this.bones.Spine;
        if (chest) {
            const patch = new THREE.Mesh(PATCH_GEO, PATCH[team] || PATCH[1]);
            patch.position.set(0.11, 0.03, -0.13);
            chest.add(patch);
            this.patch = patch;
        }

        this.weaponType = null;
        this.weaponMount = new THREE.Group();
        this.root.add(this.weaponMount);
        this.muzzle = new THREE.Group();
        this.weaponMount.add(this.muzzle);
        this.setWeapon(weaponType);

        const flashMat = new THREE.MeshBasicMaterial({
            color: 0xffd27a, transparent: true, opacity: 0,
            depthWrite: false, blending: THREE.AdditiveBlending
        });
        this.flashA = new THREE.Mesh(new THREE.SphereGeometry(0.075, 6, 5), flashMat);
        this.flashB = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.22, 6), flashMat.clone());
        this.flashB.rotation.x = -Math.PI / 2;
        this.flashB.position.z = -0.12;
        this.muzzle.add(this.flashA, this.flashB);

        this.flashTimer = 0;
        this.deadT = -1;
        this._calibDone = false; this._calibN = 0; this._box = null;
        this.aimPitch = 0;
        this.lookYaw = 0;
        this.speed = 0;
        this.crouch = 0;
        this.phase = Math.random() * Math.PI * 2;   // desync so a squad does not march
        this._shadows = true;
        this._targets = {};
        for (const b of BONES) this._targets[b] = { x: 0, y: 0, z: 0 };
    }

    /**
     * Fit the soldier to TARGET_HEIGHT from the box it actually renders. The box
     * the loader hands over is not the box that gets drawn — this file arrives with
     * pivot offsets that only settle once the first matrices are composed, and a
     * soldier sized from the pre-settle number walks in at double height. Two or
     * three frames of correction, then it stops; the factor is written back to the
     * shared template so later bots are right on their first frame.
     */
    _calibrate() {
        if (this._calibDone) return;
        this._calibN = (this._calibN || 0) + 1;
        if (this._calibN % 2) return;
        const box = this._box || (this._box = new THREE.Box3());
        this.model.updateMatrixWorld(true);
        box.setFromObject(this.model);
        const h = box.max.y - box.min.y;
        if (!Number.isFinite(h) || h < 0.05) return;
        const f = fitFactor(h);
        if (!f || f === 1) { this._calibDone = true; this._box = null; return; }
        this.model.scale.multiplyScalar(f);
        this.model.position.y = -box.min.y * f;
        // the correction is written to the shared template once, so a soldier built
        // later is right on its first frame — and so that one pass is not applied
        // seven times over, once per bot, which would shrink the template to nothing
        if (!S.calibrated) {
            S.calibrated = true;
            S.drew = +h.toFixed(2);
            if (S.rawHeight > 0) { S.rawHeight *= f; S.proto.scale.multiplyScalar(f); }
        }
        if (this._calibN >= 6) { this._calibDone = true; this._box = null; }
    }

    setWeapon(type) {
        if (this.weaponType === type) return;
        if (this.weapon) {
            this.weaponMount.remove(this.weapon);
            this.weapon.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
        }
        this.weaponType = type;
        this.weapon = createWorldWeapon(type);
        const g = WEAPON_GRIPS[type] || WEAPON_GRIPS.rifle;
        this.weapon.position.copy(g.rear).negate();
        this.weaponMount.add(this.weapon);
        this.muzzle.position.copy(g.muzzle).sub(g.rear);
    }

    fireFlash() { this.flashTimer = 0.055; }

    startDeath() {
        this.deadT = 0;
        if (this.weapon) this.weapon.visible = false;        // dropped
        if (this.patch) this.patch.visible = false;
    }

    resetPose() {
        this.deadT = -1;
        this.speed = 0; this.crouch = 0;
        if (this.weapon) this.weapon.visible = true;
        if (this.patch) this.patch.visible = true;
        this.tilt.rotation.set(0, 0, 0);
        this.tilt.position.set(0, 0, 0);
        this.model.visible = true;
        for (const [k, b] of Object.entries(this.bones)) {
            const r = this.rest.get(k);
            if (!r) continue;
            b.quaternion.copy(r.q);
            b.position.y = r.y;
        }
        this.model.rotation.set(0, 0, 0);
        this.setOpacity(1);
        this.root.position.y = 0;
    }

    setShadows(on) {
        if (this._shadows === on) return;
        this._shadows = on;
        this.model.traverse(o => { if (o.isMesh) o.castShadow = on; });
    }

    setOpacity(v) {
        this.model.traverse(o => {
            if (!o.isMesh || !o.material) return;
            if (v < 1 && !o.material.transparent) {
                o.material = o.material.clone();
                o.material.transparent = true;
                // a faded soldier owns its clone, so it can be released
                (this._cloned || (this._cloned = new Set())).add(o.material);
            }
            if (o.material.transparent) o.material.opacity = v;
        });
    }

    /** state: { speed, aiming, crouching, aimPitch, lookYaw } — as AnimatedSoldier. */
    update(dt, state) {
        if (this.deadT >= 0) { this.deadT += dt; this._death(dt); return; }

        const speed = state.speed || 0;
        // smoothed: an AI stop is instantaneous, and snapping both legs to zero
        // mid-stride is what makes procedural rigs look broken
        this.speed += (speed - this.speed) * Math.min(1, dt * 8);
        this.crouch += ((state.crouching ? 1 : 0) - this.crouch) * Math.min(1, dt * 9);
        // stride phase tracks ground speed, so a soldier never takes steps that
        // do not match how fast it is actually moving
        if (this.speed > 0.3) this.phase += dt * this.speed * 1.95;

        const t = this._targets;
        for (const b of BONES) { const g = t[b]; g.x = g.y = g.z = 0; }

        const amp = Math.min(1, this.speed / RUN_SPEED);
        const swing = Math.sin(this.phase) * (0.30 + 0.72 * amp);
        const knee = (0.16 + 0.52 * amp) * (0.5 + 0.5 * Math.sin(this.phase));
        const armSwing = Math.sin(this.phase + Math.PI / 2) * (0.14 + 0.40 * amp);

        t.LeftUpLeg.x = swing; t.RightUpLeg.x = -swing;
        t.LeftLeg.x = -knee; t.RightLeg.x = -knee;
        t.LeftFoot.x = knee * 0.4; t.RightFoot.x = knee * 0.4;
        t.LeftToeBase.x = knee * 0.22; t.RightToeBase.x = knee * 0.22;
        // +rotation.x swings a flipped limb forwards — measured on the rig, since
        // the file's rest pose has the arms pointing the other way.
        t.LeftArm.x = armSwing + ARMS.swing; t.RightArm.x = -armSwing + ARMS.swing;
        t.LeftForeArm.x = ARMS.elbow + ARMS.elbowRun * amp;
        t.RightForeArm.x = ARMS.elbow + ARMS.elbowRun * amp;

        if (state.aiming) {
            // both hands forward, weapon on the line of aim: the right hand on the
            // grip, the left further out on the handguard
            t.RightArm.x = ARMS.aim.rightArm; t.RightForeArm.x = ARMS.aim.rightForeArm;
            t.LeftArm.x = ARMS.aim.leftArm; t.LeftForeArm.x = ARMS.aim.leftForeArm;
        }
        const c = this.crouch;
        if (c > 0.02) {
            t.Spine.x = 0.20 * c; t.Spine1.x = 0.10 * c;
            t.Hips.x = -0.16 * c;
            t.LeftUpLeg.x += 0.55 * c; t.RightUpLeg.x += 0.55 * c;
            t.LeftLeg.x -= 1.15 * c; t.RightLeg.x -= 1.15 * c;
            t.LeftFoot.x += 0.55 * c; t.RightFoot.x += 0.55 * c;
        }

        // aim rides on top of the pose, split up the chain like the GLB rig does
        const pitch = THREE.MathUtils.clamp(state.aimPitch || 0, -0.8, 0.8);
        const yaw = THREE.MathUtils.clamp(state.lookYaw || 0, -0.7, 0.7);
        this.aimPitch += (pitch - this.aimPitch) * Math.min(1, dt * 10);
        this.lookYaw += (yaw - this.lookYaw) * Math.min(1, dt * 10);
        t.Spine.x += this.aimPitch * 0.35; t.Spine.y += this.lookYaw * 0.35;
        t.Spine1.x += this.aimPitch * 0.40; t.Spine1.y += this.lookYaw * 0.30;
        t.Neck.x += this.aimPitch * 0.20;
        t.Head.x += this.aimPitch * 0.30; t.Head.y += this.lookYaw * 0.40;

        const k = 1 - Math.exp(-dt * 14);
        for (const name of BONES) {
            const b = this.bones[name]; if (!b) continue;
            const g = t[name];
            // the standing flip is part of the pose's zero, not a one-off nudge
            b.rotation.x += (g.x + (STAND_FLIP[name] || 0) - b.rotation.x) * k;
            b.rotation.y += (g.y - b.rotation.y) * k;
            b.rotation.z += (g.z - b.rotation.z) * k;
        }
        if (this.bones.Hips) {
            const bob = this.speed > 0.35
                ? Math.abs(Math.sin(this.phase)) * 0.045 * (0.4 + amp)
                : Math.sin(performance.now() * 0.0011 + this.phase) * 0.006;
            this.bones.Hips.position.y = this.hipsRestY + bob - c * 0.10;
        }

        this.model.updateMatrixWorld(true);
        this._calibrate();
        this._placeWeapon();
        this._flash(dt);
    }

    _placeWeapon() {
        if (!this.hand || !this.weapon) return;
        this.bones.RightHand.getWorldPosition(_wp);
        this.root.worldToLocal(_wp);
        this.weaponMount.position.set(_wp.x, _wp.y + 0.02, _wp.z - 0.04);
        this.weaponMount.rotation.set(this.aimPitch, 0, 0);
    }

    _flash(dt) {
        if (this.flashTimer > 0) {
            this.flashTimer -= dt;
            const o = Math.max(0, this.flashTimer / 0.055);
            const s = 0.8 + Math.random() * 0.7;
            this.flashA.material.opacity = o;
            this.flashB.material.opacity = o * 0.9;
            this.flashA.scale.setScalar(s);
            this.flashB.scale.set(s, 1, s);
        } else if (this.flashA.material.opacity !== 0) {
            this.flashA.material.opacity = 0;
            this.flashB.material.opacity = 0;
        }
    }

    /**
     * No death clip to play, so the body is folded instead: hips drop, torso
     * pitches forward, then it fades on the GLB rig's schedule so ai.js's
     * "hide it after 5 s" rule still lines up.
     */
    _death(dt) {
        const t = Math.min(1, this.deadT / 0.85);
        const e = 1 - Math.pow(1 - t, 3);
        this.tilt.rotation.x = -1.35 * e;
        this.tilt.position.y = -0.30 * e;
        this.model.rotation.z = 0.25 * e;
        if (this.deadT > 4.0) this.setOpacity(Math.max(0, 1 - (this.deadT - 4.0)));
    }

    muzzleWorld(out) {
        this.muzzle.updateWorldMatrix(true, false);
        return out.setFromMatrixPosition(this.muzzle.matrixWorld);
    }

    dispose() {
        // the geometry and materials are shared with the template, so only the
        // per-instance weapon goes — disposing the rest would blank every soldier
        if (this.weapon) this.weapon.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
        this.flashA.material.dispose();
        this.flashB.material.dispose();
        if (this._cloned) for (const m of this._cloned) m.dispose();
    }

    get hand() { return this.bones.RightHand || null; }
}

