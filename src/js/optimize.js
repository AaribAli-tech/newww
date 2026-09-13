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

function mergeBucket(parent, meshes, relativeTo) {
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
        m.geometry.dispose();
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
