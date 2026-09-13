// ============================================================================
// character.js — skinned GLB soldiers.
//
// Loads one rigged mesh per team plus a set of animation-only GLBs, and drives
// them with an AnimationMixer. The generated rig is a standard 24-bone humanoid
// (Hips / Spine / Spine01 / Spine02 / neck / Head / {Left,Right}{Shoulder,Arm,
// ForeArm,Hand} / legs), so clips retarget by bone name.
//
// Two things the canned clips cannot know are handled on top of the mixer:
//   • where the soldier is aiming — applied as an additive spine/head rotation
//     AFTER mixer.update(), otherwise the mixer overwrites it every frame;
//   • which weapon is held — parented to the RightHand bone.
//
// This is a drop-in alternative to the procedural SoldierRig in soldier.js.
// If the assets are missing, nothing here runs and the procedural rig is used.
// ============================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { createWorldWeapon, WEAPON_GRIPS } from './weapons.js';

const TARGET_HEIGHT = 1.8;

// The generator authors characters facing +Z; the game's convention is -Z.
const MODEL_YAW = Math.PI;

const CLIP_FILES = {
    idle: 'anim_idle.glb',
    walk: 'anim_walk.glb',
    run: 'anim_run.glb',
    crouch: 'anim_crouch.glb',
    death: 'anim_death.glb'
};
// Locomotion clips travel; the game owns position, so their horizontal root
// motion is removed. Death keeps its motion — the body should fall.
const IN_PLACE = new Set(['walk', 'run', 'crouch', 'idle']);

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _box = new THREE.Box3();
const _wp = new THREE.Vector3();

// ============================================================================
// LOADER
// ============================================================================
class Assets {
    constructor() {
        this.ready = false;
        this.failed = false;
        this.teams = [null, null];      // gltf.scene per team
        this.clips = {};                // name -> AnimationClip
        this._promise = null;
    }

    load(base = 'assets/models/') {
        if (this._promise) return this._promise;
        this._promise = this._load(base).catch(err => {
            console.warn('[character] GLB soldiers unavailable, using procedural rig —', err.message);
            this.failed = true;
            return false;
        });
        return this._promise;
    }

    async _load(base) {
        const loader = new GLTFLoader();
        const get = url => new Promise((res, rej) =>
            loader.load(url, res, undefined, () => rej(new Error('missing ' + url))));

        const [blue, red] = await Promise.all([
            get(base + 'soldier_blue.glb'),
            get(base + 'soldier_red.glb')
        ]);
        this.teams[0] = this._prepare(blue.scene);
        this.teams[1] = this._prepare(red.scene);

        const names = Object.keys(CLIP_FILES);
        const loaded = await Promise.all(names.map(n => get(base + CLIP_FILES[n]).catch(() => null)));
        for (let i = 0; i < names.length; i++) {
            const g = loaded[i];
            if (!g || !g.animations.length) continue;
            const clip = g.animations[0];
            clip.name = names[i];
            if (IN_PLACE.has(names[i])) stripRootMotion(clip);
            this.clips[names[i]] = clip;
        }
        if (!this.clips.idle) throw new Error('no idle clip');

        this.ready = true;
        return true;
    }

    /** Normalise scale and origin so the model is 1.8 m with feet at y = 0. */
    _prepare(scene) {
        scene.updateMatrixWorld(true);
        _box.setFromObject(scene);
        const height = _box.max.y - _box.min.y;
        const s = height > 0.001 ? TARGET_HEIGHT / height : 1;
        scene.scale.multiplyScalar(s);
        scene.updateMatrixWorld(true);
        _box.setFromObject(scene);
        scene.position.y -= _box.min.y;

        scene.traverse(o => {
            if (!o.isMesh) return;
            o.castShadow = true;
            o.receiveShadow = true;
            // Keep frustum culling ON. Disabling it meant all nine soldiers —
            // 15k triangles each, 85% of the scene — were skinned and drawn
            // every frame even when stood behind you. The reason it was off is
            // that a skinned mesh's bounds are computed from the bind pose and
            // go stale once limbs swing out, so instead of switching culling
            // off we inflate the sphere to cover any pose.
            if (o.isSkinnedMesh) {
                o.geometry.computeBoundingSphere();
                if (o.geometry.boundingSphere) o.geometry.boundingSphere.radius *= 2.2;
            }
            const m = o.material;
            if (m) {
                m.roughness = 0.86;              // generated materials come back shiny
                m.metalness = 0.0;
                if (m.map) m.map.anisotropy = 4;
            }
        });
        return scene;
    }
}

/** Zero the horizontal component of the hips position track. */
function stripRootMotion(clip) {
    for (const track of clip.tracks) {
        if (!track.name.endsWith('.position')) continue;
        const bone = track.name.split('.')[0];
        if (!/hips|armature/i.test(bone)) continue;
        const v = track.values;
        // keep Y (bob and crouch height), flatten X and Z to their first frame
        const x0 = v[0], z0 = v[2];
        for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
    }
}

export const characterAssets = new Assets();

// ============================================================================
// ONE ANIMATED SOLDIER
// ============================================================================
export class AnimatedSoldier {
    constructor(team, weaponType = 'rifle') {
        const src = characterAssets.teams[team] || characterAssets.teams[0];
        this.root = new THREE.Group();

        this.model = skeletonClone(src);
        this.model.rotation.y = MODEL_YAW;
        this.root.add(this.model);

        // bone lookup
        this.bones = {};
        this.model.traverse(o => {
            if (o.isBone || o.isObject3D) this.bones[o.name] = o;
        });
        this.hand = this.bones.RightHand || null;
        this.spineA = this.bones.Spine01 || this.bones.Spine || null;
        this.spineB = this.bones.Spine02 || null;
        this.head = this.bones.Head || null;

        // rest orientations, so additive aim is applied relative to the clip
        this._rest = new Map();
        for (const b of [this.spineA, this.spineB, this.head]) {
            if (b) this._rest.set(b, b.quaternion.clone());
        }

        this.mixer = new THREE.AnimationMixer(this.model);
        this.actions = {};
        for (const [name, clip] of Object.entries(characterAssets.clips)) {
            const a = this.mixer.clipAction(clip);
            if (name === 'death') { a.loop = THREE.LoopOnce; a.clampWhenFinished = true; }
            this.actions[name] = a;
        }
        this.currentState = null;
        this._play('idle', 0);

        // The weapon hangs off the ROOT, not off the hand bone. Parenting to a
        // bone would inherit the armature's 0.01 scale (rendering the rifle
        // 100x too small) and would bake the clip's hand rotation into the
        // barrel — so a bot shooting you from the side would visibly aim
        // somewhere else. Instead the hand drives position only, and the barrel
        // is oriented from the actual aim direction every frame.
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
        this.aimPitch = 0;
        this.lookYaw = 0;
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
        // shift the weapon so its rear grip sits exactly on the mount origin,
        // which is what gets placed in the hand
        this.weapon.position.copy(g.rear).negate();
        this.weaponMount.add(this.weapon);
        this.muzzle.position.copy(g.muzzle).sub(g.rear);
    }

    /** Place the weapon in the hand and point it where the soldier is aiming. */
    _placeWeapon() {
        if (!this.hand) return;
        this.hand.getWorldPosition(_wp);
        this.root.worldToLocal(_wp);
        // nudge forward and up out of the wrist so the grip reads in the palm
        this.weaponMount.position.set(_wp.x, _wp.y + 0.02, _wp.z - 0.04);
        // root space forward is -Z, so identity already points down-range
        this.weaponMount.rotation.set(this.aimPitch, 0, 0);
    }

    _play(name, fade = 0.18) {
        const next = this.actions[name];
        if (!next || this.currentState === name) return;
        const prev = this.actions[this.currentState];
        next.reset();
        next.enabled = true;
        next.setEffectiveWeight(1);
        if (prev && fade > 0) {
            next.crossFadeFrom(prev, fade, false).play();
        } else {
            if (prev) prev.stop();
            next.play();
        }
        this.currentState = name;
    }

    fireFlash() { this.flashTimer = 0.055; }

    startDeath() {
        this.deadT = 0;
        if (this.actions.death) {
            for (const k in this.actions) if (k !== 'death') this.actions[k].stop();
            this.actions.death.reset();
            this.actions.death.setEffectiveTimeScale(1.15);
            this.actions.death.play();
            this.currentState = 'death';
        }
        if (this.weapon) this.weapon.visible = false;   // dropped
    }

    resetPose() {
        this.deadT = -1;
        if (this.weapon) this.weapon.visible = true;
        for (const k in this.actions) this.actions[k].stop();
        this.currentState = null;
        this._play('idle', 0);
        this.root.rotation.set(0, this.root.rotation.y, 0);
        this.root.position.y = 0;
        this.model.visible = true;
        this.setOpacity(1);
    }

    /**
     * Shadow casting is the single most expensive thing a soldier does: the
     * shadow pass re-skins the whole mesh a second time. A soldier's own shadow
     * is barely readable past ~22 m, so we stop paying for it. Guarded on a
     * change because writing castShadow every frame dirties render state.
     */
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
            }
            if (o.material.transparent) o.material.opacity = v;
        });
    }

    /** state: { speed, aiming, crouching, aimPitch, lookYaw } */
    update(dt, state) {
        if (this.deadT >= 0) {
            this.deadT += dt;
            this.mixer.update(dt);
            if (this.deadT > 4.0) this.setOpacity(Math.max(0, 1 - (this.deadT - 4.0)));
            return;
        }

        const speed = state.speed || 0;
        const want = state.crouching ? 'crouch'
            : speed > 4.6 ? 'run'
            : speed > 0.35 ? 'walk'
            : 'idle';
        this._play(want);

        // keep stride roughly in step with real ground speed
        const a = this.actions[want];
        if (a) {
            if (want === 'walk') a.setEffectiveTimeScale(THREE.MathUtils.clamp(speed / 3.2, 0.55, 1.7));
            else if (want === 'run') a.setEffectiveTimeScale(THREE.MathUtils.clamp(speed / 5.6, 0.7, 1.5));
            else if (want === 'crouch') a.setEffectiveTimeScale(THREE.MathUtils.clamp(speed / 2.0, 0.5, 1.6));
            else a.setEffectiveTimeScale(1);
        }

        this.mixer.update(dt);

        // ── additive aim, applied after the mixer has written the pose ──
        const pitch = THREE.MathUtils.clamp(state.aimPitch || 0, -0.8, 0.8);
        const yaw = THREE.MathUtils.clamp(state.lookYaw || 0, -0.7, 0.7);
        this.aimPitch += (pitch - this.aimPitch) * Math.min(1, dt * 10);
        this.lookYaw += (yaw - this.lookYaw) * Math.min(1, dt * 10);

        this._addRotation(this.spineA, this.aimPitch * 0.35, this.lookYaw * 0.35);
        this._addRotation(this.spineB, this.aimPitch * 0.40, this.lookYaw * 0.30);
        this._addRotation(this.head, this.aimPitch * 0.30, this.lookYaw * 0.40);

        // the hand has now been posed for this frame, so read it for the weapon
        this.model.updateMatrixWorld(true);
        this._placeWeapon();

        // ── muzzle flash ──
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
     * Rotate a bone on top of whatever the clip put there. The rig's bones are
     * Z-up in their own space, so pitch is about X and yaw about Y of the bone,
     * composed onto the animated quaternion rather than replacing it.
     */
    _addRotation(bone, pitch, yaw) {
        if (!bone) return;
        _e.set(pitch, yaw, 0, 'XYZ');
        _q.setFromEuler(_e);
        bone.quaternion.multiply(_q);
    }

    muzzleWorld(out) {
        this.muzzle.updateWorldMatrix(true, false);
        return out.setFromMatrixPosition(this.muzzle.matrixWorld);
    }

    dispose() {
        this.mixer.stopAllAction();
        this.mixer.uncacheRoot(this.model);
        if (this.weapon) this.weapon.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
        this.flashA.geometry.dispose();
        this.flashB.geometry.dispose();
    }
}

/** True once the GLB soldiers can be instantiated. */
export function charactersReady() {
    return characterAssets.ready && !characterAssets.failed;
}
