// ============================================================================
// physics.js — AABB collision world with a uniform-grid broadphase.
//
// Everything (movement, bullets, line-of-sight) resolves against the same set
// of axis-aligned boxes, so what you can walk into is exactly what you can
// shoot into.  No mesh raycasting: it is both slower and inconsistent.
// ============================================================================
import * as THREE from 'three';

const CELL = 6;

export class CollisionWorld {
    constructor() {
        this.boxes = [];          // {minX,minY,minZ,maxX,maxY,maxZ,tag}
        this.grid = new Map();
        this.stepHeight = 0.55;
        this._queryStamp = 0;
        this._stamps = [];
    }

    // ── building ────────────────────────────────────────────────────────────
    addAABB(minX, minY, minZ, maxX, maxY, maxZ, tag = 'solid') {
        const b = {
            minX: Math.min(minX, maxX), minY: Math.min(minY, maxY), minZ: Math.min(minZ, maxZ),
            maxX: Math.max(minX, maxX), maxY: Math.max(minY, maxY), maxZ: Math.max(minZ, maxZ),
            tag
        };
        const idx = this.boxes.push(b) - 1;
        this._stamps.push(-1);
        for (let cx = Math.floor(b.minX / CELL); cx <= Math.floor(b.maxX / CELL); cx++) {
            for (let cz = Math.floor(b.minZ / CELL); cz <= Math.floor(b.maxZ / CELL); cz++) {
                const key = cx * 10007 + cz;
                let arr = this.grid.get(key);
                if (!arr) { arr = []; this.grid.set(key, arr); }
                arr.push(idx);
            }
        }
        return b;
    }

    addBoxMesh(mesh, tag) {
        mesh.updateMatrixWorld(true);
        const b = new THREE.Box3().setFromObject(mesh);
        return this.addAABB(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z, tag);
    }

    /** Boxes overlapping an XZ rectangle. Returns indices (deduplicated). */
    _query(minX, minZ, maxX, maxZ, out) {
        out.length = 0;
        const stamp = ++this._queryStamp;
        for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
            for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
                const arr = this.grid.get(cx * 10007 + cz);
                if (!arr) continue;
                for (let i = 0; i < arr.length; i++) {
                    const id = arr[i];
                    if (this._stamps[id] === stamp) continue;
                    this._stamps[id] = stamp;
                    out.push(id);
                }
            }
        }
        return out;
    }

    // ── character movement ──────────────────────────────────────────────────
    /**
     * Resolve a capsule (cylinder) against the world along one horizontal axis.
     * Called separately for X and Z so sliding along walls feels smooth.
     */
    resolveAxis(pos, radius, height, axis, _scratch = []) {
        const feet = pos.y + 0.05;
        const head = pos.y + height;
        const ids = this._query(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius, _scratch);
        let moved = false;
        for (let i = 0; i < ids.length; i++) {
            const b = this.boxes[ids[i]];
            if (head <= b.minY || feet >= b.maxY) continue;
            if (pos.x + radius <= b.minX || pos.x - radius >= b.maxX) continue;
            if (pos.z + radius <= b.minZ || pos.z - radius >= b.maxZ) continue;
            // steppable ledge — walking handles it, not the wall solver
            if (b.maxY - (pos.y) <= this.stepHeight && b.maxY > pos.y) continue;

            if (axis === 'x') {
                const pushRight = b.maxX - (pos.x - radius);
                const pushLeft = (pos.x + radius) - b.minX;
                pos.x += (pushRight < pushLeft) ? pushRight : -pushLeft;
            } else {
                const pushFwd = b.maxZ - (pos.z - radius);
                const pushBack = (pos.z + radius) - b.minZ;
                pos.z += (pushFwd < pushBack) ? pushFwd : -pushBack;
            }
            moved = true;
        }
        return moved;
    }

    /** Highest supporting surface under a point that the entity can stand on. */
    groundHeight(x, z, currentY, radius = 0.3, _scratch = []) {
        let highest = 0;
        const ids = this._query(x - radius, z - radius, x + radius, z + radius, _scratch);
        const ceiling = currentY + this.stepHeight;
        for (let i = 0; i < ids.length; i++) {
            const b = this.boxes[ids[i]];
            if (x + radius <= b.minX || x - radius >= b.maxX) continue;
            if (z + radius <= b.minZ || z - radius >= b.maxZ) continue;
            if (b.maxY <= ceiling && b.maxY > highest) highest = b.maxY;
        }
        return highest;
    }

    /** Ceiling directly above (stops jumping through floors). */
    ceilingHeight(x, z, fromY, radius = 0.3, _scratch = []) {
        let lowest = Infinity;
        const ids = this._query(x - radius, z - radius, x + radius, z + radius, _scratch);
        for (let i = 0; i < ids.length; i++) {
            const b = this.boxes[ids[i]];
            if (x + radius <= b.minX || x - radius >= b.maxX) continue;
            if (z + radius <= b.minZ || z - radius >= b.maxZ) continue;
            if (b.minY >= fromY && b.minY < lowest) lowest = b.minY;
        }
        return lowest;
    }

    // ── ray casting (slab method) ───────────────────────────────────────────
    /** @returns {null | {distance, point, normal}} */
    raycast(origin, dir, maxDist = 200) {
        // walk the ray's XZ footprint through the grid cells it touches
        const scratch = this._rayScratch || (this._rayScratch = []);
        const ex = origin.x + dir.x * maxDist, ez = origin.z + dir.z * maxDist;
        const ids = this._query(
            Math.min(origin.x, ex) - 0.5, Math.min(origin.z, ez) - 0.5,
            Math.max(origin.x, ex) + 0.5, Math.max(origin.z, ez) + 0.5, scratch
        );

        let bestT = maxDist, hit = null;
        const invX = 1 / (dir.x || 1e-9), invY = 1 / (dir.y || 1e-9), invZ = 1 / (dir.z || 1e-9);

        for (let i = 0; i < ids.length; i++) {
            const b = this.boxes[ids[i]];
            let t1 = (b.minX - origin.x) * invX, t2 = (b.maxX - origin.x) * invX;
            let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
            let axis = 0;
            t1 = (b.minY - origin.y) * invY; t2 = (b.maxY - origin.y) * invY;
            const ymin = Math.min(t1, t2), ymax = Math.max(t1, t2);
            if (ymin > tmin) { tmin = ymin; axis = 1; }
            tmax = Math.min(tmax, ymax);
            t1 = (b.minZ - origin.z) * invZ; t2 = (b.maxZ - origin.z) * invZ;
            const zmin = Math.min(t1, t2), zmax = Math.max(t1, t2);
            if (zmin > tmin) { tmin = zmin; axis = 2; }
            tmax = Math.min(tmax, zmax);

            if (tmax < Math.max(tmin, 0) || tmin > bestT || tmin < 0) continue;
            bestT = tmin;
            hit = { t: tmin, axis, box: b };
        }

        if (!hit) return null;
        const point = new THREE.Vector3(
            origin.x + dir.x * hit.t, origin.y + dir.y * hit.t, origin.z + dir.z * hit.t
        );
        const normal = new THREE.Vector3();
        if (hit.axis === 0) normal.x = dir.x > 0 ? -1 : 1;
        else if (hit.axis === 1) normal.y = dir.y > 0 ? -1 : 1;
        else normal.z = dir.z > 0 ? -1 : 1;
        return { distance: hit.t, point, normal, tag: hit.box.tag };
    }

    isLineOfSight(from, to) {
        const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < 0.15) return true;
        const dir = _tmpDir.set(dx / dist, dy / dist, dz / dist);
        const hit = this.raycast(from, dir, dist - 0.12);
        return !hit;
    }
}

const _tmpDir = new THREE.Vector3();
