// ============================================================================
// vmassets.js — photoreal GLB weapons and gloved hands for the first-person view.
//
// The procedural guns in weapons.js already sit in a coordinate frame that the
// whole viewmodel depends on: barrel down -Z, receiver near the origin, a
// userData.sight point that ADS aligns to the camera axis, plus grip anchors.
// Rather than invent numbers for the generated meshes, each one is fitted ONTO
// that existing frame — same length, same orientation, same centre — so recoil,
// sway, ADS alignment and reload motion keep working untouched.
//
// Everything here is optional. If a file is missing the procedural model stays.
// ============================================================================
import * as THREE from 'three';
import { createWorldWeapon, WEAPON_GRIPS } from './weapons.js';
import { glbLoader } from './glb.js';

const FILES = {
    rifle: 'wpn_rifle.glb', smg: 'wpn_smg.glb', sniper: 'wpn_sniper.glb',
    shotgun: 'wpn_shotgun.glb', pistol: 'wpn_pistol.glb'
};
const HANDS = { right: 'hand_right.glb', left: 'hand_left.glb' };

// Elbow-to-fingertip, used to scale the generated arms to life size.
const FOREARM_LEN = 0.42;

const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _size = new THREE.Vector3();

function longestAxis(size) {
    if (size.x >= size.y && size.x >= size.z) return 'x';
    return size.y >= size.z ? 'y' : 'z';
}

/**
 * Which end of the barrel axis is the muzzle?
 *
 * Uses the vertex centroid rather than end thickness. A firearm's mass is
 * concentrated at the receiver, stock and magazine; the barrel is a thin tube
 * carrying very few vertices. So the centroid always sits toward the STOCK, and
 * the muzzle is the opposite side. That is a far more stable signal than
 * comparing end heights, which misread three of the four guns last time —
 * a scope, a bipod or a folding stock all defeat a height comparison.
 *
 * @returns {number} +1 if the muzzle is on the +axis side, -1 otherwise
 */
function muzzleSign(root, axis) {
    root.updateMatrixWorld(true);
    _box.setFromObject(root);
    const mid = (_box.min[axis] + _box.max[axis]) / 2;

    let sum = 0, count = 0;
    root.traverse(o => {
        if (!o.isMesh || !o.geometry.attributes.position) return;
        const pos = o.geometry.attributes.position;
        // sampling is plenty for a centroid and keeps this cheap on dense meshes
        const stride = Math.max(1, Math.floor(pos.count / 4000));
        for (let i = 0; i < pos.count; i += stride) {
            _v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
            sum += _v[axis];
            count++;
        }
    });
    if (!count) return -1;
    const centroid = sum / count;
    return centroid > mid ? -1 : 1;
}

/**
 * How far the vertex centroid sits behind the bounding-box centre, along Z.
 *
 * Must be measured RELATIVE to the box centre. Taking the absolute centroid
 * instead makes the result dominated by wherever the weapon happens to be
 * placed in the group (roughly -0.5 for every gun), which reads negative no
 * matter which way the mesh faces — that mistake flipped all four weapons,
 * including the ones that were already correct.
 *
 * Positive means mass is toward +Z, i.e. the stock is at the rear as it should
 * be when the muzzle points down -Z.
 */
function centroidZ(root) {
    root.updateMatrixWorld(true);
    _box.setFromObject(root);
    const mid = (_box.min.z + _box.max.z) / 2;
    let sum = 0, count = 0;
    root.traverse(o => {
        if (!o.isMesh || !o.geometry.attributes.position) return;
        const pos = o.geometry.attributes.position;
        const stride = Math.max(1, Math.floor(pos.count / 4000));
        for (let i = 0; i < pos.count; i += stride) {
            _v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
            sum += _v.z;
            count++;
        }
    });
    return count ? (sum / count) - mid : 0;
}

/** Fit a generated weapon onto the procedural model's frame. */
function fitWeapon(gen, type) {
    // reference frame: the procedural gun this replaces
    const ref = createWorldWeapon(type);
    ref.updateMatrixWorld(true);
    const refBox = new THREE.Box3().setFromObject(ref);
    const refSize = refBox.getSize(new THREE.Vector3());
    const refCentre = refBox.getCenter(new THREE.Vector3());
    ref.traverse(o => { if (o.isMesh) o.geometry.dispose(); });

    const holder = new THREE.Group();
    const inner = new THREE.Group();
    holder.add(inner);
    inner.add(gen);

    gen.updateMatrixWorld(true);
    _box.setFromObject(gen);
    _box.getSize(_size);
    const axis = longestAxis(_size);
    const sign = muzzleSign(gen, axis);

    // Rotate the barrel axis onto -Z with the muzzle forward.
    // Signs derived rather than guessed: R_y(t) maps (1,0,0) to (cos t,0,-sin t),
    // so sending +X to -Z needs t = +PI/2, and -X needs t = -PI/2. Likewise
    // R_x(t) maps (0,1,0) to (0,cos t,sin t), so +Y to -Z needs t = -PI/2.
    if (axis === 'x') gen.rotation.y = sign > 0 ? Math.PI / 2 : -Math.PI / 2;
    else if (axis === 'z') { if (sign > 0) gen.rotation.y = Math.PI; }
    else gen.rotation.x = sign > 0 ? -Math.PI / 2 : Math.PI / 2;

    // scale so the barrel length matches the reference exactly
    gen.updateMatrixWorld(true);
    _box.setFromObject(gen);
    _box.getSize(_size);
    const s = _size.z > 1e-6 ? refSize.z / _size.z : 1;
    gen.scale.multiplyScalar(s);

    // centre it on the reference's centre so grips and sight line up
    gen.updateMatrixWorld(true);
    _box.setFromObject(gen);
    const c = _box.getCenter(_v);
    gen.position.sub(c).add(refCentre);

    // ── self-check on orientation ──
    // With the muzzle at -Z the weapon's mass — receiver, stock, magazine —
    // must sit at +Z. If the centroid is forward of centre the inference was
    // wrong, so flip about the WORLD up axis and re-centre. (rotateY is local
    // space, and by this point the mesh already carries an alignment rotation,
    // so using it here silently did nothing.)
    if (centroidZ(gen) < 0) {
        gen.rotateOnWorldAxis(WORLD_UP, Math.PI);
        gen.updateMatrixWorld(true);
        _box.setFromObject(gen);
        gen.position.sub(_box.getCenter(_v)).add(refCentre);
        gen.updateMatrixWorld(true);
        holder.userData.flipped = true;
    }
    // hand-pinned correction where the centroid test is known to misread
    const fix = ORIENT_FIX[type];
    if (fix) {
        gen.rotateOnWorldAxis(WORLD_UP, fix);
        gen.updateMatrixWorld(true);
        _box.setFromObject(gen);
        gen.position.sub(_box.getCenter(_v)).add(refCentre);
        gen.updateMatrixWorld(true);
        holder.userData.pinned = true;
    }
    holder.userData.centroidZ = +centroidZ(gen).toFixed(4);

    holder.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = false;
        o.receiveShadow = false;
        o.frustumCulled = false;
        const m = o.material;
        if (!m) return;
        // Generated PBR comes back glossy enough to look wet under a bright
        // desert sky. Firearm finishes are matte-to-satin, so floor the
        // roughness and keep metalness modest.
        m.envMapIntensity = 0.75;
        if (m.roughness !== undefined) m.roughness = Math.max(0.42, m.roughness);
        if (m.metalness !== undefined) m.metalness = Math.min(0.35, Math.max(0.15, m.metalness));
    });
    return holder;
}

/**
 * Normalise a generated arm into a canonical pose:
 *   origin  = the hand / grip point
 *   +Z      = along the forearm, pointing back toward the elbow
 *   length  = FOREARM_LEN
 *
 * Doing this by construction — rather than dialling in Euler angles — is what
 * stops the arm crossing in front of the camera. Once the arm points its +Z at
 * the shoulder, it always runs off the bottom of the screen the way it should.
 */
function fitHand(gen, side) {
    const holder = new THREE.Group();
    const pivot = new THREE.Group();
    holder.add(pivot);
    pivot.add(gen);

    gen.updateMatrixWorld(true);
    _box.setFromObject(gen);
    _box.getSize(_size);
    const axis = longestAxis(_size);

    // The sleeve end is bulkier than the fingers, so the thicker end is the
    // elbow. Same discriminator used for the weapon muzzle.
    const min = _box.min[axis], max = _box.max[axis], span = max - min;
    const loEdge = min + span * 0.22, hiEdge = max - span * 0.22;
    let loMin = Infinity, loMax = -Infinity, hiMin = Infinity, hiMax = -Infinity;
    const other = axis === 'y' ? 'z' : 'y';
    gen.traverse(o => {
        if (!o.isMesh) return;
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            _v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
            const a = _v[axis], h = _v[other];
            if (a <= loEdge) { if (h < loMin) loMin = h; if (h > loMax) loMax = h; }
            else if (a >= hiEdge) { if (h < hiMin) hiMin = h; if (h > hiMax) hiMax = h; }
        }
    });
    const elbowOnPositiveSide = (hiMax - hiMin) > (loMax - loMin);

    // rotate the elbow direction onto +Z
    if (axis === 'x') gen.rotation.y = elbowOnPositiveSide ? -Math.PI / 2 : Math.PI / 2;
    else if (axis === 'y') gen.rotation.x = elbowOnPositiveSide ? Math.PI / 2 : -Math.PI / 2;
    else if (!elbowOnPositiveSide) gen.rotation.y = Math.PI;

    gen.updateMatrixWorld(true);
    _box.setFromObject(gen);
    _box.getSize(_size);
    const s = _size.z > 1e-6 ? FOREARM_LEN / _size.z : 1;
    gen.scale.setScalar(s);

    // slide the hand end (now the -Z extreme) onto the origin
    gen.updateMatrixWorld(true);
    _box.setFromObject(gen);
    gen.position.x -= (_box.min.x + _box.max.x) / 2;
    gen.position.y -= (_box.min.y + _box.max.y) / 2;
    gen.position.z -= _box.min.z;

    holder.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false;
        if (o.material) o.material.envMapIntensity = 0.9;
    });
    holder.userData.side = side;
    holder.userData.pivot = pivot;
    return holder;
}

class VMAssets {
    constructor() {
        this.weapons = {};
        this.hands = {};
        this.ready = false;
        this.failed = false;
        this._promise = null;
    }

    load(base = 'assets/models/') {
        if (this._promise) return this._promise;
        this._promise = this._load(base).catch(err => {
            console.warn('[vmassets] photoreal viewmodels unavailable —', err.message);
            this.failed = true;
            return false;
        });
        return this._promise;
    }

    async _load(base) {
        const loader = glbLoader();
        const get = url => new Promise((res, rej) =>
            loader.load(url, res, undefined, () => rej(new Error('missing ' + url))));

        const wEntries = Object.entries(FILES);
        const wResults = await Promise.all(wEntries.map(([, f]) => get(base + f).catch(() => null)));
        for (let i = 0; i < wEntries.length; i++) {
            const g = wResults[i];
            if (!g) continue;
            const type = wEntries[i][0];
            try { this.weapons[type] = fitWeapon(g.scene, type); }
            catch (e) { console.warn('[vmassets] could not fit', type, e.message); }
        }

        const hEntries = Object.entries(HANDS);
        const hResults = await Promise.all(hEntries.map(([, f]) => get(base + f).catch(() => null)));
        for (let i = 0; i < hEntries.length; i++) {
            const g = hResults[i];
            if (!g) continue;
            try { this.hands[hEntries[i][0]] = fitHand(g.scene, hEntries[i][0]); }
            catch (e) { console.warn('[vmassets] could not fit hand', e.message); }
        }

        if (!Object.keys(this.weapons).length) throw new Error('no weapon meshes loaded');
        this.ready = true;
        return true;
    }

    /** A fresh instance of a fitted weapon, or null. */
    weapon(type) {
        const src = this.weapons[type];
        return src ? src.clone(true) : null;
    }

    hand(side) {
        const src = this.hands[side];
        return src ? src.clone(true) : null;
    }

    has(type) { return !!this.weapons[type]; }
}

export const vmAssets = new VMAssets();
export function vmAssetsReady() { return vmAssets.ready && !vmAssets.failed; }
export { WEAPON_GRIPS };

// Where the player's shoulders sit relative to the camera, in viewmodel space:
// behind, below and out to the side. Each arm is aimed at its own shoulder so
// the forearm runs off the bottom of the frame like every FPS you have played.
const SHOULDER = {
    right: new THREE.Vector3(0.20, -0.44, 0.34),
    left: new THREE.Vector3(-0.20, -0.42, 0.30)
};
// A small roll about the forearm axis so the back of the hand faces outward.
const HAND_ROLL = { right: -0.35, left: 0.45 };

const _dir = new THREE.Vector3();
const _q2 = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 0, 1);
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// How far in front of the eye the sight sits when aimed. Slightly longer than
// the procedural value because these models are physically chunkier.
const ADS_EYE_RELIEF = -0.30;

// Where the weapon's centre of mass sits when hipfiring: right of the eye line,
// below it, and close enough to fill the lower-right of the frame the way an
// FPS viewmodel should.
const HIP_TARGET = new THREE.Vector3(0.135, -0.150, -0.345);

/**
 * Per-weapon corrections applied after the automatic fit.
 *
 * The centroid test infers the muzzle end from where a weapon's mass sits, and
 * that holds for a rifle, a bolt gun and a shotgun. It does NOT hold for a
 * compact SMG: the MP5's magazine hangs forward of the grip and its stock
 * collapses, so its mass sits toward the FRONT and the test reads it backwards.
 * Observed on screen, so pinned here rather than left to the heuristic.
 */
const ORIENT_FIX = {
    smg: Math.PI
};

/**
 * What kind of sight each weapon presents when aimed.
 *   reddot — illuminated dot on glass
 *   iron   — rear aperture ring plus a front post, no illumination
 *   scope  — no mesh sight at all; the HUD scope overlay is the sight
 */
const SIGHT_STYLE = {
    rifle: 'reddot',
    smg: 'iron',
    shotgun: 'iron',
    pistol: 'iron',
    sniper: 'scope'
};

/**
 * Locate the optic / rear sight on a fitted weapon.
 *
 * Scans the rear 60% of the weapon (everything behind the handguard) for the
 * highest vertex, which on every one of these models is the top of the sight.
 * Returns a point just below that peak — the glass sits under the housing —
 * expressed in the weapon group's space.
 */
function findSightPoint(root) {
    root.updateMatrixWorld(true);
    _box.setFromObject(root);
    const zRearLimit = _box.max.z;
    const zFrontLimit = _box.min.z + (_box.max.z - _box.min.z) * 0.40;
    let bestY = -Infinity, bestX = 0, bestZ = 0, found = false;

    root.traverse(o => {
        if (!o.isMesh || !o.geometry.attributes.position) return;
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            _v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
            if (_v.z < zFrontLimit || _v.z > zRearLimit) continue;
            if (_v.y > bestY) { bestY = _v.y; bestX = _v.x; bestZ = _v.z; found = true; }
        }
    });
    if (!found) return null;
    // the aim axis runs through the middle of the optic, not its roof
    return new THREE.Vector3(bestX, bestY - 0.022, bestZ);
}

/**
 * Replace a viewmodel's procedural gun and hands with the photoreal meshes,
 * in place. Anchor groups (muzzle, optic, mag, charging handle) and the
 * userData.sight point survive, so ADS alignment, recoil and reload motion are
 * completely unaffected — only what you SEE changes.
 *
 * Returns false and leaves the viewmodel untouched if the assets are absent.
 */
export function applyPhotoreal(vm) {
    if (!vmAssetsReady() || !vm || !vm.parts) return false;
    const { parts, def } = vm;
    const gunMesh = vmAssets.weapon(def.type);
    if (!gunMesh) return false;

    // The muzzle flash quads live under parts.muzzle and must be kept — they
    // are meshes too, and stripping them would silence the flash.
    const keep = new Set();
    if (parts.muzzle) parts.muzzle.traverse(o => keep.add(o));

    const doomed = [];
    parts.gun.traverse(o => { if (o.isMesh && !keep.has(o)) doomed.push(o); });
    for (const o of doomed) {
        if (o.parent) o.parent.remove(o);
        o.geometry?.dispose();
    }

    parts.gun.add(gunMesh);
    parts.photoreal = true;

    // ── re-derive the sight line from the mesh we actually put on screen ──
    // The procedural anchor described the procedural optic. Inheriting it puts
    // the real optic off-centre when aiming, which is the one thing ADS cannot
    // get wrong. Find the highest geometry over the receiver — that is the
    // optic — and aim through it.
    // ── the sight line stays the PROCEDURAL one ──
    // Detecting the optic from the mesh does not work: findSightPoint takes the
    // highest geometry over the receiver, and on the MP5 and SPAS that is the
    // stock, not the sight — which put the aim point behind the gun. The
    // procedural anchor is correct by construction, and because the generated
    // mesh is fitted into the procedural model's exact bounding box, that point
    // lands on the real optic anyway. So leave parts.sight and parts.adsPos
    // alone, and hang the reticle off them.
    attachReticle(parts, parts.sight, def);

    // ── hip pose, derived from where the mesh actually is ──
    // hipPos was tuned around the procedural gun's centre of mass. These models
    // sit differently inside the group, and inheriting the old offset pushed
    // the weapon a metre out and off the right edge of the screen. Place the
    // measured centre at a fixed, COD-like point in view instead.
    gunMesh.updateMatrixWorld(true);
    _box.setFromObject(gunMesh);
    const centre = _box.getCenter(_v);
    parts.hipPos.set(
        HIP_TARGET.x - centre.x,
        HIP_TARGET.y - centre.y,
        HIP_TARGET.z - centre.z
    );
    parts.orientFlipped = !!gunMesh.userData.flipped;
    parts.centroidZ = gunMesh.userData.centroidZ;

    // The anchors sit inside the gun group, which the viewmodel then moves as a
    // whole. Aim each arm from its grip anchor at the matching shoulder, in the
    // gun group's own space, so the geometry is right whatever pose the gun is
    // in.
    for (const side of ['right', 'left']) {
        const anchor = side === 'right' ? parts.handR : parts.handL;
        if (!anchor) continue;                       // pistols carry no support hand
        const mesh = vmAssets.hand(side);
        if (!mesh) continue;

        // shoulder expressed relative to this anchor, undoing the anchor's own
        // rotation so the aim is not double-counted
        anchor.updateMatrixWorld(true);
        _dir.copy(SHOULDER[side]).sub(anchor.getWorldPosition(_v));
        anchor.getWorldQuaternion(_q2);
        _dir.applyQuaternion(_q2.invert()).normalize();

        mesh.quaternion.setFromUnitVectors(_up, _dir);
        mesh.rotateZ(HAND_ROLL[side]);
        mesh.position.set(0, 0, 0);
        anchor.add(mesh);
    }
    return true;
}

/**
 * Build the aiming reference for a photoreal weapon: a glass pane, a hooded
 * ring and a floating dot, all sitting on the sight line the fitter found.
 *
 * The dot is depth-test-free and additively blended so it reads against any
 * background, and the whole assembly only shows once you are most of the way
 * into the aim — at the hip it would just be a red speck floating over the gun.
 */
function attachReticle(parts, sight, def) {
    const g = new THREE.Group();
    g.position.copy(sight);
    parts.gun.add(g);

    const style = SIGHT_STYLE[def.type] || 'reddot';
    const steel = new THREE.MeshStandardMaterial({ color: 0x121416, roughness: 0.55, metalness: 0.5 });

    let aimPoint;

    if (style === 'iron') {
        // Rear aperture ring with a front post standing in it — no glass, no
        // illumination. This is what an MP5 or a shotgun actually gives you.
        const r = 0.013;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.22, 6, 20), steel);
        g.add(ring);

        const post = new THREE.Mesh(new THREE.BoxGeometry(0.0022, r * 1.05, 0.0022), steel);
        post.position.set(0, -r * 0.5, -0.16);          // out at the muzzle end
        g.add(post);
        // protective wings either side of the front post
        for (const sx of [-1, 1]) {
            const wing = new THREE.Mesh(new THREE.BoxGeometry(0.0016, r * 0.9, 0.0016), steel);
            wing.position.set(sx * 0.007, -r * 0.55, -0.16);
            g.add(wing);
        }
        aimPoint = post;
    } else {
        // illuminated red dot on tinted glass
        const r = 0.021;
        const glass = new THREE.Mesh(
            new THREE.CircleGeometry(r, 20),
            new THREE.MeshBasicMaterial({
                color: 0x24333c, transparent: true, opacity: 0.30,
                depthWrite: false, side: THREE.DoubleSide
            })
        );
        glass.position.z = -0.004;
        g.add(glass);
        g.add(new THREE.Mesh(new THREE.TorusGeometry(r, r * 0.13, 6, 22), steel));

        const dot = new THREE.Mesh(
            new THREE.CircleGeometry(0.0020, 12),
            new THREE.MeshBasicMaterial({
                color: 0xff2d18, transparent: true, opacity: 0.95,
                blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false
            })
        );
        dot.position.z = -0.006;
        dot.renderOrder = 999;
        g.add(dot);
        aimPoint = dot;
    }

    parts.reticle = aimPoint;
    parts.sightStyle = style;
    parts.reticleGroup = g;
    g.visible = false;                    // revealed by the viewmodel as ADS engages
    return g;
}

/** Live tuning hooks used by the calibration page. */
export function shoulderAnchors() { return SHOULDER; }
export function handRoll() { return HAND_ROLL; }
