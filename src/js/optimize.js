// ============================================================================
// optimize.js — geometry batching.
//
// The map and the soldiers are built from hundreds of small primitives, which
// is great for authoring and terrible for draw calls.  Collision is stored as
// standalone AABBs, so the visual meshes can be merged freely without
// affecting gameplay.
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function bucketKey(mesh) {
    return `${mesh.material.uuid}|${mesh.castShadow ? 1 : 0}|${mesh.receiveShadow ? 1 : 0}`;
}

function mergeBucket(parent, meshes, relativeTo, keepGeos) {
    if (meshes.length < 2) return 0;
    const geos = [];
    for (const m of meshes) {
        m.updateWorldMatrix(true, false);
        const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        if (relativeTo) {
            // express in the parent's local space
            const mat = new THREE.Matrix4().copy(relativeTo).invert().multiply(m.matrixWorld);
            g.applyMatrix4(mat);
        } else {
            g.applyMatrix4(m.matrixWorld);
        }
        // strip anything not shared by every geometry so the merge cannot fail
        for (const name of Object.keys(g.attributes)) {
            if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
        }
        if (!g.attributes.uv) {
            const n = g.attributes.position.count;
            g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
        }
        geos.push(g);
    }
    let merged;
    try {
        merged = mergeGeometries(geos, false);
    } catch {
        merged = null;
    }
    if (!merged) { for (const g of geos) g.dispose(); return 0; }

    const first = meshes[0];
    const out = new THREE.Mesh(merged, first.material);
    out.castShadow = first.castShadow;
    out.receiveShadow = first.receiveShadow;
    out.matrixAutoUpdate = false;
    parent.add(out);

    let removed = 0;
    for (const m of meshes) {
        m.parent.remove(m);
        // A geometry handed to an InstancedMesh is still being drawn; disposing it
        // would delete the map out from under it.
        if (!keepGeos || !keepGeos.has(m.geometry)) m.geometry.dispose();
        removed++;
    }
    for (const g of geos) g.dispose();
    return removed;
}

/**
 * Stop small props casting shadows.
 *
 * The sun is high and these objects are hand-sized; their shadows are a few
 * pixels and nobody looks at them, but each one is a whole extra draw into the
 * shadow map every time it refreshes. Returns how many were switched off.
 */
export function pruneShadowCasters(scene, minRadius = 0.42) {
    const sphere = new THREE.Sphere();
    let pruned = 0;
    scene.traverse(o => {
        if (!o.isMesh || !o.castShadow || o.isSkinnedMesh) return;
        if (o.userData.keepShadow) return;
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        const bs = o.geometry.boundingSphere;
        if (!bs) return;
        sphere.copy(bs).applyMatrix4(o.matrixWorld);
        if (sphere.radius < minRadius) { o.castShadow = false; pruned++; }
    });
    return pruned;
}

/** Merge every top-level static mesh in a scene, grouped by material. */
export function mergeStaticScene(scene) {
    const buckets = new Map();
    for (const child of scene.children.slice()) {
        if (!child.isMesh) continue;
        if (child.userData.noMerge) continue;
        if (!child.material || Array.isArray(child.material)) continue;
        if (child.material.isShaderMaterial) continue;      // sky
        const k = bucketKey(child);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(child);
    }
    let before = 0, after = 0;
    for (const list of buckets.values()) {
        before += list.length;
        if (list.length < 2) { after += list.length; continue; }
        mergeBucket(scene, list, null);
        after += 1;
    }
    return { before, after };
}

/**
 * Merge the direct mesh children of a bone group, keeping sub-groups intact so
 * the rig still animates.
 */
export function mergeBoneMeshes(group) {
    const meshes = group.children.filter(c => c.isMesh && !c.userData.noMerge &&
        c.material && !Array.isArray(c.material));
    if (meshes.length < 2) return 0;
    const buckets = new Map();
    for (const m of meshes) {
        const k = bucketKey(m);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(m);
    }
    group.updateWorldMatrix(true, false);
    const base = group.matrixWorld.clone();
    let saved = 0;
    for (const list of buckets.values()) {
        if (list.length < 2) continue;
        saved += mergeBucket(group, list, base) - 1;
    }
    return saved;
}

/** Recursively batch every group in a rig. */
export function mergeRig(root) {
    const groups = [];
    root.traverse(o => { if (o.isGroup || o.isObject3D && !o.isMesh) groups.push(o); });
    let saved = 0;
    for (const g of groups) {
        if (g.userData.noMerge) continue;
        saved += mergeBoneMeshes(g);
    }
    return saved;
}

// ── instanced batching ─────────────────────────────────────────────────────
//
// mergeStaticScene fixed the draw calls and left two things behind:
//
//   * every bucket is one mesh whose bounds span the whole town, so the frustum
//     test has nothing to reject — all of it is handed to the GPU every frame, in
//     the colour pass and again in the shadow pass, whether or not the player is
//     looking at that part of the map;
//   * merging bakes a copy of every primitive into the bucket's own buffer and
//     converts to non-indexed on the way (a 24-vertex box becomes 36), so the map
//     ended up 40% bigger in memory than the unbatched scene it was built from.
//
// This is the version the map uses: geometry that repeats is drawn as an
// InstancedMesh — one copy of the box, one matrix per instance, still indexed —
// and everything that cannot be instanced is merged per tile instead of per
// material across the whole field. The tiles are what give culling back.
const _sig = new WeakMap();
function geoSig(g) {
    let s = _sig.get(g);
    if (s !== undefined) return s;
    const q = unifyOf(g);
    if (q) s = `unit:${q.type}`;
    else if (g.parameters) {
        s = `${g.type}:${JSON.stringify(g.parameters)}`;
    } else {
        if (!g.boundingBox) g.computeBoundingBox();
        const b = g.boundingBox, n = g.attributes.position.count;
        s = `${g.type}:${n}:` + [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z]
            .map(v => v.toFixed(3)).join(',');
    }
    _sig.set(g, s);
    return s;
}

/**
 * Boxes and flat quads are the same shape at any size, and the map is 2,800 of
 * them. Giving every one its own geometry — or baking copies into a merge buffer
 * — is what makes the map cost vertex traffic; one shared unit box with the size
 * carried in the instance matrix is the whole trick. Anything else (cylinders,
 * cones, jittered scrub) keeps its own geometry and is matched by parameters.
 */
const _unitUv = new Map();
function uvIsPristine(g, kind) {
    // A bucket shares one geometry, so an instance cannot carry its own texture
    // tiling. Panels that had repeat baked into their UVs (the alpha-cut fences)
    // keep their own geometry and are merged instead of instanced.
    const a = g.attributes.uv;
    if (!a) return false;
    let ref = _unitUv.get(kind);
    if (!ref) {
        const u = kind === 'Box' ? new THREE.BoxGeometry(1, 1, 1) : new THREE.PlaneGeometry(1, 1);
        ref = Array.from(u.attributes.uv.array);
        u.dispose();
        _unitUv.set(kind, ref);
    }
    if (a.count !== ref.length / 2) return false;
    for (let i = 0; i < ref.length; i++) if (Math.abs(a.array[i] - ref[i]) > 1e-6) return false;
    return true;
}

function unifyOf(g) {
    const p = g.parameters;
    if (!p || !g.index || g.attributes.position.count !== (g.type === 'BoxGeometry' ? 24 : 4)) return null;
    if (g.type === 'BoxGeometry') {
        if (p.widthSegments !== 1 || p.heightSegments !== 1 || p.depthSegments !== 1) return null;
        return uvIsPristine(g, 'Box') ? { type: 'Box', scale: [p.width, p.height, p.depth] } : null;
    }
    if (g.type === 'PlaneGeometry' && p.widthSegments === 1 && p.heightSegments === 1)
        return uvIsPristine(g, 'Plane') ? { type: 'Plane', scale: [p.width, p.height, 1] } : null;
    return null;
}

/** A unit primitive every unified bucket can share. */
const _unit = new Map();
function unitGeo(kind) {
    let g = _unit.get(kind);
    if (!g) {
        g = kind === 'Box' ? new THREE.BoxGeometry(1, 1, 1) : new THREE.PlaneGeometry(1, 1);
        g.computeBoundingSphere();
        _unit.set(kind, g);
    }
    return g;
}

function attrBytes(g) {
    let n = 0;
    for (const name of ['position', 'normal', 'uv']) {
        const a = g.attributes[name];
        if (a) n += a.count * a.itemSize * a.array.BYTES_PER_ELEMENT;
    }
    if (g.index) n += g.index.count * (g.index.array.BYTES_PER_ELEMENT || 2);
    return n;
}
const triCount = g => (g.index ? g.index.count : g.attributes.position.count) / 3;

/**
 * Batch the static map into per-tile InstancedMeshes plus per-tile merges.
 *
 * @param {THREE.Scene} scene
 * @param {{cell?:number,minInstances?:number}} [opts] tile size in world metres,
 *        and how many copies of a primitive must exist in a tile before it is
 *        worth an instance buffer.
 */
export function batchStaticScene(scene, opts = {}) {
    const cell = opts.cell ?? 24;              // world metres per tile
    const minInstances = opts.minInstances ?? 3;
    const tooBig = cell * 0.75;               // already spans a tile on its own

    const cands = [];
    for (const child of scene.children.slice()) {
        if (!child.isMesh || child.isInstancedMesh || child.userData.noMerge) continue;
        if (!child.material || Array.isArray(child.material)) continue;
        if (child.material.isShaderMaterial) continue;          // the sky dome
        if (!child.geometry || !child.geometry.attributes.position) continue;
        child.updateWorldMatrix(true, false);
        const box = new THREE.Box3().setFromObject(child);
        const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
        cands.push({
            m: child, box, span,
            tile: span > tooBig ? 'G'
                : `${Math.floor((box.min.x + box.max.x) * 0.5 / cell)}|${Math.floor((box.min.z + box.max.z) * 0.5 / cell)}`
        });
    }
    // Everything that was in the scene but is not ours to batch (sky, lights, dust)
    // has to be left out of the accounting, or "after" looks worse than it is.
    const skip = new Set(scene.children.filter(o => !cands.some(c => c.m === o)));
    const before = { verts: 0, resident: 0, bytes: 0, tris: 0, maxSpan: 0 };
    for (const c of cands) {
        const g = c.m.geometry;
        before.verts += g.attributes.position.count;
        before.resident += g.attributes.position.count;
        before.bytes += attrBytes(g);
        before.tris += triCount(g);
        before.maxSpan = Math.max(before.maxSpan, c.span);
    }

    const inst = new Map(), merge = new Map();
    const matKey = m => `${m.material.uuid}|${m.castShadow ? 1 : 0}|${m.receiveShadow ? 1 : 0}`;
    for (const c of cands) {
        const k = `${c.tile}|${matKey(c.m)}`;
        if (!merge.has(k)) merge.set(k, []);
        if (c.tile === 'G') { merge.get(k).push(c.m); continue; }
        const u = unifyOf(c.m.geometry);
        const ik = u ? `${k}|unit:${u.type}` : `${k}|${geoSig(c.m.geometry)}`;
        if (!inst.has(ik)) inst.set(ik, { list: [], k, unit: u ? u.type : null });
        inst.get(ik).list.push(c.m);
    }

    const keepGeos = new Set();
    const box = new THREE.Box3(), tmp = new THREE.Box3(), centre = new THREE.Vector3();
    let groups = 0, instances = 0;
    const leftover = new Map();
    const tuck = (k, m) => { if (!leftover.has(k)) leftover.set(k, []); leftover.get(k).push(m); };
    for (const [key, bucket] of inst) {
        const list = bucket.list;
        if (list.length < minInstances) {
            for (const m of list) tuck(bucket.k, m);
            continue;
        }
        const first = list[0];
        const geo = bucket.unit ? unitGeo(bucket.unit) : first.geometry;
        if (!bucket.unit) keepGeos.add(geo);
        if (!geo.boundingBox) geo.computeBoundingBox();
        const im = new THREE.InstancedMesh(geo, first.material, list.length);
        const m4 = new THREE.Matrix4();
        box.makeEmpty();
        for (let i = 0; i < list.length; i++) {
            const m = list[i];
            if (bucket.unit) {
                // The authored size of the primitive becomes part of the instance
                // transform: scale in local space, then the mesh's own transform.
                const p = m.geometry.parameters;
                const sz = bucket.unit === 'Box' ? [p.width, p.height, p.depth] : [p.width, p.height, 1];
                m4.copy(m.matrixWorld).scale(new THREE.Vector3(sz[0], sz[1], sz[2]));
            } else {
                m4.copy(m.matrixWorld);
            }
            im.setMatrixAt(i, m4);
            tmp.copy(geo.boundingBox).applyMatrix4(m4);
            box.union(tmp);
        }
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = first.castShadow;
        im.receiveShadow = first.receiveShadow;
        im.matrixAutoUpdate = false;
        im.name = `inst:${key.length > 30 ? key.slice(-30) : key}`;
        // three would otherwise size the culling volume from the shared geometry and
        // throw most of the town's instances away as "off screen".
        box.getCenter(centre);
        im.boundingSphere = new THREE.Sphere(centre.clone(), Math.max(0.5, box.getSize(new THREE.Vector3()).length() * 0.5));
        im.boundingBox = box.clone();
        scene.add(im);
        for (const m of list) { m.parent.remove(m); if (m.geometry !== geo) m.geometry.dispose(); }
        groups++; instances += list.length;
    }

    for (const [k, list] of leftover) {
        if (!merge.has(k)) merge.set(k, []);
        for (const m of list) merge.get(k).push(m);
    }
    // Tiling buys culling and costs draw calls, so it is only worth splitting a
    // material across tiles when the material is big enough for that to matter.
    // The trim — pavement decals, one-off props — is merged once for the map,
    // because culling 60 vertices is not worth five extra state changes.
    const splitMin = opts.splitVerts ?? 360;
    const matTotal = new Map();
    for (const [k, list] of merge) {
        const mk = k.slice(k.indexOf('|') + 1);
        let v = 0;
        for (const m of list) v += m.geometry.attributes.position.count * 3;   // non-indexed bake
        matTotal.set(mk, (matTotal.get(mk) || 0) + v);
    }
    const regrouped = new Map();
    for (const [k, list] of merge) {
        const mk = k.slice(k.indexOf('|') + 1);
        const key = matTotal.get(mk) >= splitMin ? k : `M|${mk}`;
        if (!regrouped.has(key)) regrouped.set(key, []);
        for (const m of list) regrouped.get(key).push(m);
    }
    merge.clear();
    for (const [k, list] of regrouped) merge.set(k, list);

    for (const list of merge.values()) {
        if (list.length < 2) continue;                    // leave singletons alone
        mergeBucket(scene, list, null, keepGeos);
        groups++;
    }
    const after = batchReport(scene, skip);
    return {
        before: cands.length, groups, instances,
        vertsBefore: before.verts, vertsAfter: after.verts,
        residentBefore: before.resident, residentAfter: after.resident,
        bytesBefore: before.bytes, bytesAfter: after.bytes,
        trisBefore: Math.round(before.tris), trisAfter: after.tris,
        spanBefore: before.maxSpan, spanAfter: after.maxSpan,
        lost: Math.round((before.tris - after.tris) * 1000) / 1000,
        cell
    };
}

/**
 * What the batcher is worth, measured rather than asserted. Returns the same
 * accounting the batcher prints, for a scene that has already been batched.
 */
export function batchReport(scene, skip) {
    const acct = { objects: 0, instances: 0, verts: 0, resident: 0, bytes: 0, tris: 0, maxSpan: 0 };
    for (const o of scene.children) {
        if (skip && skip.has(o)) continue;
        if (o.isInstancedMesh) {
            const g = o.geometry;
            acct.objects++; acct.instances += o.count;
            acct.verts += g.attributes.position.count * o.count;
            acct.resident += g.attributes.position.count;
            acct.bytes += attrBytes(g);
            acct.tris += triCount(g) * o.count;
        } else if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position
            && !o.material.isShaderMaterial) {
            const g = o.geometry;
            acct.objects++;
            acct.verts += g.attributes.position.count;
            acct.resident += g.attributes.position.count;
            acct.bytes += attrBytes(g);
            acct.tris += triCount(g);
            const b = new THREE.Box3().setFromObject(o);
            acct.maxSpan = Math.max(acct.maxSpan, b.max.x - b.min.x, b.max.z - b.min.z);
        }
    }
    acct.tris = Math.round(acct.tris);
    return acct;
}
