// ============================================================================
// assets.js — optional GLB layer on top of the procedural models.
//
// Everything in here is a bonus.  The game is complete and correct with the
// procedural soldiers and weapons; if a .glb is missing, corrupt, served over
// file:// or simply slow, every entry point here returns null and the caller
// keeps whatever it already built.  Nothing in this module throws and nothing
// in it is ever awaited during startup.
//
// Loading is lazy: the first call to preload / whenReady / isReady /
// getCharacter / getWeapon kicks it off.  A caller that never asks for a model
// never pays for one.
//
// CONVENTION: characters come out 1.8 m tall, feet on y = 0, hips over the
// origin, facing -Z — the same contract soldier.js's procedural rig honours,
// so a GLB can be dropped in wherever a procedural soldier goes.
// ============================================================================
import * as THREE from 'three';
import { clone as cloneRig } from 'three/addons/utils/SkeletonUtils.js';
import { glbLoader } from './glb.js';

const BASE_PATH     = 'assets/models/';
const TARGET_HEIGHT = 1.8;   // metres, crown of the head
const MAX_ERRORS    = 32;    // the error log is read by a debug overlay; cap it

// Used only when manifest.json cannot be read at all.  Dropping the standard
// file names into assets/models/ is then enough to light the layer up.
const DEFAULT_MANIFEST = {
    characters: { blue: 'soldier_blue.glb', red: 'soldier_red.glb' },
    animations: {
        idle: 'anim_idle.glb', walk: 'anim_walk.glb', run: 'anim_run.glb',
        crouch: 'anim_crouch.glb', death: 'anim_death.glb'
    },
    weapons: {}
};

// Bone names differ between rig generators; these are the ones we care about.
const HIPS_ALIASES = ['Hips', 'hips', 'mixamorigHips', 'Bip01_Pelvis', 'pelvis', 'Pelvis', 'root'];
const HEAD_ALIASES = ['Head', 'head', 'mixamorigHead'];
const FACE_ALIASES = ['headfront', 'HeadFront', 'head_front', 'nose'];
const TOE_ALIASES  = ['LeftToeBase', 'mixamorigLeftToeBase', 'RightToeBase', 'toe_L'];
const FOOT_ALIASES = ['LeftFoot', 'mixamorigLeftFoot', 'RightFoot', 'foot_L'];

const TEAM_KEYS = ['blue', 'red'];

// ── module state ────────────────────────────────────────────────────────────
const state = {
    basePath: BASE_PATH,
    started: false,
    settled: false,
    manifest: null,
    characters: Object.create(null),   // 'blue' | 'red' -> character record
    weapons: new Map(),                // type -> Object3D master
    errors: []
};

let loader = null;
let resolveReady = null;
let manifestPromise = null;

/**
 * Resolves once the load has settled, successfully or not.  Never rejects.
 * Stays pending until something touches the API, since loading is lazy.
 */
export const ready = new Promise(res => { resolveReady = res; });

// ── failure reporting ───────────────────────────────────────────────────────
// One warning per distinct problem.  A soldier spawning every few seconds must
// not turn a missing file into a console flood.
const WARNED = new Set();
function warn(key, message) {
    if (WARNED.has(key)) return;
    WARNED.add(key);
    if (state.errors.length < MAX_ERRORS) state.errors.push(key);
    console.warn('[assets] ' + message);
}

const errText = e => (e && e.message) ? e.message : String(e);

// ── scratch ─────────────────────────────────────────────────────────────────
const _box = new THREE.Box3();
const _v   = new THREE.Vector3();
const _v2  = new THREE.Vector3();

// ============================================================================
// MANIFEST
// ============================================================================

// Accepts both the shorthand ('file.glb') and the long form ({file, scale, …}),
// and throws away anything that is not one of those so a hand-edited manifest
// cannot take the loader down.
function entryMap(raw) {
    const out = Object.create(null);
    if (!raw || typeof raw !== 'object') return out;
    for (const key of Object.keys(raw)) {
        const e = raw[key];
        if (typeof e === 'string' && e) out[key] = { file: e };
        else if (e && typeof e === 'object' && typeof e.file === 'string' && e.file) out[key] = e;
        else warn('manifest:entry:' + key, `manifest entry "${key}" has no usable file name — skipping it`);
    }
    return out;
}

function normaliseManifest(raw) {
    return {
        characters: entryMap(raw && raw.characters),
        animations: entryMap(raw && raw.animations),
        weapons:    entryMap(raw && raw.weapons)
    };
}

/**
 * Reads assets/models/manifest.json.  Always resolves to a normalised manifest;
 * an unreadable file falls back to the default file names, an empty-but-valid
 * file means "no assets" and is honoured as written.
 */
export function loadManifest() {
    if (state.manifest) return Promise.resolve(state.manifest);
    // A caller reading the manifest while run() is already reading it must not
    // trigger a second fetch.
    if (!manifestPromise) manifestPromise = fetchManifest();
    return manifestPromise;
}

async function fetchManifest() {
    let raw = null;
    try {
        const res = await fetch(state.basePath + 'manifest.json', { cache: 'no-cache' });
        if (res.ok) raw = await res.json();
        else warn('manifest:http', `manifest.json returned ${res.status} — assuming the default file names`);
    } catch (err) {
        warn('manifest:fetch', `could not read manifest.json (${errText(err)}) — assuming the default file names`);
    }
    state.manifest = normaliseManifest(raw || DEFAULT_MANIFEST);
    return state.manifest;
}

// ============================================================================
// LOADING
// ============================================================================

function getLoader() {
    if (!loader) {
        // A private LoadingManager: this layer must never feed a global progress
        // bar that the startup sequence could end up waiting on.
        // No DRACOLoader is wired up — a Draco-compressed file just fails over
        // to the procedural model like any other unreadable asset.
        loader = glbLoader();
    }
    return loader;
}

async function loadGLB(file) {
    const url = state.basePath + file;
    try {
        const gltf = await getLoader().loadAsync(url);
        return (gltf && gltf.scene) ? gltf : null;
    } catch (err) {
        warn('load:' + file, `could not load ${url} (${errText(err)}) — keeping the procedural model`);
        return null;
    }
}

// ============================================================================
// RIG INSPECTION
// ============================================================================

function findSkinnedMesh(root) {
    let found = null;
    root.traverse(o => { if (!found && o.isSkinnedMesh) found = o; });
    return found;
}

function collectBones(root, skeleton) {
    const bones = Object.create(null);
    if (skeleton && skeleton.bones) {
        for (const b of skeleton.bones) if (b && b.name) bones[b.name] = b;
    }
    // Helper bones (a face marker, a weapon socket) are often outside the skin,
    // so sweep the hierarchy as well.
    root.traverse(o => { if (o.isBone && o.name && !bones[o.name]) bones[o.name] = o; });
    return bones;
}

const pickBone = (bones, names) => {
    for (const n of names) if (bones[n]) return bones[n];
    return null;
};

// World-space bounds of the rig in its current pose.  SkinnedMesh.computeBoundingBox
// walks the vertices through the bones, which is the only way to get bounds that
// match what is actually drawn — Box3.setFromObject would report the bind pose.
function measure(root, mesh) {
    _box.makeEmpty();
    if (mesh && typeof mesh.computeBoundingBox === 'function') {
        try {
            mesh.computeBoundingBox();
            if (mesh.boundingBox && !mesh.boundingBox.isEmpty()) {
                _box.copy(mesh.boundingBox).applyMatrix4(mesh.matrixWorld);
            }
        } catch (err) {
            _box.makeEmpty();
        }
    }
    if (_box.isEmpty()) {
        try { _box.setFromObject(root); } catch (err) { _box.makeEmpty(); }
    }
    return _box;
}

const finite = v => typeof v === 'number' && isFinite(v);

// Which way is the character looking, in the loaded file's own space?  The
// generator's rigs carry a 'headfront' helper bone, and head → headfront states
// the facing exactly; toes-past-ankle is the fallback every humanoid rig honours.
function facingYaw(bones, entry) {
    if (finite(entry && entry.yaw)) return THREE.MathUtils.degToRad(entry.yaw);

    const pairs = [[FACE_ALIASES, HEAD_ALIASES], [TOE_ALIASES, FOOT_ALIASES]];
    for (const [frontNames, backNames] of pairs) {
        const front = pickBone(bones, frontNames);
        const back  = pickBone(bones, backNames);
        if (!front || !back) continue;
        front.getWorldPosition(_v);
        back.getWorldPosition(_v2);
        _v.sub(_v2);
        _v.y = 0;
        if (_v.lengthSq() < 1e-8) continue;
        _v.normalize();
        // Snap to a quarter turn: these rigs are axis-aligned, and snapping
        // removes the sub-degree skew from imprecise helper-bone placement.
        const yaw = Math.atan2(_v.x, -_v.z);
        return Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
    }
    return 0;   // nothing to go on — trust the file
}

// ============================================================================
// CLIP MERGING
//
// The generator returns one clip per file, each authored against its own copy
// of the skeleton.  Binding is by bone name, so a clip drops straight onto the
// character's skeleton as long as the names line up.
// ============================================================================

// Bone lengths belong to the target rig, so only the root's translation is kept
// and it is rescaled if the source rig was authored at a different size.
function rootTrackRatio(sourceRoot, targetHips) {
    if (!sourceRoot || !targetHips) return 1;
    const srcHips = sourceRoot.getObjectByName(targetHips.name);
    if (!srcHips) return 1;
    const a = srcHips.position.length();
    const b = targetHips.position.length();
    if (!(a > 1e-6) || !(b > 1e-6)) return 1;
    const r = b / a;
    if (!finite(r) || r <= 0) return 1;
    return (r > 0.99 && r < 1.01) ? 1 : r;   // same rig: leave the numbers alone
}

// GLTFLoader emits bare node names, but a clip authored elsewhere can carry a
// full path.  Only the leaf identifies the bone.
function leafName(path) {
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('.'));
    return cut >= 0 ? path.slice(cut + 1) : path;
}

function retargetClip(clip, name, bones, hips, ratio) {
    const tracks = [];
    for (const track of clip.tracks) {
        const dot = track.name.lastIndexOf('.');
        if (dot < 0) continue;
        const prop = track.name.slice(dot + 1);
        if (prop !== 'quaternion' && prop !== 'position') continue;   // scale tracks are dead weight

        const boneName = leafName(track.name.slice(0, dot));
        const bone = bones[boneName];
        if (!bone) continue;                                          // bone absent from this rig
        if (prop === 'position' && bone !== hips) continue;

        let out;
        try { out = track.clone(); } catch (err) { continue; }
        out.name = boneName + '.' + prop;
        if (prop === 'position' && ratio !== 1) {
            const v = out.values;
            for (let i = 0; i < v.length; i++) v[i] *= ratio;
        }
        tracks.push(out);
    }
    if (!tracks.length) return null;

    const merged = new THREE.AnimationClip(name, -1, tracks);
    try { merged.optimize(); } catch (err) { /* keyframe data we cannot thin is still valid */ }
    return merged;
}

// A clip baked into the character file itself, keyed off its own name so it is
// not lost. 'Armature|clip0|baselayer' -> 'armature_clip0_baselayer'.
const clipKey = name => String(name || 'clip').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function buildClips(charGltf, animGltfs, bones, hips) {
    const clips = Object.create(null);
    for (const key of Object.keys(animGltfs)) {
        const gltf = animGltfs[key];
        if (!gltf || !gltf.animations || !gltf.animations.length) continue;
        const ratio = rootTrackRatio(gltf.scene, hips);
        const merged = retargetClip(gltf.animations[0], key, bones, hips, ratio);
        if (merged) clips[key] = merged;
        else warn('clip:' + key, `animation "${key}" shares no bone names with the character rig — skipping it`);
    }
    for (const clip of (charGltf.animations || [])) {
        const key = clipKey(clip.name);
        if (!key || clips[key]) continue;
        const merged = retargetClip(clip, key, bones, hips, 1);
        if (merged) clips[key] = merged;
    }
    return clips;
}

// ============================================================================
// NORMALISATION
// ============================================================================

function prepareMeshes(root) {
    root.traverse(o => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
        // A skinned mesh's bounds describe the bind pose, not the animated one.
        // Inflate the sphere so any pose stays inside it, rather than disabling
        // culling and paying to draw every character that is off screen.
        if (o.isSkinnedMesh) {
            o.geometry.computeBoundingSphere();
            if (o.geometry.boundingSphere) o.geometry.boundingSphere.radius *= 2.2;
        }
    });
}

// Returns a group at identity that the caller owns outright: the normalising
// transform lives on an inner group, so setting position/rotation/scale on the
// returned object behaves exactly like it does for a procedural soldier.
function normaliseCharacter(gltf, mesh, bones, entry) {
    const root   = new THREE.Group();
    const orient = new THREE.Group();
    root.add(orient);
    orient.add(gltf.scene);

    orient.rotation.y = facingYaw(bones, entry);
    root.updateMatrixWorld(true);

    measure(root, mesh);
    const height = _box.max.y - _box.min.y;
    if (finite(height) && height > 1e-3) {
        orient.scale.setScalar(TARGET_HEIGHT / height);
    } else {
        warn('scale:' + entry.file, `could not measure ${entry.file} — using it at its authored scale`);
    }
    root.updateMatrixWorld(true);

    // Feet on the ground, and the hips — not the bounding box, which an
    // outstretched arm would drag sideways — over the origin.
    measure(root, mesh);
    const minY = _box.min.y;
    const hips = pickBone(bones, HIPS_ALIASES);
    if (hips) hips.getWorldPosition(_v); else _box.getCenter(_v);
    if (finite(minY)) orient.position.y = -minY;
    if (finite(_v.x)) orient.position.x = -_v.x;
    if (finite(_v.z)) orient.position.z = -_v.z;
    root.updateMatrixWorld(true);

    return root;
}

async function buildCharacter(key, entry, animGltfs) {
    const gltf = await loadGLB(entry.file);
    if (!gltf) return null;

    const mesh = findSkinnedMesh(gltf.scene);
    if (!mesh) {
        warn('rig:' + entry.file, `${entry.file} has no skinned mesh — it cannot be animated, skipping it`);
        return null;
    }

    const skeleton = mesh.skeleton || null;
    const bones = collectBones(gltf.scene, skeleton);
    const hips  = pickBone(bones, HIPS_ALIASES);

    prepareMeshes(gltf.scene);
    const scene = normaliseCharacter(gltf, mesh, bones, entry);
    scene.name = 'character_' + key;

    const clips = buildClips(gltf, animGltfs, bones, hips);
    const measured = measure(scene, mesh);

    return {
        scene, skeleton, clips, mesh, bones,
        height: measured.max.y - measured.min.y
    };
}

// ============================================================================
// WEAPONS
//
// No orientation is inferred here.  A gun has no bone that says which way the
// barrel points, so the manifest states the transform and this just applies it.
// ============================================================================
function applyManifestTransform(target, entry) {
    if (Array.isArray(entry.rotation) && entry.rotation.length === 3) {
        target.rotation.set(
            THREE.MathUtils.degToRad(entry.rotation[0] || 0),
            THREE.MathUtils.degToRad(entry.rotation[1] || 0),
            THREE.MathUtils.degToRad(entry.rotation[2] || 0)
        );
    }
    if (finite(entry.scale)) target.scale.setScalar(entry.scale);
    else if (Array.isArray(entry.scale) && entry.scale.length === 3) target.scale.set(...entry.scale);
}

async function buildWeapon(key, entry) {
    const gltf = await loadGLB(entry.file);
    if (!gltf) return null;

    const root   = new THREE.Group();
    const orient = new THREE.Group();
    root.add(orient);
    orient.add(gltf.scene);
    root.name = 'weapon_' + key;

    applyManifestTransform(orient, entry);
    root.updateMatrixWorld(true);

    // Measured after the manifest rotation, so the author's orientation decides
    // which axis counts as the length.
    if (finite(entry.length) && entry.length > 0) {
        const b = measure(root, null);
        const longest = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
        if (finite(longest) && longest > 1e-4) orient.scale.multiplyScalar(entry.length / longest);
    }
    if (Array.isArray(entry.position) && entry.position.length === 3) {
        orient.position.set(entry.position[0] || 0, entry.position[1] || 0, entry.position[2] || 0);
    }

    prepareMeshes(root);
    root.updateMatrixWorld(true);
    return root;
}

// ============================================================================
// ORCHESTRATION
// ============================================================================
async function run() {
    try {
        const manifest = await loadManifest();

        // One pass of network work: the animation files are shared by both
        // characters, so they are fetched alongside them rather than after.
        const animGltfs = Object.create(null);
        await Promise.all(Object.keys(manifest.animations).map(async k => {
            animGltfs[k] = await loadGLB(manifest.animations[k].file);
        }));

        await Promise.all(Object.keys(manifest.characters).map(async key => {
            const team = teamKey(key);
            if (!team) { warn('team:' + key, `manifest character "${key}" is not blue or red — skipping it`); return; }
            try {
                const record = await buildCharacter(team, manifest.characters[key], animGltfs);
                if (record) state.characters[team] = record;
            } catch (err) {
                warn('build:' + key, `${key} failed to build (${errText(err)}) — keeping the procedural soldier`);
            }
        }));

        await Promise.all(Object.keys(manifest.weapons).map(async key => {
            try {
                const obj = await buildWeapon(key, manifest.weapons[key]);
                if (obj) state.weapons.set(key, obj);
            } catch (err) {
                warn('build:weapon:' + key, `weapon "${key}" failed to build (${errText(err)}) — keeping the procedural model`);
            }
        }));
    } catch (err) {
        warn('run', `asset layer stopped early (${errText(err)}) — the game keeps its procedural models`);
    } finally {
        state.settled = true;
        if (resolveReady) resolveReady();
    }
}

function start() {
    if (state.started) return;
    state.started = true;
    run();   // deliberately not awaited: nothing may block on this
}

function teamKey(team) {
    if (typeof team === 'string') {
        const t = team.toLowerCase();
        if (t === 'blue' || t === 'a') return 'blue';
        if (t === 'red'  || t === 'b') return 'red';
        return null;
    }
    return TEAM_KEYS[team] || null;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Starts the load.  Idempotent, never rejects, safe to call at any point after
 * the match is playable.  Returns the same promise as `ready`.
 * `options.basePath` overrides assets/models/, and only bites if nothing has
 * touched the API yet — the first getCharacter() call starts the load too.
 */
export function preload(options) {
    if (options && typeof options.basePath === 'string' && !state.started) {
        state.basePath = options.basePath;
    }
    start();
    return ready;
}

/** The ready promise, starting the load if nothing has yet. Never rejects. */
export function whenReady() {
    start();
    return ready;
}

/** True once the load has settled — with or without assets. Starts the load. */
export function isReady() {
    start();
    return state.settled;
}

/**
 * The shared master for a team, or null until it arrives.
 * `team` may be TEAM_A / TEAM_B (0 / 1) or 'blue' / 'red'.
 *
 *   scene    Group at identity, 1.8 m tall, feet at y=0, facing -Z
 *   skeleton THREE.Skeleton
 *   clips    { idle, walk, run, crouch, death, … } AnimationClips by manifest key
 *   mesh     the SkinnedMesh (for bounds / material work)
 *   bones    bone name -> Bone, for sockets like RightHand
 *   height   measured metres, 1.8 unless the model could not be measured
 *
 * This is the master instance.  Spawning more than one soldier from it needs
 * cloneCharacter(), which gives each soldier its own skeleton.
 */
export function getCharacter(team) {
    start();
    const key = teamKey(team);
    return (key && state.characters[key]) || null;
}

/**
 * An independent copy of the team's character — its own skeleton, ready for its
 * own AnimationMixer.  Same shape as getCharacter(), or null.  Clips, geometry
 * and materials are shared with the master; only the rig is duplicated.
 */
export function cloneCharacter(team) {
    const src = getCharacter(team);
    if (!src) return null;
    try {
        const scene = cloneRig(src.scene);
        const mesh = findSkinnedMesh(scene);
        if (!mesh) return null;
        prepareMeshes(scene);
        return {
            scene, mesh,
            skeleton: mesh.skeleton || null,
            clips: src.clips,
            bones: collectBones(scene, mesh.skeleton),
            height: src.height
        };
    } catch (err) {
        warn('clone:' + teamKey(team), `could not clone the character rig (${errText(err)}) — keeping the procedural soldier`);
        return null;
    }
}

/**
 * A fresh copy of a weapon model, or null. `type` matches WEAPON_DEFS' `type`
 * ('rifle', 'smg', 'sniper', 'shotgun', 'pistol'). Geometry and materials are
 * shared between copies.
 */
export function getWeapon(type) {
    start();
    const master = state.weapons.get(type);
    if (!master) return null;
    try {
        return cloneRig(master);
    } catch (err) {
        warn('clone:weapon:' + type, `could not clone weapon "${type}" (${errText(err)}) — keeping the procedural model`);
        return null;
    }
}

/** Snapshot for the debug overlay: what loaded, what did not. */
export function assetStatus() {
    return {
        started: state.started,
        ready: state.settled,
        basePath: state.basePath,
        characters: Object.keys(state.characters),
        clips: Object.keys(state.characters).map(k => k + ':' + Object.keys(state.characters[k].clips).join(',')),
        weapons: [...state.weapons.keys()],
        errors: state.errors.slice()
    };
}

/**
 * Releases the GPU memory the loaded masters hold.  For teardown only — live
 * clones share these geometries and materials and will render as nothing
 * afterwards.
 */
export function disposeAssets() {
    const seen = new Set();
    const kill = root => {
        if (!root) return;
        root.traverse(o => {
            if (!o.isMesh) return;
            if (o.geometry && !seen.has(o.geometry)) { seen.add(o.geometry); o.geometry.dispose(); }
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            for (const m of mats) {
                if (!m || seen.has(m)) continue;
                seen.add(m);
                for (const key of Object.keys(m)) {
                    const val = m[key];
                    if (val && val.isTexture && !seen.has(val)) { seen.add(val); val.dispose(); }
                }
                m.dispose();
            }
        });
    };
    for (const key of Object.keys(state.characters)) kill(state.characters[key].scene);
    for (const master of state.weapons.values()) kill(master);
    state.characters = Object.create(null);
    state.weapons.clear();
}
