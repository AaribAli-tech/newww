// ============================================================================
// map.js — NUKETOWN (cul-de-sac layout)
//
// Layout notes (V2_SPEC §1):
//   • The map is built around a paved circle at the origin, r 12.5, with a
//     single access road running south.  There is no through street.
//   • Symmetry is a MIRROR about x = 0, not a 180° rotation.  One side is
//     authored in "canonical" east coordinates and drawn twice with s = ±1.
//     A reflection reverses handedness, so a mirrored object keeps rotation.x
//     but negates rotation.y and rotation.z.  Signage is placed once, by hand,
//     or the lettering comes out backwards.
//   • Teal house west, yellow house east, fire station north, two bungalows
//     flanking the access road south.  Spawns sit in the back yards behind the
//     two houses, so both teams enter the circle from the same distance.
//   • Both houses carry the reference-3 treatment: stone base course, vertical
//     board-and-batten siding, a first-floor balcony under a timber pergola and
//     an exterior wooden staircase from that balcony down to the side yard.
//     The staircase is a real traversal route — every tread is collision.
// ============================================================================
import * as THREE from 'three';
import * as M from './materials.js';

export const MAP_BOUNDS = { minX: -42, maxX: 42, minZ: -40, maxZ: 38 };

// ── the circle and its road ─────────────────────────────────────────────────
const CIRCLE_R = 12.5;                 // paved radius of the cul-de-sac
const ROAD_HALF = 4.5;                 // access road half-width
const ROAD_Z0 = 11.0, ROAD_Z1 = 36.0;
// Half-angle of the gap the access road cuts out of the kerb / verge rings.
const ROAD_GAP = Math.asin(ROAD_HALF / CIRCLE_R) + 0.06;

// House footprint, canonical EAST side. Front (x0) faces the circle.
const H = {
    x0: 18.0, x1: 28.0,           // 10 m front-to-back
    z0: -9.0, z1: -1.4,           // 7.6 m across
    t: 0.32,                      // wall thickness
    stone: 1.05,                  // top of the stone base course
    floor: 0.25,                  // ground floor top
    mid: 3.05, midTop: 3.30,      // first-floor slab
    top: 6.10, ceil: 6.30,        // upper wall top / ceiling slab top
    ridge: 8.70
};
// Attached garage. Its north side IS the house's south wall — no gap.
const G = { x0: 19.5, x1: 27.0, z0: -1.4, z1: 3.0, h: 3.2, floor: 0.15 };
// Porch below, balcony above, same footprint.
const P = { x0: 15.6, x1: 18.0, z0: -9.0, z1: -1.6 };
// Single-storey bungalow flanking the access road.
const BG = {
    x0: 15.5, x1: 27.0, z0: 17.0, z1: 26.0,
    t: 0.28, floor: 0.2, top: 3.10, ceil: 3.25, ridge: 4.70
};
// Fire station, built once — it straddles x = 0 and is symmetric by hand.
const FS = { x0: -11, x1: 11, z0: -31, z1: -19, t: 0.36, floor: 0.15, top: 5.5, ridge: 6.3 };
const FS_EAVE = 5.5;

// Lot lines (canonical east).
const LOT_N = -14.6, LOT_S = 7.6;

// ── build context ───────────────────────────────────────────────────────────
let CTX = null;

/**
 * Mirroring reflects across x = 0: X negates, Z is untouched.  A reflection
 * flips handedness, so rotations about Y and Z flip sign while rotation about
 * X — the axis lying in the mirror plane — does not.
 */
function box(w, h, d, x, y, z, mat, opts = {}) {
    const s = CTX.s;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x * s, y, z);
    if (opts.rotY) m.rotation.y = opts.rotY * s;
    if (opts.rotX) m.rotation.x = opts.rotX;
    if (opts.rotZ) m.rotation.z = opts.rotZ * s;
    m.castShadow = opts.cast !== false;
    m.receiveShadow = opts.receive !== false;
    CTX.scene.add(m);
    if (opts.solid !== false) {
        if (opts.rotY || opts.rotZ || opts.rotX) CTX.cw.addBoxMesh(m, opts.tag);
        else CTX.cw.addAABB(x * s - w / 2, y - h / 2, z - d / 2, x * s + w / 2, y + h / 2, z + d / 2, opts.tag);
    }
    return m;
}

function cylinder(rt, rb, h, seg, x, y, z, mat, opts = {}) {
    const s = CTX.s;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x * s, y, z);
    if (opts.rotX) m.rotation.x = opts.rotX;
    if (opts.rotZ) m.rotation.z = opts.rotZ * s;
    if (opts.rotY) m.rotation.y = opts.rotY * s;
    m.castShadow = opts.cast !== false;
    m.receiveShadow = true;
    CTX.scene.add(m);
    if (opts.solid) CTX.cw.addBoxMesh(m, opts.tag);
    return m;
}

/** Decorative only (never collides). */
function deco(w, h, d, x, y, z, mat, opts = {}) {
    return box(w, h, d, x, y, z, mat, { ...opts, solid: false, cast: opts.cast ?? true });
}

/** Flat ground layer. Painted, never collided with — the world floor is at 0. */
function pave(geo, mat, x, y, z, rotY = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    if (rotY) m.rotation.z = -rotY;          // after the -90° X tilt, Z is yaw
    m.position.set(x, y, z);
    m.receiveShadow = true;
    CTX.scene.add(m);
    return m;
}

// ── walls with door / window openings ───────────────────────────────────────
/** Wall running along X at a fixed Z. openings: [{a,b,y0,y1}] in X. */
function wallX(x0, x1, z, y0, y1, t, mat, openings = []) {
    const ops = [...openings].sort((p, q) => p.a - q.a);
    let cursor = x0;
    for (const o of ops) {
        if (o.a > cursor) box(o.a - cursor, y1 - y0, t, (cursor + o.a) / 2, (y0 + y1) / 2, z, mat);
        if (o.y0 > y0) box(o.b - o.a, o.y0 - y0, t, (o.a + o.b) / 2, (y0 + o.y0) / 2, z, mat);
        if (o.y1 < y1) box(o.b - o.a, y1 - o.y1, t, (o.a + o.b) / 2, (o.y1 + y1) / 2, z, mat);
        cursor = o.b;
    }
    if (cursor < x1) box(x1 - cursor, y1 - y0, t, (cursor + x1) / 2, (y0 + y1) / 2, z, mat);
}

/** Wall running along Z at a fixed X. openings: [{a,b,y0,y1}] in Z. */
function wallZ(z0, z1, x, y0, y1, t, mat, openings = []) {
    const ops = [...openings].sort((p, q) => p.a - q.a);
    let cursor = z0;
    for (const o of ops) {
        if (o.a > cursor) box(t, y1 - y0, o.a - cursor, x, (y0 + y1) / 2, (cursor + o.a) / 2, mat);
        if (o.y0 > y0) box(t, o.y0 - y0, o.b - o.a, x, (y0 + o.y0) / 2, (o.a + o.b) / 2, mat);
        if (o.y1 < y1) box(t, y1 - o.y1, o.b - o.a, x, (o.y1 + y1) / 2, (o.a + o.b) / 2, mat);
        cursor = o.b;
    }
    if (cursor < z1) box(t, y1 - y0, z1 - cursor, x, (y0 + y1) / 2, (cursor + z1) / 2, mat);
}

/**
 * Thin skin on the inside face of an exterior wall, with the same openings cut
 * out. Without it you see the exterior siding from the living room.
 */
function linerX(x0, x1, z, y0, y1, mat, openings = [], T = 0.05) {
    const ops = [...openings].sort((p, q) => p.a - q.a);
    let cursor = x0;
    for (const o of ops) {
        if (o.a > cursor) deco(o.a - cursor, y1 - y0, T, (cursor + o.a) / 2, (y0 + y1) / 2, z, mat, { cast: false });
        if (o.y0 > y0) deco(o.b - o.a, o.y0 - y0, T, (o.a + o.b) / 2, (y0 + o.y0) / 2, z, mat, { cast: false });
        if (o.y1 < y1) deco(o.b - o.a, y1 - o.y1, T, (o.a + o.b) / 2, (o.y1 + y1) / 2, z, mat, { cast: false });
        cursor = o.b;
    }
    if (cursor < x1) deco(x1 - cursor, y1 - y0, T, (cursor + x1) / 2, (y0 + y1) / 2, z, mat, { cast: false });
}
function linerZ(z0, z1, x, y0, y1, mat, openings = [], T = 0.05) {
    const ops = [...openings].sort((p, q) => p.a - q.a);
    let cursor = z0;
    for (const o of ops) {
        if (o.a > cursor) deco(T, y1 - y0, o.a - cursor, x, (y0 + y1) / 2, (cursor + o.a) / 2, mat, { cast: false });
        if (o.y0 > y0) deco(T, o.y0 - y0, o.b - o.a, x, (y0 + o.y0) / 2, (o.a + o.b) / 2, mat, { cast: false });
        if (o.y1 < y1) deco(T, y1 - o.y1, o.b - o.a, x, (o.y1 + y1) / 2, (o.a + o.b) / 2, mat, { cast: false });
        cursor = o.b;
    }
    if (cursor < z1) deco(T, y1 - y0, z1 - cursor, x, (y0 + y1) / 2, (cursor + z1) / 2, mat, { cast: false });
}

// ── board-and-batten ────────────────────────────────────────────────────────
// Reference 3 is vertical boards with a batten over every seam. The siding map
// is a horizontal lap texture, so the vertical read has to come from real proud
// strips — and they have to be dense enough to beat the lap lines, or the wall
// reads as a log cabin. They share the siding material, so the static merge
// folds them into the wall's single draw call.
const BATTEN_STEP = 0.44;

function battenBlocked(openings, u, y0, y1) {
    for (const o of openings) {
        if (u > o.a - 0.14 && u < o.b + 0.14 && o.y1 > y0 + 0.05 && o.y0 < y1 - 0.05) return true;
    }
    return false;
}
/** Battens on a wall that runs along X; `zFace` is the outer face. */
function battenX(x0, x1, zFace, y0, y1, mat, openings = []) {
    for (let u = x0 + BATTEN_STEP * 0.6; u < x1 - 0.12; u += BATTEN_STEP) {
        if (battenBlocked(openings, u, y0, y1)) continue;
        deco(0.14, y1 - y0, 0.09, u, (y0 + y1) / 2, zFace, mat, { cast: false });
    }
}
/** Battens on a wall that runs along Z; `xFace` is the outer face. */
function battenZ(z0, z1, xFace, y0, y1, mat, openings = []) {
    for (let u = z0 + BATTEN_STEP * 0.6; u < z1 - 0.12; u += BATTEN_STEP) {
        if (battenBlocked(openings, u, y0, y1)) continue;
        deco(0.09, y1 - y0, 0.14, xFace, (y0 + y1) / 2, u, mat, { cast: false });
    }
}

/** Glass pane + white frame inside an opening. */
function windowGlass(orient, a, b, y0, y1, fixed, mats) {
    const w = b - a, h = y1 - y0, cu = (a + b) / 2, cy = (y0 + y1) / 2;
    if (orient === 'x') {
        deco(w, h, 0.04, cu, cy, fixed, mats.glass, { cast: false });
        deco(w + 0.16, 0.09, 0.14, cu, y1 + 0.045, fixed, mats.trim);
        deco(w + 0.16, 0.11, 0.16, cu, y0 - 0.05, fixed, mats.trim);
        deco(0.09, h + 0.2, 0.14, a - 0.045, cy, fixed, mats.trim);
        deco(0.09, h + 0.2, 0.14, b + 0.045, cy, fixed, mats.trim);
        deco(0.05, h, 0.05, cu, cy, fixed, mats.trim, { cast: false });
    } else {
        deco(0.04, h, w, fixed, cy, cu, mats.glass, { cast: false });
        deco(0.14, 0.09, w + 0.16, fixed, y1 + 0.045, cu, mats.trim);
        deco(0.16, 0.11, w + 0.16, fixed, y0 - 0.05, cu, mats.trim);
        deco(0.14, h + 0.2, 0.09, fixed, cy, a - 0.045, mats.trim);
        deco(0.14, h + 0.2, 0.09, fixed, cy, b + 0.045, mats.trim);
        deco(0.05, h, 0.05, fixed, cy, cu, mats.trim, { cast: false });
    }
}

// ── stairs ──────────────────────────────────────────────────────────────────
/**
 * A climbable flight. Every tread gets its own AABB and the rise is checked
 * against the physics step height (0.55 m) — get that wrong and the flight
 * silently becomes a wall.  (bx,bz) is the foot of the flight; `dir` is the
 * direction of travel while ascending, in canonical coordinates, so the mirror
 * takes care of itself.
 */
function stairFlight(bx, bz, axis, dir, width, y0, y1, steps, run, mat, tag = 'stairs') {
    const rise = (y1 - y0) / steps;
    if (rise > 0.55) console.warn('[map] stair rise', rise.toFixed(3), 'exceeds step height');
    for (let i = 0; i < steps; i++) {
        const yTop = y0 + rise * (i + 1);
        const off = run * (i + 0.5);
        const px = axis === 'x' ? bx + dir * off : bx;
        const pz = axis === 'z' ? bz + dir * off : bz;
        const w = axis === 'x' ? run + 0.02 : width;
        const d = axis === 'z' ? run + 0.02 : width;
        box(w, 0.18, d, px, yTop - 0.09, pz, mat, { tag });
    }
    return rise;
}

/** Stringers + handrail alongside a flight built by stairFlight. */
function stairRails(bx, bz, axis, dir, width, y0, y1, steps, run, mat) {
    const rise = (y1 - y0) / steps;
    const len = Math.hypot(run * steps, rise * steps);
    const ang = Math.atan2(rise, run);
    const cu = run * steps / 2;
    const cy = (y0 + y1) / 2 - 0.14;
    for (const side of [-1, 1]) {
        const ox = axis === 'z' ? side * (width / 2 + 0.06) : 0;
        const oz = axis === 'x' ? side * (width / 2 + 0.06) : 0;
        const px = bx + (axis === 'x' ? dir * cu : ox);
        const pz = bz + (axis === 'z' ? dir * cu : oz);
        if (axis === 'z') {
            deco(0.1, 0.34, len, px, cy, pz, mat, { rotX: -dir * ang, cast: false });
            deco(0.08, 0.09, len, px, cy + 1.02, pz, mat, { rotX: -dir * ang, cast: false });
        } else {
            deco(len, 0.34, 0.1, px, cy, pz, mat, { rotZ: dir * ang, cast: false });
            deco(len, 0.09, 0.08, px, cy + 1.02, pz, mat, { rotZ: dir * ang, cast: false });
        }
        // three posts so the rail does not float
        for (let i = 1; i <= 3; i++) {
            const f = i / 4, u = run * steps * f, yy = y0 + (y1 - y0) * f;
            const qx = bx + (axis === 'x' ? dir * u : ox);
            const qz = bz + (axis === 'z' ? dir * u : oz);
            deco(0.08, 1.0, 0.08, qx, yy + 0.5, qz, mat, { cast: false });
        }
    }
}

// ============================================================================
// HOUSE  (canonical east lot; call with CTX.s = -1 for the teal one)
// ============================================================================
function buildHouse(kind) {
    const mats = {
        siding: kind === 'yellow' ? M.sidingYellow() : M.sidingTeal(),
        trim: M.trim(),
        roof: M.shingles(),
        wall: M.plaster(),
        paper: M.wallpaper(),
        floor: M.woodFloor(),
        carpet: M.carpet(),
        tile: M.tile(),
        wood: M.wood(),
        glass: M.glassDirty(),
        stone: M.brick(),
        concrete: M.concrete(),
        metal: M.plain(0x8b9095, 0.4, 0.8),
        dark: M.plain(0x2a2c2e, 0.7, 0.2)
    };

    const { x0, x1, z0, z1, t, stone, floor, mid, midTop, top, ceil } = H;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;

    // ── foundation + ground floor ──
    box(w + 0.5, 0.5, d + 0.5, cx, 0.0, cz, mats.concrete, { tag: 'concrete' });
    box(w, floor, d, cx, floor / 2, cz, mats.floor, { tag: 'wood' });
    deco(w - 0.3, 0.03, 3.0, cx, floor + 0.015, z1 - 1.7, mats.tile, { cast: false });   // kitchen tile

    // ── ground floor exterior walls ──
    const WIN = { y0: 1.15, y1: 2.35 };
    const frontDoor = [{ a: -6.7, b: -4.9, y0: floor, y1: 2.55 }];
    const frontWin = [{ a: -8.5, b: -7.1, ...WIN }, { a: -3.9, b: -2.5, ...WIN }];
    const backDoor = [{ a: -3.9, b: -2.3, y0: floor, y1: 2.5 }];
    const backWin = [{ a: -8.4, b: -7.0, ...WIN }];
    const northWin = [{ a: 19.6, b: 21.0, ...WIN }, { a: 24.4, b: 25.8, ...WIN }];
    const garDoor = [{ a: 20.6, b: 22.2, y0: floor, y1: 2.5 }];

    // stone base course, then the boarded wall above it
    wallZ(z0, z1, x0, 0, stone, t + 0.16, mats.stone, frontDoor);
    wallZ(z0, z1, x0, stone, mid, t, mats.siding, [...frontDoor, ...frontWin]);
    wallZ(z0, z1, x1, 0, stone, t + 0.16, mats.stone, backDoor);
    wallZ(z0, z1, x1, stone, mid, t, mats.siding, [...backDoor, ...backWin]);
    wallX(x0, x1, z0, 0, stone, t + 0.16, mats.stone, []);
    wallX(x0, x1, z0, stone, mid, t, mats.siding, northWin);
    wallX(x0, x1, z1, 0, stone, t + 0.16, mats.stone, garDoor);
    wallX(x0, x1, z1, stone, mid, t, mats.siding, garDoor);

    battenZ(z0, z1, x0 - t / 2 - 0.03, stone, mid, mats.siding, [...frontDoor, ...frontWin]);
    battenZ(z0, z1, x1 + t / 2 + 0.03, stone, mid, mats.siding, [...backDoor, ...backWin]);
    battenX(x0, x1, z0 - t / 2 - 0.03, stone, mid, mats.siding, northWin);

    // interior plaster skin, ground floor
    linerZ(z0 + t, z1 - t, x0 + t / 2 + 0.03, floor, mid, mats.wall, [...frontDoor, ...frontWin]);
    linerZ(z0 + t, z1 - t, x1 - t / 2 - 0.03, floor, mid, mats.wall, [...backDoor, ...backWin]);
    linerX(x0 + t, x1 - t, z0 + t / 2 + 0.03, floor, mid, mats.wall, northWin);
    linerX(x0 + t, x1 - t, z1 - t / 2 - 0.03, floor, mid, mats.wall, garDoor);
    for (const zz of [z0 + t / 2 + 0.07, z1 - t / 2 - 0.07])
        deco(w - 2 * t, 0.12, 0.03, cx, floor + 0.06, zz, mats.trim, { cast: false });

    windowGlass('z', -8.5, -7.1, WIN.y0, WIN.y1, x0, mats);
    windowGlass('z', -3.9, -2.5, WIN.y0, WIN.y1, x0, mats);
    windowGlass('z', -8.4, -7.0, WIN.y0, WIN.y1, x1, mats);
    windowGlass('x', 19.6, 21.0, WIN.y0, WIN.y1, z0, mats);
    windowGlass('x', 24.4, 25.8, WIN.y0, WIN.y1, z0, mats);

    // panelled front door, hung open on its hinge, with the wall lantern beside it
    deco(0.22, 0.14, 2.1, x0 - 0.12, 2.62, -5.8, mats.trim);
    deco(0.22, 2.5, 0.16, x0 - 0.12, 1.4, -6.8, mats.trim);
    deco(0.22, 2.5, 0.16, x0 - 0.12, 1.4, -4.8, mats.trim);
    deco(0.08, 2.2, 1.7, 17.29, 1.35, -6.24, mats.wood, { rotY: -1.0 });
    deco(0.09, 1.1, 0.9, 17.29, 1.55, -6.24, mats.trim, { rotY: -1.0, cast: false });
    deco(0.16, 0.34, 0.16, x0 - 0.24, 2.15, -4.45, mats.dark, { cast: false });
    deco(0.2, 0.24, 0.2, x0 - 0.24, 1.92, -4.45, M.emissiveMat(0xffd79a, 0.9), { cast: false });

    // ── first-floor slab, with the stairwell void at the back-south corner ──
    box(7.4, midTop - mid, 7.6, 21.7, (mid + midTop) / 2, -5.2, mats.floor, { tag: 'wood' });
    box(2.6, midTop - mid, 3.4, 26.7, (mid + midTop) / 2, -7.3, mats.floor, { tag: 'wood' });
    deco(7.4 - t, 0.05, 7.6 - t, 21.7, mid - 0.03, -5.2, mats.wall, { cast: false });
    deco(2.6, 0.05, 3.4 - t, 26.7, mid - 0.03, -7.3, mats.wall, { cast: false });

    // ── internal staircase: back-south corner, climbing north into the void ──
    stairFlight(26.8, -1.9, 'z', -1, 1.6, floor, midTop, 11, 0.34, mats.wood);
    stairRails(26.8, -1.9, 'z', -1, 1.6, floor, midTop, 11, 0.34, mats.wood);

    // ── ground-floor divider: living room north, kitchen south.
    // It stops at 21.4 and becomes a cased archway. A doorway plus the stair
    // would have pinched the route to the kitchen down to 0.8 m, which is
    // narrower than a soldier and would have sealed half the house off.
    wallX(x0 + t / 2, 21.4, -4.9, floor, mid, 0.2, mats.wall, []);
    box(3.9, 0.55, 0.2, 23.35, 2.775, -4.9, mats.wall, { tag: 'header' });
    deco(0.16, mid - floor, 0.3, 21.4, (floor + mid) / 2, -4.9, mats.trim, { cast: false });

    // ── upper floor exterior walls ──
    const UWIN = { y0: 4.05, y1: 5.35 };
    const balDoor = [{ a: -8.3, b: -5.6, y0: midTop, y1: 5.55 }];
    const upFrontWin = [{ a: -4.2, b: -2.8, ...UWIN }];
    const upBackWin = [{ a: -8.4, b: -7.0, ...UWIN }, { a: -3.6, b: -2.2, ...UWIN }];
    const upNorthWin = [{ a: 20.0, b: 21.4, ...UWIN }];
    // low sill on purpose — this is the way out onto the garage roof
    const roofWin = [{ a: 23.2, b: 24.8, y0: 3.55, y1: 5.15 }];

    wallZ(z0, z1, x0, midTop, top, t, mats.siding, [...balDoor, ...upFrontWin]);
    wallZ(z0, z1, x1, midTop, top, t, mats.siding, upBackWin);
    wallX(x0, x1, z0, midTop, top, t, mats.siding, upNorthWin);
    wallX(x0, x1, z1, midTop, top, t, mats.siding, roofWin);

    battenZ(z0, z1, x0 - t / 2 - 0.03, midTop, top, mats.siding, [...balDoor, ...upFrontWin]);
    battenZ(z0, z1, x1 + t / 2 + 0.03, midTop, top, mats.siding, upBackWin);
    battenX(x0, x1, z0 - t / 2 - 0.03, midTop, top, mats.siding, upNorthWin);
    battenX(x0, x1, z1 + t / 2 + 0.03, midTop, top, mats.siding, roofWin);

    linerZ(z0 + t, z1 - t, x0 + t / 2 + 0.03, midTop, top, mats.paper, [...balDoor, ...upFrontWin]);
    linerZ(z0 + t, z1 - t, x1 - t / 2 - 0.03, midTop, top, mats.paper, upBackWin);
    linerX(x0 + t, x1 - t, z0 + t / 2 + 0.03, midTop, top, mats.paper, upNorthWin);
    linerX(x0 + t, x1 - t, z1 - t / 2 - 0.03, midTop, top, mats.paper, roofWin);

    windowGlass('z', -4.2, -2.8, UWIN.y0, UWIN.y1, x0, mats);
    windowGlass('z', -8.4, -7.0, UWIN.y0, UWIN.y1, x1, mats);
    windowGlass('z', -3.6, -2.2, UWIN.y0, UWIN.y1, x1, mats);
    windowGlass('x', 20.0, 21.4, UWIN.y0, UWIN.y1, z0, mats);
    // No pane in the garage-roof window: it is a traversal route, and glass you
    // walk through reads as a bug.
    deco(1.6, 0.1, 0.2, 24.0, 5.2, z1 + 0.06, mats.trim, { cast: false });
    deco(1.7, 0.12, 0.24, 24.0, 3.5, z1 + 0.06, mats.trim, { cast: false });
    deco(0.1, 1.6, 0.2, 23.15, 4.35, z1 + 0.06, mats.trim, { cast: false });
    deco(0.1, 1.6, 0.2, 24.85, 4.35, z1 + 0.06, mats.trim, { cast: false });
    // balcony door frame + one leaf swung open over the deck
    deco(0.22, 0.16, 3.1, x0 - 0.12, 5.63, -6.95, mats.trim);
    deco(0.06, 2.1, 1.3, 17.45, 4.4, -7.95, mats.glass, { rotY: -1.0, cast: false });

    // ── upper divider + stairwell railing ──
    wallX(x0 + t / 2, 25.4, -4.9, midTop, top, 0.2, mats.paper, [{ a: 21.8, b: 23.6, y0: midTop, y1: 5.5 }]);
    box(0.14, 1.0, 4.2, 25.4, midTop + 0.5, -3.5, mats.wood);

    // ── ceiling ──
    box(w, ceil - top, d, cx, (top + ceil) / 2, cz, mats.wall, { tag: 'ceiling' });
    deco(w - 2 * t, 0.05, d - 2 * t, cx, top - 0.03, cz, mats.wall, { cast: false });

    // ── gable roof, ridge running north–south above the middle of the plan ──
    const eaveX0 = x0 - 0.6, eaveX1 = x1 + 0.6;
    const runR = (eaveX1 - eaveX0) / 2, rise = H.ridge - ceil;
    const slopeLen = Math.hypot(runR, rise);
    const ang = Math.atan2(rise, runR);
    for (const sgn of [-1, 1]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(slopeLen, 0.22, d + 1.2), mats.roof);
        m.position.set((cx + sgn * runR / 2) * CTX.s, ceil + rise / 2, cz);
        m.rotation.z = -sgn * ang * CTX.s;
        m.castShadow = true; m.receiveShadow = true;
        CTX.scene.add(m);
    }
    deco(0.42, 0.24, d + 1.2, cx, H.ridge, cz, mats.roof);
    for (const gz of [z0 - 0.2, z1 + 0.2]) {
        for (let i = 0; i < 6; i++) {
            const f0 = i / 6, f1 = (i + 1) / 6;
            const yA = ceil + rise * f0, yB = ceil + rise * f1;
            deco((eaveX1 - eaveX0) * (1 - f0), yB - yA + 0.02, 0.4, cx, (yA + yB) / 2, gz, mats.siding);
        }
    }
    deco(0.16, 0.22, d + 1.3, eaveX0, ceil - 0.02, cz, mats.trim);
    deco(0.16, 0.22, d + 1.3, eaveX1, ceil - 0.02, cz, mats.trim);

    // ── exterior stone chimney on the north gable ──
    box(1.0, 9.4, 0.9, 25.0, 4.7, -9.55, mats.stone, { tag: 'brick' });
    deco(1.2, 0.2, 1.1, 25.0, 9.5, -9.55, mats.concrete);

    buildPorchAndBalcony(mats, kind);
    return mats;
}

// ── porch, balcony, pergola, exterior staircase ─────────────────────────────
function buildPorchAndBalcony(mats, kind) {
    const { midTop, mid, top } = H;
    const pw = P.x1 - P.x0, pd = P.z1 - P.z0;
    const pcx = (P.x0 + P.x1) / 2, pcz = (P.z0 + P.z1) / 2;

    // timber deck at ground level
    box(pw, 0.28, pd, pcx, 0.14, pcz, mats.wood, { tag: 'wood' });
    deco(pw, 0.04, 0.1, pcx, 0.3, P.z0 + 0.05, mats.trim, { cast: false });
    // steps up from the front walk
    box(0.36, 0.15, 2.4, 15.05, 0.075, -5.8, mats.concrete, { tag: 'step' });
    box(0.4, 0.28, 2.4, 15.42, 0.14, -5.8, mats.concrete, { tag: 'step' });

    // posts carrying the balcony
    for (const pz of [-8.7, -6.3, -3.4, -1.85]) {
        box(0.22, mid - 0.28, 0.22, 15.78, 0.28 + (mid - 0.28) / 2, pz, mats.trim, { tag: 'pillar' });
    }

    // balcony deck
    box(pw, midTop - mid, pd, pcx, (mid + midTop) / 2, pcz, mats.wood, { tag: 'wood' });
    // railings — the north edge is left open for the staircase
    box(0.12, 0.95, pd, 15.66, midTop + 0.475, pcz, mats.trim);
    box(pw, 0.95, 0.12, pcx, midTop + 0.475, P.z1 - 0.06, mats.trim);
    for (let i = 0; i <= 12; i++) {
        deco(0.06, 0.76, 0.06, 15.66, midTop + 0.38, P.z0 + 0.3 + i * ((pd - 0.6) / 12), mats.trim, { cast: false });
    }

    // pergola over the balcony
    for (const pz of [-8.7, -5.3, -1.9]) {
        deco(0.2, 2.55, 0.2, 15.85, midTop + 1.275, pz, mats.wood);
    }
    deco(0.18, 0.26, pd - 0.2, 15.85, 5.93, pcz, mats.wood);
    deco(0.14, 0.24, pd - 0.2, 17.86, 5.93, pcz, mats.wood);
    for (let i = 0; i < 12; i++) {
        deco(2.35, 0.14, 0.11, 16.86, 6.12, P.z0 + 0.6 + i * 0.6, mats.wood);
    }

    // ── the signature piece: exterior stair from the balcony to the side yard.
    // 12 treads of 0.275 m, comfortably inside the 0.55 m physics step.
    stairFlight(16.8, -12.79, 'z', 1, 1.8, 0.0, midTop, 12, 0.32, mats.wood);
    stairRails(16.8, -12.79, 'z', 1, 1.8, 0.0, midTop, 12, 0.32, mats.wood);
    // small landing pad at the foot so the last tread meets flat ground
    deco(2.2, 0.06, 1.2, 16.8, 0.05, -13.3, mats.concrete, { cast: false });

    // Fascia band where the pergola meets the wall. Deliberately NOT a slab
    // over the whole balcony — the pergola has to stay open to the sky.
    deco(0.18, 0.24, pd + 0.3, P.x1 - 0.05, top + 0.24, pcz, mats.trim, { cast: false });

    // house number, placed by hand so the mirrored copy is not backwards
    const plate = M.signMaterial('num' + kind, 128, 64, (c2, W, Hh) => {
        c2.fillStyle = '#2f2f30'; c2.fillRect(0, 0, W, Hh);
        c2.fillStyle = '#e8e4d8'; c2.font = 'bold 40px Georgia'; c2.textAlign = 'center';
        c2.fillText(kind === 'yellow' ? '1421' : '1420', W / 2, 46);
    });
    const num = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.3), plate);
    num.position.set((H.x0 - 0.18) * CTX.s, 2.66, -4.4);
    num.rotation.y = -Math.PI / 2 * CTX.s;
    CTX.scene.add(num);
}

// ============================================================================
// GARAGE — shares the house's south wall, so there is no seam between them
// ============================================================================
function buildGarage(mats) {
    const { x0, x1, z0, z1, h, floor } = G;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;

    box(w + 0.4, 0.3, d + 0.4, cx, 0.0, cz, mats.concrete, { tag: 'concrete' });
    box(w, floor, d, cx, floor / 2, cz, mats.concrete, { tag: 'concrete' });

    // north side is the house wall; build the other three
    wallX(x0, x1, z1, 0, H.stone, 0.44, mats.stone, []);
    wallX(x0, x1, z1, H.stone, h, 0.3, mats.siding, [{ a: 22.4, b: 24.0, y0: 1.4, y1: 2.5 }]);
    wallZ(z0, z1, x1, 0, H.stone, 0.44, mats.stone, []);
    wallZ(z0, z1, x1, H.stone, h, 0.3, mats.siding, []);
    // front face: jambs plus the header over the bay
    wallZ(z0, z1, x0, 0, H.stone, 0.44, mats.stone, [{ a: -1.0, b: 2.6, y0: 0, y1: H.stone }]);
    wallZ(z0, z1, x0, H.stone, h, 0.3, mats.siding, [{ a: -1.0, b: 2.6, y0: 0, y1: 2.5 }]);
    battenX(x0, x1, z1 + 0.18, H.stone, h, mats.siding, [{ a: 22.4, b: 24.0, y0: 1.4, y1: 2.5 }]);
    battenZ(z0, z1, x1 + 0.18, H.stone, h, mats.siding, []);
    windowGlass('x', 22.4, 24.0, 1.4, 2.5, z1, mats);

    // roof — stops inside the house wall so it never pokes into the bedroom
    box(w + 0.7, 0.26, 4.75, cx, h + 0.13, 1.025, mats.roof, { tag: 'roof' });
    deco(w + 0.8, 0.14, 0.16, cx, h + 0.02, 3.42, mats.trim, { cast: false });

    // roller door, rolled up under the header
    deco(0.12, 1.0, 3.4, x0 - 0.2, h - 0.6, 0.8, mats.metal);
    for (let i = 0; i < 4; i++) deco(0.14, 0.06, 3.4, x0 - 0.21, h - 1.02 + i * 0.24, 0.8, mats.dark, { cast: false });

    // ── contents, kept clear of the middle so bots can drive through ──
    box(0.7, 0.1, 2.6, x1 - 0.45, 1.0, cz + 0.1, mats.wood, { tag: 'prop' });
    for (const oz of [cz - 1.0, cz + 1.15]) deco(0.6, 0.85, 0.1, x1 - 0.45, 0.57, oz, mats.wood, { cast: false });
    for (let i = 0; i < 3; i++) deco(0.55, 0.06, 2.2, x1 - 0.42, 1.5 + i * 0.6, cz - 0.4, mats.wood);
    for (const [dx, dz] of [[x0 + 0.85, z1 - 0.7], [x0 + 0.85, z1 - 1.6]]) {
        cylinder(0.32, 0.32, 0.9, 14, dx, 0.6, dz, M.rustyMetal(), { solid: true, tag: 'prop' });
    }
    box(0.9, 0.9, 0.9, x0 + 0.85, 0.6, z0 + 0.85, mats.wood, { tag: 'prop' });
    box(0.7, 0.7, 0.7, x0 + 0.95, 1.4, z0 + 0.8, mats.wood, { tag: 'prop' });
    for (let i = 0; i < 3; i++) {
        const tr = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.14, 8, 16), M.tireTread());
        tr.position.set((x1 - 1.4) * CTX.s, 0.3 + i * 0.24, z1 - 0.75);
        tr.rotation.x = Math.PI / 2; tr.castShadow = true;
        CTX.scene.add(tr);
    }
    CTX.cw.addAABB((x1 - 1.8) * CTX.s, 0, z1 - 1.2, (x1 - 1.0) * CTX.s, 1.0, z1 - 0.3, 'prop');
}

// ============================================================================
// HOUSE INTERIOR
// ============================================================================
function furnishHouse(mats) {
    const fabric = M.vestFabric('couch', '#5c4632');
    const fabric2 = M.vestFabric('couch2', '#3f4f5c');
    const metal = M.plain(0xb9bec2, 0.3, 0.85);
    const dark = M.plain(0x232527, 0.55, 0.25);
    const F = H.floor;

    // ── living room (north half) ──
    box(2.4, 0.45, 0.95, 21.0, F + 0.28, -8.1, fabric, { tag: 'prop' });
    deco(2.4, 0.55, 0.28, 21.0, F + 0.72, -8.45, fabric);
    deco(0.3, 0.5, 0.95, 19.85, F + 0.72, -8.1, fabric);
    deco(0.3, 0.5, 0.95, 22.15, F + 0.72, -8.1, fabric);
    box(1.3, 0.1, 0.65, 21.0, F + 0.42, -6.9, mats.wood, { tag: 'prop' });
    for (const [ox, oz] of [[20.45, -7.15], [21.55, -7.15], [20.45, -6.65], [21.55, -6.65]])
        deco(0.08, 0.38, 0.08, ox, F + 0.19, oz, mats.wood, { cast: false });
    deco(3.4, 0.02, 2.4, 21.0, F + 0.012, -7.3, mats.carpet, { cast: false });
    box(1.5, 0.5, 0.45, 19.6, F + 0.25, -5.35, mats.wood, { tag: 'prop' });
    deco(1.2, 0.72, 0.09, 19.6, F + 0.92, -5.4, dark);
    deco(1.1, 0.62, 0.03, 19.6, F + 0.92, -5.33, M.plain(0x0a0c10, 0.15, 0.4));
    box(0.9, 0.45, 0.9, 23.6, F + 0.28, -7.4, fabric2, { tag: 'prop' });
    deco(0.9, 0.55, 0.25, 23.6, F + 0.72, -7.75, fabric2);
    deco(0.06, 1.5, 0.06, 18.95, F + 0.75, -8.3, dark, { cast: false });
    deco(0.34, 0.3, 0.34, 18.95, F + 1.6, -8.3, M.plain(0xf0e2c0, 0.8, 0));

    // ── kitchen / dining (south half) ──
    const counter = M.plain(0x8d8b84, 0.35, 0.1);
    box(5.0, 0.9, 0.65, 21.5, F + 0.45, -2.05, mats.wood, { tag: 'prop' });
    deco(5.2, 0.08, 0.72, 21.5, F + 0.94, -2.05, counter);
    deco(4.2, 0.75, 0.4, 21.5, F + 1.95, -1.9, mats.wood);
    deco(0.75, 0.1, 0.5, 20.6, F + 0.95, -2.05, metal, { cast: false });
    deco(0.05, 0.3, 0.05, 20.6, F + 1.12, -1.86, metal, { cast: false });
    box(0.85, 1.85, 0.75, 18.85, F + 0.93, -2.15, M.plain(0xd8d8d2, 0.28, 0.55), { tag: 'prop' });
    box(0.75, 0.9, 0.65, 24.5, F + 0.45, -2.05, M.plain(0x2e3033, 0.35, 0.6), { tag: 'prop' });
    deco(0.78, 0.05, 0.68, 24.5, F + 0.93, -2.05, dark, { cast: false });
    // Table pushed up against the divider: it has to leave a clear lane between
    // the living room and the kitchen, or the bots lose half the house.
    box(1.7, 0.1, 1.0, 22.0, F + 0.72, -4.2, mats.wood, { tag: 'prop' });
    for (const [ox, oz] of [[21.3, -4.6], [21.3, -3.8], [22.7, -4.6], [22.7, -3.8]])
        deco(0.09, 0.67, 0.09, ox, F + 0.34, oz, mats.wood, { cast: false });
    for (const oz of [-4.8, -3.6]) {
        box(0.45, 0.08, 0.45, 22.0, F + 0.45, oz, mats.wood, { tag: 'prop' });
        deco(0.45, 0.55, 0.07, 22.0, F + 0.74, oz + (oz < -4 ? -0.2 : 0.2), mats.wood);
    }

    // ── upstairs ──
    const U = H.midTop;
    box(1.5, 0.35, 2.1, 19.6, U + 0.2, -7.0, mats.wood, { tag: 'prop' });
    deco(1.45, 0.22, 2.0, 19.6, U + 0.48, -7.0, M.plain(0xd8d2c4, 0.9, 0));
    deco(1.5, 0.55, 0.12, 19.6, U + 0.5, -8.05, mats.wood);
    deco(0.6, 0.14, 0.35, 19.6, U + 0.66, -7.8, M.plain(0xeceadf, 0.9, 0));
    box(0.5, 0.55, 0.45, 19.6, U + 0.28, -5.6, mats.wood, { tag: 'prop' });
    box(1.3, 0.9, 0.5, 23.9, U + 0.45, -8.2, mats.wood, { tag: 'prop' });
    for (let i = 0; i < 3; i++) deco(1.15, 0.22, 0.05, 23.9, U + 0.2 + i * 0.26, -7.93, dark, { cast: false });
    box(1.5, 0.35, 2.1, 19.4, U + 0.2, -3.4, mats.wood, { tag: 'prop' });
    deco(1.45, 0.22, 2.0, 19.4, U + 0.48, -3.4, M.plain(0xc9c0ae, 0.9, 0));
    box(0.85, 0.85, 0.85, 24.5, U + 0.42, -4.2, mats.wood, { tag: 'prop' });
    box(0.7, 0.7, 0.7, 24.4, U + 1.2, -4.1, mats.wood, { tag: 'prop' });
    deco(2.6, 0.02, 2.0, 22.0, U + 0.012, -6.8, mats.carpet, { cast: false });

    // Interior fill: ONE point light per building. Every point light is
    // evaluated per pixel by every material in the scene, so this is the single
    // most expensive thing a room can ask for. It sits between the two floors
    // and casts no shadows, so it lights upstairs and down at once.
    const l = new THREE.PointLight(0xffdcae, 58, 26, 2);
    l.position.set(22.6 * CTX.s, 3.4, -5.0);
    l.userData.interiorFill = true;      // quality preset can switch these off
    CTX.scene.add(l);
    for (const [lx, ly, lz] of [[21, 2.72, -7.0], [22, 2.72, -3.2], [21, U + 2.42, -6.6], [22, U + 2.42, -3.2]]) {
        deco(0.34, 0.1, 0.34, lx, ly, lz, M.plain(0xfff0d0, 0.6, 0), { cast: false });
    }
}

// ============================================================================
// BUNGALOW — single storey, flanks the access road
// ============================================================================
function buildBungalow(kind) {
    const mats = {
        siding: kind === 'yellow' ? M.sidingWhite() : M.stucco(),
        trim: M.trim(),
        roof: M.shingles(),
        wall: M.plaster(),
        floor: M.woodFloor(),
        carpet: M.carpet(),
        wood: M.wood(),
        glass: M.glassDirty(),
        stone: M.brick(),
        concrete: M.concrete()
    };
    const { x0, x1, z0, z1, t, floor, top, ceil, ridge } = BG;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;

    box(w + 0.5, 0.4, d + 0.5, cx, 0.0, cz, mats.concrete, { tag: 'concrete' });
    box(w, floor, d, cx, floor / 2, cz, mats.floor, { tag: 'wood' });

    const WIN = { y0: 1.1, y1: 2.3 };
    const nDoor = [{ a: 19.6, b: 21.4, y0: floor, y1: 2.5 }];
    const nWin = [{ a: 16.6, b: 18.0, ...WIN }, { a: 23.0, b: 24.4, ...WIN }];
    const wDoor = [{ a: 19.5, b: 21.1, y0: floor, y1: 2.5 }];
    const wWin = [{ a: 23.4, b: 24.8, ...WIN }];
    const sWin = [{ a: 17.5, b: 18.9, ...WIN }, { a: 23.0, b: 24.4, ...WIN }];
    const eWin = [{ a: 19.0, b: 20.4, ...WIN }];

    wallX(x0, x1, z0, 0, 0.85, t + 0.14, mats.stone, nDoor);
    wallX(x0, x1, z0, 0.85, top, t, mats.siding, [...nDoor, ...nWin]);
    wallX(x0, x1, z1, 0, 0.85, t + 0.14, mats.stone, []);
    wallX(x0, x1, z1, 0.85, top, t, mats.siding, sWin);
    wallZ(z0, z1, x0, 0, 0.85, t + 0.14, mats.stone, wDoor);
    wallZ(z0, z1, x0, 0.85, top, t, mats.siding, [...wDoor, ...wWin]);
    wallZ(z0, z1, x1, 0, 0.85, t + 0.14, mats.stone, []);
    wallZ(z0, z1, x1, 0.85, top, t, mats.siding, eWin);

    battenX(x0, x1, z0 - t / 2 - 0.03, 0.85, top, mats.siding, [...nDoor, ...nWin]);
    battenX(x0, x1, z1 + t / 2 + 0.03, 0.85, top, mats.siding, sWin);
    battenZ(z0, z1, x0 - t / 2 - 0.03, 0.85, top, mats.siding, [...wDoor, ...wWin]);
    battenZ(z0, z1, x1 + t / 2 + 0.03, 0.85, top, mats.siding, eWin);

    linerX(x0 + t, x1 - t, z0 + t / 2 + 0.03, floor, top, mats.wall, [...nDoor, ...nWin]);
    linerX(x0 + t, x1 - t, z1 - t / 2 - 0.03, floor, top, mats.wall, sWin);
    linerZ(z0 + t, z1 - t, x0 + t / 2 + 0.03, floor, top, mats.wall, [...wDoor, ...wWin]);
    linerZ(z0 + t, z1 - t, x1 - t / 2 - 0.03, floor, top, mats.wall, eWin);

    windowGlass('x', 16.6, 18.0, WIN.y0, WIN.y1, z0, mats);
    windowGlass('x', 23.0, 24.4, WIN.y0, WIN.y1, z0, mats);
    windowGlass('x', 17.5, 18.9, WIN.y0, WIN.y1, z1, mats);
    windowGlass('x', 23.0, 24.4, WIN.y0, WIN.y1, z1, mats);
    windowGlass('z', 23.4, 24.8, WIN.y0, WIN.y1, x0, mats);
    windowGlass('z', 19.0, 20.4, WIN.y0, WIN.y1, x1, mats);

    // internal divider
    wallZ(z0 + t, z1 - t, 21.6, floor, top, 0.2, mats.wall, [{ a: 18.4, b: 20.2, y0: floor, y1: 2.5 }]);

    // ceiling + shallow gable
    box(w, ceil - top, d, cx, (top + ceil) / 2, cz, mats.wall, { tag: 'ceiling' });
    const eZ0 = z0 - 0.55, eZ1 = z1 + 0.55;
    const runR = (eZ1 - eZ0) / 2, rise = ridge - ceil;
    const slopeLen = Math.hypot(runR, rise), ang = Math.atan2(rise, runR);
    for (const sgn of [-1, 1]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w + 1.1, 0.22, slopeLen), mats.roof);
        m.position.set(cx * CTX.s, ceil + rise / 2, cz + sgn * runR / 2);
        m.rotation.x = sgn * ang;
        m.castShadow = true; m.receiveShadow = true;
        CTX.scene.add(m);
    }
    deco(w + 1.1, 0.24, 0.4, cx, ridge, cz, mats.roof);
    for (const gx of [x0 - 0.2, x1 + 0.2]) {
        for (let i = 0; i < 4; i++) {
            const f0 = i / 4, f1 = (i + 1) / 4;
            const yA = ceil + rise * f0, yB = ceil + rise * f1;
            deco(0.4, yB - yA + 0.02, (eZ1 - eZ0) * (1 - f0), gx, (yA + yB) / 2, cz, mats.siding);
        }
    }
    deco(w + 1.2, 0.2, 0.16, cx, ceil - 0.02, eZ0, mats.trim);
    deco(w + 1.2, 0.2, 0.16, cx, ceil - 0.02, eZ1, mats.trim);

    // entry canopy over the north door
    deco(3.2, 0.16, 1.5, 20.5, 2.85, z0 - 0.7, mats.roof);
    for (const px of [19.1, 21.9]) box(0.14, 2.7, 0.14, px, 1.4, z0 - 1.3, mats.trim, { tag: 'pillar' });
    box(3.2, 0.16, 1.4, 20.5, 0.1, z0 - 0.75, mats.concrete, { tag: 'concrete' });

    // ── contents ──
    const fabric = M.vestFabric('bung', '#6a5a44');
    box(2.2, 0.45, 0.9, 18.6, floor + 0.28, 18.2, fabric, { tag: 'prop' });
    deco(2.2, 0.55, 0.26, 18.6, floor + 0.72, 17.9, fabric);
    box(1.2, 0.1, 0.6, 18.6, floor + 0.42, 19.8, mats.wood, { tag: 'prop' });
    deco(3.0, 0.02, 2.2, 18.6, floor + 0.012, 19.2, mats.carpet, { cast: false });
    box(1.5, 0.35, 2.1, 25.2, floor + 0.2, 19.4, mats.wood, { tag: 'prop' });
    deco(1.45, 0.22, 2.0, 25.2, floor + 0.48, 19.4, M.plain(0xcfc7b4, 0.9, 0));
    box(1.6, 0.9, 0.55, 23.0, floor + 0.45, 25.2, mats.wood, { tag: 'prop' });
    box(0.85, 0.85, 0.85, 17.0, floor + 0.42, 24.6, mats.wood, { tag: 'prop' });
    box(0.7, 0.7, 0.7, 17.1, floor + 1.2, 24.5, mats.wood, { tag: 'prop' });
    for (let i = 0; i < 3; i++) deco(1.6, 0.06, 0.4, 25.4, 1.1 + i * 0.6, 24.4, mats.wood);
    // emissive fixtures only — the point-light budget is spent on the two houses
    for (const [lx, lz] of [[18.6, 21.0], [24.4, 21.0]]) {
        deco(0.36, 0.1, 0.36, lx, top - 0.12, lz, M.plain(0xfff0d0, 0.6, 0), { cast: false });
    }
}

// ============================================================================
// FIRE STATION — built once, symmetric about x = 0 by construction
// ============================================================================
function fireStation() {
    const mats = {
        wall: M.stucco(),
        stone: M.brick(),
        trim: M.trim(),
        roof: M.shingles(),
        plaster: M.plaster(),
        concrete: M.concrete(),
        wood: M.wood(),
        glass: M.glassDirty(),
        metal: M.plain(0x8b9095, 0.4, 0.8),
        red: M.paintedMetal('rollup', '#a8241d', 0.45)
    };
    const { x0, x1, z0, z1, t, floor, top, ridge } = FS;
    const cx = 0, cz = (z0 + z1) / 2, w = x1 - x0, d = z1 - z0;

    box(w + 0.8, 0.4, d + 0.8, cx, 0.0, cz, mats.concrete, { tag: 'concrete' });
    box(w, floor, d, cx, floor / 2, cz, mats.concrete, { tag: 'concrete' });

    // three bays facing south
    const bays = [
        { a: -9.6, b: -5.8, y0: 0, y1: 4.3 },
        { a: -1.9, b: 1.9, y0: 0, y1: 4.3 },
        { a: 5.8, b: 9.6, y0: 0, y1: 4.3 }
    ];
    const nDoor = [{ a: -1.0, b: 1.0, y0: 0, y1: 2.5 }];
    const nWin = [{ a: -7.4, b: -5.6, y0: 1.4, y1: 3.0 }, { a: 5.6, b: 7.4, y0: 1.4, y1: 3.0 }];
    const sideWin = [{ a: -29.5, b: -27.7, y0: 1.4, y1: 3.0 }, { a: -27.0, b: -25.2, y0: 1.4, y1: 3.0 }];

    wallX(x0, x1, z1, 0, 1.2, t + 0.16, mats.stone, bays);
    wallX(x0, x1, z1, 1.2, top, t, mats.wall, bays);
    wallX(x0, x1, z0, 0, 1.2, t + 0.16, mats.stone, nDoor);
    wallX(x0, x1, z0, 1.2, top, t, mats.wall, [...nDoor, ...nWin]);
    for (const wx of [x0, x1]) {
        wallZ(z0, z1, wx, 0, 1.2, t + 0.16, mats.stone, []);
        wallZ(z0, z1, wx, 1.2, top, t, mats.wall, sideWin);
        for (const o of sideWin) windowGlass('z', o.a, o.b, o.y0, o.y1, wx, mats);
    }
    for (const o of nWin) windowGlass('x', o.a, o.b, o.y0, o.y1, z0, mats);

    // interior skin
    linerX(x0 + t, x1 - t, z1 - t / 2 - 0.03, floor, top, mats.plaster, bays);
    linerX(x0 + t, x1 - t, z0 + t / 2 + 0.03, floor, top, mats.plaster, [...nDoor, ...nWin]);
    linerZ(z0 + t, z1 - t, x0 + t / 2 + 0.03, floor, top, mats.plaster, sideWin);
    linerZ(z0 + t, z1 - t, x1 - t / 2 - 0.03, floor, top, mats.plaster, sideWin);

    // red roll-up doors, rolled up so all three bays stay open to run through.
    // z1 is the SOUTH face, so the panels hang outside the wall, not inside it.
    for (const b of bays) {
        deco(b.b - b.a, 1.05, 0.14, (b.a + b.b) / 2, 3.72, z1 + 0.26, mats.red);
        for (let i = 0; i < 4; i++) {
            deco(b.b - b.a, 0.05, 0.16, (b.a + b.b) / 2, 3.3 + i * 0.24, z1 + 0.27, M.plain(0x6d1a15, 0.6, 0.2), { cast: false });
        }
        deco(b.b - b.a + 0.5, 0.26, 0.34, (b.a + b.b) / 2, 4.45, z1 + 0.14, mats.trim);
    }

    // sign — placed once, never mirrored
    const face = M.signMaterial('firehouse', 1024, 128, (c, W, Hh) => {
        c.fillStyle = '#8c1f18'; c.fillRect(0, 0, W, Hh);
        c.strokeStyle = '#f0e6cd'; c.lineWidth = 6; c.strokeRect(9, 9, W - 18, Hh - 18);
        c.fillStyle = '#f7efd9'; c.textAlign = 'center';
        c.font = 'bold 70px Impact';
        c.fillText('NUKETOWN FIRE DEPT.', W / 2, 88);
    });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(8.0, 1.0), face);
    sign.position.set(0, 5.0, z1 + 0.24);
    CTX.scene.add(sign);

    // ── shallow-pitch roof.  Collision follows the slope as eight flat strips,
    // each 0.2 m above the last, so the walkable surface matches what is drawn.
    const eZ0 = z0 - 0.6, eZ1 = z1 + 0.6;
    const runR = (eZ1 - eZ0) / 2, rise = ridge - FS_EAVE;
    const slopeLen = Math.hypot(runR, rise), ang = Math.atan2(rise, runR);
    for (const sgn of [-1, 1]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w + 1.2, 0.24, slopeLen), mats.roof);
        m.position.set(0, FS_EAVE + rise / 2, cz + sgn * runR / 2);
        m.rotation.x = sgn * ang;
        m.castShadow = true; m.receiveShadow = true;
        CTX.scene.add(m);
    }
    deco(w + 1.2, 0.26, 0.5, 0, ridge, cz, mats.roof);
    const strips = 8, stripD = (eZ1 - eZ0) / strips;
    for (let i = 0; i < strips; i++) {
        const zc = eZ0 + stripD * (i + 0.5);
        const y = ridge - (rise / runR) * Math.abs(zc - cz);
        CTX.cw.addAABB(-(w / 2 + 0.6), y - 0.28, zc - stripD / 2, w / 2 + 0.6, y, zc + stripD / 2, 'roof');
    }
    deco(w + 1.3, 0.22, 0.16, 0, FS_EAVE - 0.04, eZ0, mats.trim);
    deco(w + 1.3, 0.22, 0.16, 0, FS_EAVE - 0.04, eZ1, mats.trim);

    // ── external roof stairs, one at each end (mirror pair) ──
    for (const sx of [-1, 1]) {
        stairFlight(sx * 12.0, z1, 'z', -1, 1.8, 0.0, 6.28, 14, 0.42, mats.metal, 'stairs');
        stairRails(sx * 12.0, z1, 'z', -1, 1.8, 0.0, 6.28, 14, 0.42, mats.metal);
        box(1.8, 0.2, 1.4, sx * 12.0, 6.18, -25.5, mats.metal, { tag: 'platform' });
        box(0.1, 1.0, 1.4, sx * 12.85, 6.78, -25.5, mats.metal);
    }

    // ── open interior: symmetric cover only ──
    for (const sx of [-1, 1]) {
        box(0.6, top - floor, 0.6, sx * 5.5, (floor + top) / 2, -25.0, mats.concrete, { tag: 'pillar' });
        box(1.1, 2.0, 0.55, sx * 8.6, floor + 1.0, z0 + 0.6, M.plain(0x4a5a62, 0.5, 0.6), { tag: 'prop' });
        box(1.1, 2.0, 0.55, sx * 7.3, floor + 1.0, z0 + 0.6, M.plain(0x4a5a62, 0.5, 0.6), { tag: 'prop' });
        box(1.0, 1.0, 1.0, sx * 3.4, floor + 0.5, -29.0, mats.wood, { tag: 'cover' });
        box(0.8, 0.8, 0.8, sx * 3.3, floor + 1.4, -29.1, mats.wood, { tag: 'cover' });
        box(1.6, 0.9, 0.7, sx * 3.6, floor + 0.45, -30.2, mats.wood, { tag: 'prop' });
        cylinder(0.33, 0.33, 0.95, 14, sx * 10.0, floor + 0.48, -21.5, M.rustyMetal(), { solid: true, tag: 'cover' });
        // hose reel
        const reel = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.16, 8, 18), M.plain(0xb8352a, 0.7, 0.1));
        reel.position.set(sx * 10.2, 1.9, -27.5);
        reel.rotation.y = Math.PI / 2;
        reel.castShadow = true;
        CTX.scene.add(reel);
    }
    const l = new THREE.PointLight(0xffe0b4, 60, 30, 2);
    l.position.set(0, 3.8, -25.5);
    l.userData.interiorFill = true;
    CTX.scene.add(l);
    for (const lx of [-6, 0, 6]) deco(0.5, 0.12, 1.2, lx, top - 0.2, -25, M.plain(0xfff0d0, 0.6, 0), { cast: false });
}

// ============================================================================
// PROPS
// ============================================================================
function mannequin(x, z, rotY, pose = 0) {
    const m = M.mannequinPlastic();
    const g = new THREE.Group();
    const p = (geo, px, py, pz, rx = 0, rz = 0) => {
        const mm = new THREE.Mesh(geo, m);
        mm.position.set(px, py, pz); mm.rotation.set(rx, 0, rz);
        mm.castShadow = true; g.add(mm);
    };
    p(new THREE.CylinderGeometry(0.075, 0.09, 0.78, 8), -0.09, 0.39, 0);
    p(new THREE.CylinderGeometry(0.075, 0.09, 0.78, 8), 0.09, 0.39, 0);
    p(new THREE.CylinderGeometry(0.17, 0.14, 0.24, 10), 0, 0.88, 0);
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.19, 0.62, 10), m);
    torso.position.set(0, 1.30, 0); torso.castShadow = true; g.add(torso);
    p(new THREE.SphereGeometry(0.115, 12, 10), 0, 1.72, 0);
    p(new THREE.CylinderGeometry(0.055, 0.06, 0.16, 8), 0, 1.60, 0);
    const armGeo = new THREE.CylinderGeometry(0.05, 0.055, 0.62, 8);
    if (pose === 0) { p(armGeo, -0.24, 1.28, 0, 0, 0.14); p(armGeo, 0.24, 1.28, 0, 0, -0.14); }
    else if (pose === 1) { p(armGeo, -0.26, 1.30, 0, 0, 0.2); p(armGeo, 0.32, 1.55, 0, 0, -1.15); }
    else { p(armGeo, -0.36, 1.50, 0, 0, 1.1); p(armGeo, 0.36, 1.50, 0, 0, -1.1); }

    g.position.set(x * CTX.s, 0, z);
    g.rotation.y = rotY * CTX.s;
    CTX.scene.add(g);
    CTX.cw.addAABB(x * CTX.s - 0.3, 0, z - 0.3, x * CTX.s + 0.3, 1.55, z + 0.3, 'mannequin');
}

function picketRun(x0, z0, x1, z1) {
    // one alpha-cut panel instead of dozens of little boards
    if (!picketRun.mat) {
        const c = document.createElement('canvas'); c.width = 128; c.height = 64;
        const g = c.getContext('2d');
        g.clearRect(0, 0, 128, 64);
        g.fillStyle = '#f2eee4';
        for (let i = 0; i < 8; i++) {
            const x = i * 16 + 2;
            g.fillRect(x, 10, 11, 54);
            g.beginPath(); g.moveTo(x, 10); g.lineTo(x + 5.5, 2); g.lineTo(x + 11, 10); g.closePath(); g.fill();
        }
        g.fillStyle = '#e2ddd0';
        g.fillRect(0, 20, 128, 6); g.fillRect(0, 44, 128, 6);
        const t = new THREE.CanvasTexture(c);
        t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
        picketRun.mat = new THREE.MeshStandardMaterial({
            map: t, transparent: true, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75
        });
    }
    const s = CTX.s;
    const ax = x0 * s, bx = x1 * s;
    const len = Math.hypot(bx - ax, z1 - z0);
    const mat = picketRun.mat.clone();
    mat.map = picketRun.mat.map.clone();
    mat.map.needsUpdate = true;
    mat.map.repeat.set(len / 1.6, 1);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, 1.2), mat);
    m.position.set((ax + bx) / 2, 0.6, (z0 + z1) / 2);
    m.rotation.y = Math.atan2(bx - ax, z1 - z0) + Math.PI / 2;
    m.castShadow = true; m.receiveShadow = true;
    CTX.scene.add(m);
    const pad = 0.12;
    CTX.cw.addAABB(
        Math.min(ax, bx) - pad, 0, Math.min(z0, z1) - pad,
        Math.max(ax, bx) + pad, 1.2, Math.max(z0, z1) + pad, 'fence'
    );
    const wood = M.wood();
    const n = Math.max(1, Math.round(len / 2.4));
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        cylinder(0.06, 0.07, 1.45, 6, x0 + (x1 - x0) * t, 0.72, z0 + (z1 - z0) * t, wood);
    }
}

function chainLinkRun(x0, z0, x1, z1, h = 3.0) {
    const s = CTX.s;
    const ax = x0 * s, bx = x1 * s;
    const len = Math.hypot(bx - ax, z1 - z0);
    const base = M.chainLink();
    const mat = base.clone();
    mat.map = base.map.clone(); mat.map.needsUpdate = true;
    mat.map.repeat.set(len / 1.4, h / 1.4);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(len, h), mat);
    m.position.set((ax + bx) / 2, h / 2, (z0 + z1) / 2);
    m.rotation.y = Math.atan2(bx - ax, z1 - z0) + Math.PI / 2;
    m.receiveShadow = true;
    CTX.scene.add(m);
    const pad = 0.18;
    CTX.cw.addAABB(
        Math.min(ax, bx) - pad, 0, Math.min(z0, z1) - pad,
        Math.max(ax, bx) + pad, h, Math.max(z0, z1) + pad, 'fence'
    );
    const metal = M.plain(0x9aa0a4, 0.42, 0.8);
    const n = Math.max(1, Math.round(len / 3.2));
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        cylinder(0.05, 0.05, h + 0.25, 6, x0 + (x1 - x0) * t, (h + 0.25) / 2, z0 + (z1 - z0) * t, metal);
    }
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, len, 6), metal);
    rail.position.set((ax + bx) / 2, h, (z0 + z1) / 2);
    rail.rotation.set(Math.PI / 2, 0, Math.atan2(z1 - z0, bx - ax) + Math.PI / 2);
    CTX.scene.add(rail);
}

/**
 * Tyre with visible rim and hub. A bare black cylinder viewed end-on just reads
 * as a flat disc. `axis` is the axle direction.
 */
function wheel(x, y, z, radius, width, axis = 'z') {
    const s = CTX.s;
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 18), M.tireTread()));
    const rimMat = M.plain(0x8f959a, 0.35, 0.85);
    const hubMat = M.plain(0x5a5f63, 0.5, 0.7);
    for (const side of [-1, 1]) {
        const rim = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.62, radius * 0.62, 0.02, 16), rimMat);
        rim.position.y = side * (width / 2 + 0.011);
        g.add(rim);
        const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.20, radius * 0.20, 0.03, 10), hubMat);
        hub.position.y = side * (width / 2 + 0.022);
        g.add(hub);
        for (let i = 0; i < 5; i++) {
            const a = (i / 5) * Math.PI * 2;
            const lug = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.02, 6), hubMat);
            lug.position.set(Math.cos(a) * radius * 0.40, side * (width / 2 + 0.02), Math.sin(a) * radius * 0.40);
            g.add(lug);
        }
    }
    g.rotation.x = axis === 'z' ? Math.PI / 2 : 0;
    if (axis === 'x') g.rotation.z = Math.PI / 2;
    g.position.set(x * s, y, z);
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    CTX.scene.add(g);
    return g;
}

/** Yellow bus, parked west of centre in the circle, long axis north–south. */
function schoolBus() {
    const body = M.paintedMetal('bus', '#e8b820', 0.34);
    const dark = M.plain(0x1b1c1e, 0.7, 0.3);
    const chrome = M.plain(0xc8ccd0, 0.18, 0.95);
    const glass = M.glassDirty();
    const bx = -6.6, bz = 0.6;
    const L = 10.6, W = 2.5, Hh = 2.15;

    box(W, Hh, L, bx, 0.72 + Hh / 2, bz, body, { tag: 'vehicle' });
    deco(W + 0.12, 0.14, L + 0.2, bx, 0.72 + Hh + 0.05, bz, body);
    for (const oz of [-2.5, 1.5]) deco(0.7, 0.1, 0.7, bx, 0.72 + Hh + 0.14, bz + oz, M.plain(0xd8d8d0, 0.5, 0.2));
    // bonnet at the north end
    box(W - 0.15, 1.35, 2.1, bx, 1.05, bz - L / 2 - 1.05, body, { tag: 'vehicle' });
    deco(W - 0.2, 0.1, 1.9, bx, 1.72, bz - L / 2 - 1.05, body);
    for (let i = -4; i <= 4; i++) {
        deco(0.05, 0.85, 1.0, bx - W / 2 - 0.02, 2.25, bz + i * 1.1, glass, { cast: false });
        deco(0.05, 0.85, 1.0, bx + W / 2 + 0.02, 2.25, bz + i * 1.1, glass, { cast: false });
    }
    deco(W - 0.3, 1.0, 0.1, bx, 2.3, bz - L / 2 - 0.05, glass, { cast: false });
    deco(W + 0.06, 0.18, L + 0.05, bx, 1.55, bz, dark, { cast: false });
    const sign = M.signMaterial('bus', 512, 96, (c, w, h) => {
        c.fillStyle = '#e8b820'; c.fillRect(0, 0, w, h);
        c.fillStyle = '#141414'; c.font = 'bold 52px Arial'; c.textAlign = 'center';
        c.fillText('NUKETOWN SCHOOL DIST.', w / 2, 66);
    });
    const lettering = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 0.6), sign);
    lettering.position.set(bx + W / 2 + 0.05, 1.05, bz);
    lettering.rotation.y = Math.PI / 2;
    CTX.scene.add(lettering);
    deco(W + 0.1, 0.3, 0.35, bx, 0.62, bz - L / 2 - 2.15, chrome);
    deco(W + 0.1, 0.3, 0.35, bx, 0.62, bz + L / 2 + 0.1, chrome);
    deco(0.6, 0.6, 0.06, bx - W / 2 - 0.35, 1.8, bz + 1.0, M.plain(0xb02020, 0.6, 0.1));
    for (const ox of [-1, 1]) for (const oz of [-4.0, 3.2, 4.4]) {
        wheel(bx + ox * (W / 2 - 0.05), 0.55, bz + oz, 0.55, 0.30, 'x');
    }
    for (const ox of [-0.75, 0.75]) {
        const hl = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), M.emissiveMat(0xfff0c0, 0.6));
        hl.position.set(bx + ox, 1.15, bz - L / 2 - 2.05);
        CTX.scene.add(hl);
    }
}

/** White box truck with a red cab, east of centre. */
function movingTruck() {
    const cab = M.paintedMetal('truckcab', '#b9342a', 0.3);
    const boxm = M.paintedMetal('truckbox', '#e6e0d2', 0.45);
    const dark = M.plain(0x1b1c1e, 0.7, 0.3);
    const glass = M.glassDirty();
    const tx = 6.8, tz = 0.4;

    box(2.4, 1.9, 2.6, tx, 1.55, tz - 2.9, cab, { tag: 'vehicle' });
    deco(2.2, 0.95, 0.1, tx, 2.05, tz - 4.22, glass, { cast: false });
    box(2.55, 2.75, 6.4, tx, 1.95, tz + 1.5, boxm, { tag: 'vehicle' });
    deco(2.3, 2.3, 0.08, tx, 1.9, tz + 4.74, dark, { cast: false });
    deco(2.3, 1.1, 0.12, tx, 2.75, tz + 4.76, boxm, { cast: false });
    box(1.2, 0.1, 1.8, tx, 0.55, tz + 5.6, M.plain(0x8a8f92, 0.6, 0.5), { rotX: 0.42, tag: 'prop' });
    const logo = M.signMaterial('truck', 512, 256, (c, w, h) => {
        c.fillStyle = '#e6e0d2'; c.fillRect(0, 0, w, h);
        c.fillStyle = '#b9342a'; c.font = 'bold 74px Impact'; c.textAlign = 'center';
        c.fillText('U-HAUL IT', w / 2, 110);
        c.fillStyle = '#33383c'; c.font = 'italic 34px Georgia';
        c.fillText('Nevada • 1962', w / 2, 170);
    });
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.9), logo);
    decal.position.set(tx - 1.31, 2.2, tz + 1.5);
    decal.rotation.y = -Math.PI / 2;
    CTX.scene.add(decal);
    for (const ox of [-1, 1]) for (const oz of [-3.0, 0.6, 2.0]) {
        wheel(tx + ox * 1.18, 0.52, tz + oz, 0.52, 0.28, 'x');
    }
}

/** Driveway car. `axis` is the long axis of the body. */
function car(x, z, color, kind, axis = 'z') {
    const body = M.paintedMetal('car' + color, color, 0.28);
    const glass = M.glassDirty();
    const chrome = M.plain(0xc8ccd0, 0.15, 0.95);
    const along = (lw, lh, ll, ox, oy, oz, mat, opts) =>
        axis === 'x' ? box(ll, lh, lw, x + oz, oy, z + ox, mat, opts)
                     : box(lw, lh, ll, x + ox, oy, z + oz, mat, opts);
    const alongD = (lw, lh, ll, ox, oy, oz, mat, opts) =>
        axis === 'x' ? deco(ll, lh, lw, x + oz, oy, z + ox, mat, opts)
                     : deco(lw, lh, ll, x + ox, oy, z + oz, mat, opts);

    if (kind === 'jeep') {
        along(2.0, 1.0, 4.0, 0, 0.78, 0, body, { tag: 'vehicle' });
        along(1.85, 0.7, 1.7, 0, 1.6, 0.4, body, { tag: 'vehicle' });
        alongD(1.7, 0.6, 0.06, 0, 1.62, -0.44, glass, { cast: false });
    } else {
        along(1.95, 0.85, 4.4, 0, 0.72, 0, body, { tag: 'vehicle' });
        along(1.75, 0.72, 2.2, 0, 1.48, 0.25, body, { tag: 'vehicle' });
        alongD(1.62, 0.6, 0.06, 0, 1.5, -0.86, glass, { cast: false });
        alongD(1.62, 0.6, 0.06, 0, 1.5, 1.36, glass, { cast: false });
        alongD(0.06, 0.55, 2.0, -0.89, 1.5, 0.25, glass, { cast: false });
        alongD(0.06, 0.55, 2.0, 0.89, 1.5, 0.25, glass, { cast: false });
        alongD(2.0, 0.14, 0.2, 0, 0.55, -2.2, chrome);
        alongD(2.0, 0.14, 0.2, 0, 0.55, 2.2, chrome);
    }
    for (const ow of [-1, 1]) for (const ol of [-1.45, 1.45]) {
        if (axis === 'x') wheel(x + ol, 0.36, z + ow * 0.92, 0.36, 0.24, 'z');
        else wheel(x + ow * 0.92, 0.36, z + ol, 0.36, 0.24, 'x');
    }
}

function utilityPole(x, z) {
    const wood = M.wood();
    cylinder(0.11, 0.15, 9.5, 8, x, 4.75, z, wood, { solid: true, tag: 'pole' });
    deco(2.6, 0.14, 0.14, x, 8.6, z, wood);
    deco(2.0, 0.12, 0.12, x, 8.0, z, wood);
    for (const ox of [-1.15, 0, 1.15]) {
        const ins = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.16, 8), M.plain(0x6a8a72, 0.35, 0.1));
        ins.position.set((x + ox) * CTX.s, 8.74, z);
        CTX.scene.add(ins);
    }
}

function powerLine(x0, z0, x1, z1, y, sag) {
    const s = CTX.s;
    const pts = [];
    for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        pts.push(new THREE.Vector3(
            (x0 + (x1 - x0) * t) * s,
            y - Math.sin(t * Math.PI) * sag,
            z0 + (z1 - z0) * t
        ));
    }
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.022, 4, false);
    CTX.scene.add(new THREE.Mesh(geo, M.plain(0x22242a, 0.8, 0.3)));
}

/** Welcome sign at the mouth of the access road. Built once — never mirrored. */
function nuketownSign() {
    const face = M.signMaterial('nuketown', 1024, 512, (c, w, h) => {
        const g = c.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, '#8a6a2e'); g.addColorStop(1, '#6f5423');
        c.fillStyle = g; c.fillRect(0, 0, w, h);
        c.strokeStyle = '#f4ecd2'; c.lineWidth = 10; c.strokeRect(18, 18, w - 36, h - 36);
        c.fillStyle = '#f7f1dc'; c.textAlign = 'center';
        c.font = 'italic 58px Georgia'; c.fillText('Welcome to', w / 2, 118);
        c.font = 'bold 150px Impact';
        c.fillStyle = '#fffdf4'; c.fillText('NUKETOWN', w / 2, 268);
        c.font = '44px Georgia'; c.fillStyle = '#e8d9a8';
        c.fillText('POPULATION', w / 2 - 130, 384);
        c.fillStyle = '#1d1d1d'; c.fillRect(w / 2 + 70, 336, 190, 66);
        c.fillStyle = '#f0c040'; c.font = 'bold 56px monospace';
        c.fillText('0 0', w / 2 + 165, 386);
        c.fillStyle = '#e8d9a8'; c.font = '30px Georgia';
        c.fillText('NEVADA  •  ATOMIC TEST SITE', w / 2, 452);
    });
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.22, 3.0, 6.0), M.wood());
    board.position.set(8.2, 3.4, 30.0);
    board.castShadow = true; board.receiveShadow = true;
    CTX.scene.add(board);

    const printed = new THREE.Mesh(new THREE.PlaneGeometry(6.0, 3.0), face);
    printed.position.set(8.08, 3.4, 30.0);
    printed.rotation.y = -Math.PI / 2;
    CTX.scene.add(printed);

    CTX.cw.addAABB(8.0, 0, 27.0, 8.4, 5.0, 33.0, 'sign');
    for (const oz of [27.6, 32.4]) cylinder(0.15, 0.17, 5.4, 8, 8.2, 2.7, oz, M.wood(), { solid: false });
}

function watchTower(x, z) {
    const wood = M.wood();
    const metal = M.plain(0x7c8286, 0.5, 0.7);
    for (const ox of [-1.5, 1.5]) for (const oz of [-1.5, 1.5]) {
        cylinder(0.11, 0.14, 8.0, 8, x + ox, 4.0, z + oz, wood, { solid: true, tag: 'pole' });
        for (let i = 1; i < 4; i++) deco(0.1, 0.1, 3.0, x + ox, i * 2.0, z, wood, { cast: false });
    }
    box(3.8, 0.24, 3.8, x, 7.9, z, wood, { tag: 'platform' });
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        box(dx ? 0.14 : 3.8, 1.1, dz ? 0.14 : 3.8, x + dx * 1.85, 8.6, z + dz * 1.85, wood);
    }
    deco(4.4, 0.16, 4.4, x, 9.6, z, metal);
    for (const ox of [-1.6, 1.6]) deco(0.1, 1.4, 0.1, x + ox, 8.9, z + 1.6, metal, { cast: false });
    for (let i = 0; i < 14; i++) deco(0.9, 0.06, 0.06, x, 0.5 + i * 0.55, z - 1.85, metal, { cast: false });
    const siren = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 0.5, 10), M.rustyMetal());
    siren.position.set(x * CTX.s, 9.9, z);
    siren.castShadow = true;
    CTX.scene.add(siren);
}

// ============================================================================
// YARDS AND COVER — everything here mirrors with CTX.s
// ============================================================================
function frontYard(mats) {
    const hedge = M.plain(0x3f5228, 0.98, 0);
    // trimmed hedge along the porch, with a gap on the walk to the front door
    for (const [a, b] of [[P.z0, -6.9], [-4.7, P.z1]]) {
        box(0.7, 1.0, b - a, 15.1, 0.5, (a + b) / 2, hedge, { tag: 'bush' });
        deco(0.86, 0.14, b - a - 0.1, 15.1, 1.02, (a + b) / 2, hedge, { cast: false });
    }
    // picket along the lot lines, open in the middle for the walk and drive
    picketRun(14.2, LOT_N, 14.2, -10.4);
    picketRun(14.2, LOT_N, 32.0, LOT_N);
    picketRun(16.4, LOT_S, 32.0, LOT_S);
    // mailbox at the kerb
    cylinder(0.05, 0.05, 1.1, 6, 13.2, 0.55, -7.6, M.wood(), { solid: false });
    deco(0.24, 0.24, 0.42, 13.2, 1.2, -7.6, M.plain(0x5c6266, 0.5, 0.6));
    // porch furniture
    box(0.8, 0.08, 0.8, 16.6, 0.72, -8.2, mats.wood, { tag: 'prop' });
    for (const [ox, oz] of [[16.25, -8.5], [16.95, -8.5], [16.25, -7.9], [16.95, -7.9]])
        deco(0.07, 0.4, 0.07, ox, 0.5, oz, mats.wood, { cast: false });
    // lawn mannequins
    mannequin(13.6, -11.6, 1.2, 1);
    mannequin(14.9, -12.3, -0.6, 0);
    mannequin(12.2, 6.2, 2.6, 2);
}

function backYard(mats) {
    const wood = M.wood();
    // the concrete test-shelter slab — the spawn-side hard cover
    box(0.5, 2.6, 5.0, 31.6, 1.3, -5.0, mats.concrete, { tag: 'cover' });
    box(2.0, 2.6, 0.5, 30.9, 1.3, -7.25, mats.concrete, { tag: 'cover' });
    box(0.5, 2.6, 4.0, 31.6, 1.3, 2.5, mats.concrete, { tag: 'cover' });
    // shed — kept north of the spawn band so a spawn jitter cannot land in it
    box(2.6, 2.4, 3.0, 32.5, 1.2, -12.6, wood, { tag: 'shed' });
    box(3.0, 0.2, 3.4, 32.5, 2.5, -12.6, M.shingles(), { tag: 'shed' });
    deco(0.08, 1.8, 0.9, 31.18, 0.9, -12.1, M.plain(0x4b3620, 0.8, 0));
    // clothes line
    for (const oz of [-3.0, 3.0]) cylinder(0.06, 0.07, 2.3, 6, 35.6, 1.15, oz, wood, { solid: false });
    powerLine(35.6, -3.0, 35.6, 3.0, 2.25, 0.18);
    for (let i = 0; i < 4; i++) {
        deco(0.02, 0.6, 0.5, 35.6, 1.85, -2.0 + i * 1.35,
            M.plain([0xd8d2c0, 0xa9b4bd, 0xc2a89a, 0xb9c0a8][i], 0.9, 0), { cast: false });
    }
    // mannequin family staged for the blast, tucked against the house so the
    // spawn points behind them stay clear
    mannequin(29.6, -8.5, 0.4, 0);
    mannequin(30.4, -7.6, -0.9, 1);
    mannequin(29.4, 5.2, 2.4, 2);
    mannequin(30.6, 6.2, 1.1, 0);
    // barbecue + drums
    cylinder(0.42, 0.36, 0.35, 12, 30.6, 0.95, 6.8, M.plain(0x2f3234, 0.5, 0.6), { solid: true, tag: 'prop' });
    for (const a of [0, 2.1, 4.2]) {
        cylinder(0.03, 0.03, 0.8, 5, 30.6 + Math.cos(a) * 0.3, 0.4, 6.8 + Math.sin(a) * 0.3,
            M.plain(0x2f3234, 0.5, 0.6), { solid: false });
    }
    for (const [dx, dz] of [[29.9, -9.2], [30.7, -9.6]]) {
        cylinder(0.33, 0.33, 0.95, 14, dx, 0.48, dz, M.rustyMetal(), { solid: true, tag: 'cover' });
    }
    // dead tree out toward the fence
    cylinder(0.16, 0.26, 4.4, 8, 36.0, 2.2, -12.5, M.plain(0x4e3d2a, 0.95, 0), { solid: true, tag: 'tree' });
    for (const [ax, ay, az, rz] of [[0.7, 3.6, 0.2, 0.9], [-0.6, 3.9, -0.3, -1.0], [0.2, 4.2, 0.7, 0.5]]) {
        cylinder(0.07, 0.11, 1.6, 6, 36.0 + ax, ay, -12.5 + az, M.plain(0x4e3d2a, 0.95, 0), { rotZ: rz, solid: false });
    }
}

/** Cover in and around the circle. Mirrored, so both teams get the same. */
function circleCover() {
    const concrete = M.concrete();
    const wood = M.wood();
    const sandbagMat = M.vestFabric('sandbag', '#94805a');

    box(0.6, 0.95, 2.6, 10.4, 0.48, -6.4, concrete, { tag: 'cover' });
    deco(0.35, 0.12, 2.2, 10.4, 1.0, -6.4, concrete);
    box(2.6, 0.95, 0.6, 4.6, 0.48, 10.4, concrete, { tag: 'cover' });
    deco(2.2, 0.12, 0.35, 4.6, 1.0, 10.4, concrete);

    // sandbag nest — rounded and jittered so the stack reads as bags
    for (let r = 0; r < 3; r++) {
        const n = 5 - (r === 2 ? 1 : 0);
        for (let i = 0; i < n; i++) {
            const bag = new THREE.Mesh(new THREE.SphereGeometry(0.20, 8, 6), sandbagMat);
            bag.scale.set(0.92, 0.62, 1.35);
            bag.position.set(
                (2.6 + (Math.random() - 0.5) * 0.12) * CTX.s,
                0.13 + r * 0.24,
                -8.4 + i * 0.52 - (r % 2) * 0.26 + (Math.random() - 0.5) * 0.05
            );
            bag.rotation.set((Math.random() - 0.5) * 0.14, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.12);
            bag.castShadow = true; bag.receiveShadow = true;
            CTX.scene.add(bag);
        }
    }
    CTX.cw.addAABB(2.25 * CTX.s, 0, -8.75, 2.95 * CTX.s, 0.78, -6.0, 'cover');

    for (const [dx, dz] of [[9.8, 4.6], [10.6, 5.2]]) {
        cylinder(0.33, 0.33, 0.95, 14, dx, 0.48, dz, M.rustyMetal(), { solid: true, tag: 'cover' });
        deco(0.36, 0.06, 0.36, dx, 0.97, dz, M.rustyMetal(), { cast: false });
    }
    for (const [cxp, czp, sz] of [[6.5, -10.4, 1.0], [7.3, -11.0, 0.8]]) {
        box(sz, sz, sz, cxp, sz / 2, czp, wood, { tag: 'cover' });
    }
    for (const [tx, tz] of [[11.6, -1.4], [3.2, 12.4]]) {
        cylinder(0.3, 0.34, 0.95, 12, tx, 0.48, tz, M.plain(0x4a4e50, 0.6, 0.5), { solid: true, tag: 'prop' });
        deco(0.38, 0.07, 0.38, tx, 0.98, tz, M.plain(0x3a3e40, 0.6, 0.5), { cast: false });
    }
    const hy = M.plain(0xb42a1c, 0.45, 0.3);
    cylinder(0.15, 0.19, 0.75, 10, 13.4, 0.38, -2.6, hy, { solid: true, tag: 'prop' });
    deco(0.16, 0.12, 0.42, 13.4, 0.62, -2.6, hy, { cast: false });
    deco(0.2, 0.16, 0.2, 13.4, 0.8, -2.6, hy, { cast: false });

    // scrub bushes — vertices jittered so they read as foliage, not green blobs
    const bushMat = M.plain(0x4a5730, 0.98, 0);
    for (const [bx, bz, r] of [[16.5, -16.0, 0.75], [30.0, 9.5, 0.7], [11.5, 15.5, 0.6], [29.5, 14.0, 0.7]]) {
        const geo = new THREE.IcosahedronGeometry(r, 1);
        const pos = geo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            const k = 0.84 + Math.random() * 0.30;
            pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * 0.8, pos.getZ(i) * k);
        }
        geo.computeVertexNormals();
        const b = new THREE.Mesh(geo, bushMat);
        b.position.set(bx * CTX.s, r * 0.62, bz);
        b.rotation.y = Math.random() * 3;
        b.castShadow = true; b.receiveShadow = true;
        CTX.scene.add(b);
        CTX.cw.addAABB(bx * CTX.s - r * 0.7, 0, bz - r * 0.7, bx * CTX.s + r * 0.7, r * 0.9, bz + r * 0.7, 'bush');
    }
}

// ============================================================================
// ONE SIDE OF THE MAP
// ============================================================================
function buildSide(s, kind) {
    CTX.s = s;

    // ── lot surfaces (drawn before the buildings sit on them) ──
    const lawn = M.lawn(), concrete = M.concrete();
    pave(new THREE.PlaneGeometry(19.0, 22.6), lawn, 23.5 * s, 0.028, -3.5);
    pave(new THREE.PlaneGeometry(17.0, 15.0), lawn, 21.0 * s, 0.028, 21.5);
    // driveway, front walk, back path
    pave(new THREE.PlaneGeometry(7.6, 4.3), concrete, 16.0 * s, 0.042, 0.8);
    pave(new THREE.PlaneGeometry(3.4, 2.3), concrete, 13.4 * s, 0.046, -5.8);
    pave(new THREE.PlaneGeometry(4.2, 2.0), concrete, 30.2 * s, 0.042, -3.1);
    pave(new THREE.PlaneGeometry(4.0, 5.0), concrete, 20.5 * s, 0.042, 14.2);

    const mats = buildHouse(kind);
    buildGarage(mats);
    furnishHouse(mats);
    frontYard(mats);
    backYard(mats);
    buildBungalow(kind);
    circleCover();

    // Same body on both driveways — a different silhouette per side would be a
    // real cover advantage, however small.
    car(15.8, 1.6, kind === 'yellow' ? '#2f6ea8' : '#5a6b3a', 'sedan', 'x');

    utilityPole(14.8, -15.6);
    utilityPole(15.6, 9.2);
    utilityPole(8.6, 22.0);
    utilityPole(8.6, 34.0);
    powerLine(14.8, -15.6, 15.6, 9.2, 8.55, 0.55);
    powerLine(15.6, 9.2, 8.6, 22.0, 8.55, 0.5);
    powerLine(8.6, 22.0, 8.6, 34.0, 8.55, 0.4);
    powerLine(14.8, -15.6, 15.6, 9.2, 7.95, 0.6);

    // canonical coordinates — box() applies the mirror, so do not pre-multiply
    watchTower(48.0, 24.0);
}

// ============================================================================
// GROUND
// ============================================================================
function buildGround() {
    const desert = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), M.sand());
    desert.rotation.x = -Math.PI / 2;
    desert.position.y = -0.06;
    desert.receiveShadow = true;
    CTX.scene.add(desert);

    pave(new THREE.PlaneGeometry(96, 90), M.dirt(), 0, 0.0, -2);

    const asphalt = M.asphalt();
    pave(new THREE.CircleGeometry(CIRCLE_R, 72), asphalt, 0, 0.020, 0);
    pave(new THREE.PlaneGeometry(ROAD_HALF * 2, ROAD_Z1 - ROAD_Z0 + 2.5), asphalt, 0, 0.020, (ROAD_Z0 + ROAD_Z1) / 2 - 1.2);

    // grass verge outside the kerb, cut where the access road leaves
    const verge = new THREE.Mesh(
        new THREE.RingGeometry(CIRCLE_R + 0.16, CIRCLE_R + 4.6, 64, 1, -Math.PI / 2 + ROAD_GAP, Math.PI * 2 - 2 * ROAD_GAP),
        M.lawn()
    );
    verge.rotation.x = -Math.PI / 2;
    verge.position.y = 0.030;
    verge.receiveShadow = true;
    CTX.scene.add(verge);

    // kerb ring — one torus, same gap. Only 0.14 m tall, so it is deliberately
    // not collision: a kerb you have to path around makes the bots stupid.
    // A torus arc starts at local angle 0, so its missing wedge sits at −GAP…0;
    // spinning it by −π/2 + GAP puts that wedge due south, on the road.
    const kerb = new THREE.Mesh(
        new THREE.TorusGeometry(CIRCLE_R, 0.14, 6, 96, Math.PI * 2 - 2 * ROAD_GAP),
        M.sidewalk()
    );
    kerb.rotation.x = -Math.PI / 2;
    kerb.rotation.z = -Math.PI / 2 + ROAD_GAP;
    kerb.position.y = 0.10;
    kerb.receiveShadow = true; kerb.castShadow = true;
    CTX.scene.add(kerb);

    // kerbs down both sides of the access road
    for (const sgn of [-1, 1]) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, ROAD_Z1 - ROAD_Z0), M.sidewalk());
        c.position.set(sgn * ROAD_HALF, 0.09, (ROAD_Z0 + ROAD_Z1) / 2);
        c.receiveShadow = true; c.castShadow = true;
        CTX.scene.add(c);
    }

    // access road centre line
    const paint = M.plain(0xd8c24a, 0.75, 0);
    for (let z = ROAD_Z0 + 2; z <= ROAD_Z1 - 2; z += 4.4) {
        const d = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 2.4), paint);
        d.rotation.x = -Math.PI / 2; d.position.set(0, 0.034, z);
        CTX.scene.add(d);
    }

    // fire station forecourt
    pave(new THREE.PlaneGeometry(28, 8.0), M.concrete(), 0, 0.040, -15.2);
    pave(new THREE.PlaneGeometry(30, 10.0), M.lawn(), 0, 0.028, -34.0);
}

// ============================================================================
// SKY
// ============================================================================
function buildSky(scene) {
    const geo = new THREE.SphereGeometry(400, 48, 32);
    const mat = new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false,
        uniforms: { time: { value: 0 }, sunDir: { value: new THREE.Vector3(-0.42, 0.55, 0.28).normalize() } },
        vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `
            varying vec3 vP; uniform float time; uniform vec3 sunDir;
            float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
            float noise(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
                return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
            float fbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<6;i++){ v+=a*noise(p); p=p*2.03+vec2(1.7,9.2); a*=0.5; } return v; }
            void main(){
                vec3 d = normalize(vP);
                float h = d.y;
                vec3 zenith  = vec3(0.16,0.36,0.72);
                vec3 mid     = vec3(0.44,0.62,0.86);
                vec3 horizon = vec3(0.86,0.82,0.72);
                vec3 sky = mix(mid, zenith, smoothstep(0.05,0.75,h));
                sky = mix(horizon, sky, smoothstep(-0.03,0.28,h));
                float sd = max(0.0, dot(d, sunDir));
                sky += vec3(1.0,0.94,0.80) * pow(sd, 900.0) * 12.0;
                sky += vec3(1.0,0.86,0.60) * pow(sd, 12.0) * 0.30;
                sky += vec3(1.0,0.80,0.55) * pow(sd, 3.0) * 0.07;
                if (h > 0.0) {
                    vec2 uv = d.xz/(h+0.14)*1.6 + vec2(time*0.004, time*0.0016);
                    float c = fbm(uv);
                    float c2 = fbm(uv*2.3 + 3.1);
                    float cov = smoothstep(0.44,0.78,c*0.75+c2*0.35);
                    float lit = smoothstep(0.35,0.85,c2);
                    vec3 cc = mix(vec3(0.62,0.65,0.70), vec3(1.02,1.0,0.98), lit);
                    cc += vec3(0.25,0.18,0.10) * pow(sd,4.0);
                    sky = mix(sky, cc, cov * smoothstep(0.0,0.30,h) * 0.9);
                }
                sky = mix(sky, vec3(0.72,0.66,0.56), smoothstep(0.0,-0.25,h));
                gl_FragColor = vec4(sky, 1.0);
            }`
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { mesh, mat };
}

function distantTerrain(scene) {
    // Two ranges at different distances, vertices jittered so the silhouette
    // reads as eroded rock instead of a row of pyramids.
    const near = M.plain(0x9c8568, 1.0, 0);
    const far = M.plain(0x8d7f74, 1.0, 0);

    const makeRidge = (count, radius, radVar, hMin, hMax, mat, jitter) => {
        for (let i = 0; i < count; i++) {
            const a = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.28;
            const rad = radius + Math.random() * radVar;
            const hh = hMin + Math.random() * (hMax - hMin);
            const geo = new THREE.ConeGeometry(hh * (0.85 + Math.random() * 0.7), hh, 7, 3);
            const pos = geo.attributes.position;
            for (let v = 0; v < pos.count; v++) {
                const y = pos.getY(v);
                const k = 1 + (Math.random() - 0.5) * jitter * (0.35 + (0.5 - y / hh));
                pos.setX(v, pos.getX(v) * k);
                pos.setZ(v, pos.getZ(v) * k);
                pos.setY(v, y + (Math.random() - 0.5) * hh * 0.06);
            }
            geo.computeVertexNormals();
            const m = new THREE.Mesh(geo, mat);
            m.position.set(Math.cos(a) * rad, hh / 2 - 8, Math.sin(a) * rad);
            m.rotation.y = Math.random() * Math.PI;
            m.scale.set(1, 0.62 + Math.random() * 0.55, 0.8 + Math.random() * 0.5);
            scene.add(m);
        }
    };
    makeRidge(22, 210, 70, 30, 62, near, 0.55);
    makeRidge(16, 350, 130, 55, 105, far, 0.45);

    for (const [mx, mz, mw, mh] of [[-250, 110, 78, 38], [210, -180, 96, 30], [40, 300, 120, 44]]) {
        const geo = new THREE.CylinderGeometry(mw * 0.55, mw * 0.78, mh, 9, 2);
        const pos = geo.attributes.position;
        for (let v = 0; v < pos.count; v++) {
            const k = 1 + (Math.random() - 0.5) * 0.16;
            pos.setX(v, pos.getX(v) * k);
            pos.setZ(v, pos.getZ(v) * k);
        }
        geo.computeVertexNormals();
        const m = new THREE.Mesh(geo, far);
        m.position.set(mx, mh / 2 - 8, mz);
        m.rotation.y = Math.random();
        scene.add(m);
    }
}

// ============================================================================
// PUBLIC ENTRY
// ============================================================================
export function buildNuketown(scene, cw) {
    CTX = { scene, cw, s: 1 };

    buildGround();

    // ── the two mirrored lots ──
    buildSide(1, 'yellow');
    buildSide(-1, 'teal');
    CTX.s = 1;

    // ── everything that straddles the axis, built once ──
    fireStation();
    schoolBus();
    movingTruck();
    nuketownSign();

    // ── perimeter ──
    const B = MAP_BOUNDS;
    chainLinkRun(B.minX, B.minZ, B.maxX, B.minZ, 3.2);
    chainLinkRun(B.minX, B.maxZ, B.maxX, B.maxZ, 3.2);
    chainLinkRun(B.minX, B.minZ, B.minX, B.maxZ, 3.2);
    chainLinkRun(B.maxX, B.minZ, B.maxX, B.maxZ, 3.2);
    // hard invisible walls just outside, so nothing can squeeze through
    cw.addAABB(B.minX - 2, 0, B.minZ - 2, B.minX - 0.4, 16, B.maxZ + 2, 'bound');
    cw.addAABB(B.maxX + 0.4, 0, B.minZ - 2, B.maxX + 2, 16, B.maxZ + 2, 'bound');
    cw.addAABB(B.minX - 2, 0, B.minZ - 2, B.maxX + 2, 16, B.minZ - 0.4, 'bound');
    cw.addAABB(B.minX - 2, 0, B.maxZ + 0.4, B.maxX + 2, 16, B.maxZ + 2, 'bound');

    // world floor
    cw.addAABB(-200, -1.0, -200, 200, 0.0, 200, 'ground');

    distantTerrain(scene);
    const sky = buildSky(scene);

    // drifting dust motes
    const dustGeo = new THREE.BufferGeometry();
    const N = 520, pos = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i += 3) {
        pos[i] = (Math.random() - 0.5) * 90;
        pos[i + 1] = Math.random() * 14;
        pos[i + 2] = (Math.random() - 0.5) * 84;
    }
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
        color: 0xe6d5b4, size: 0.055, transparent: true, opacity: 0.42, depthWrite: false, sizeAttenuation: true
    }));
    dust.name = 'dust';
    scene.add(dust);

    validateWaypoints(cw);

    CTX = null;
    return { sky: sky.mesh, skyMat: sky.mat, dust };
}

/**
 * Assert that every navigation node is somewhere a soldier can actually stand.
 *
 * A node buried in a collider is what makes a bot walk face-first into a wall
 * for the rest of the match, and hand-authored lists drift out of step with the
 * props around them the moment a bush or a shed moves.
 *
 * This reports rather than repairs on purpose. Nudging a node to the nearest
 * clear spot sounds harmless, but the search has to pick a direction, and any
 * fixed direction moves a node and its mirror the SAME way in world space —
 * which quietly destroys the mirror symmetry the spawns depend on for fairness.
 * A node in a wall is a map bug; it gets fixed in the coordinates above.
 */
function validateWaypoints(cw) {
    const RADIUS = 0.42, HEAD = 1.7;
    const scratch = [];
    const bad = [];

    for (const w of WAYPOINTS) {
        const gy = cw.groundHeight(w.x, w.z, 0.6, RADIUS, scratch);
        const feet = gy + 0.05, head = gy + HEAD;
        for (const id of cw._query(w.x - RADIUS, w.z - RADIUS, w.x + RADIUS, w.z + RADIUS, scratch)) {
            const b = cw.boxes[id];
            if (b.tag === 'ground' || b.tag === 'bound') continue;
            if (head <= b.minY || feet >= b.maxY) continue;
            if (w.x + RADIUS <= b.minX || w.x - RADIUS >= b.maxX) continue;
            if (w.z + RADIUS <= b.minZ || w.z - RADIUS >= b.maxZ) continue;
            if (b.maxY - gy <= cw.stepHeight && b.maxY > gy) continue;   // steppable
            bad.push(`(${w.x}, ${w.z}) in ${b.tag}`);
            break;
        }
    }
    if (bad.length) console.warn('[map] waypoints inside geometry:', bad.join('; '));
}

// ============================================================================
// GAMEPLAY DATA
//
// The east half is authored once and reflected, so neither team can be handed a
// better angle by a typo.
// ============================================================================
const mirrorXZ = n => ({ x: -n.x, z: n.z });
const mirrorXYZ = n => ({ x: -n.x, y: n.y, z: n.z });

/** Back yard behind the yellow house (east). */
const SPAWN_EAST = [
    { x: 37.0, z: -6.0 }, { x: 37.0, z: -2.0 }, { x: 37.0, z: 2.0 },
    { x: 34.0, z: -9.0 }, { x: 34.0, z: 5.0 },
    { x: 39.5, z: -4.0 }, { x: 39.5, z: 0.0 }
];
export const SPAWN_A = SPAWN_EAST.map(mirrorXZ);   // west team, behind the teal house
export const SPAWN_B = SPAWN_EAST.slice();          // east team, behind the yellow house

// ── navigation nodes ────────────────────────────────────────────────────────
// The bots steer in XZ and let the physics decide their height, so every node
// has to be standable at ground level as well as on the floor it names.
const RING_NODES = [];
for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    RING_NODES.push({ x: +(Math.cos(a) * 10.4).toFixed(2), z: +(Math.sin(a) * 10.4).toFixed(2) });
}

const AXIS_NODES = [
    { x: 0, z: 0 },                                        // middle of the circle
    { x: 0, z: 14.5 }, { x: 0, z: 20.5 }, { x: 0, z: 27 }, { x: 0, z: 33 },   // access road
    { x: 0, z: -15.5 },                                    // fire station forecourt
    { x: 0, z: -21.5 }, { x: 0, z: -28.0 },                // fire station interior
    { x: 0, z: -34.5 }                                     // behind the fire station
];

const EAST_NODES = [
    // circle, inside the parked vehicles
    { x: 3.2, z: 3.4 }, { x: 3.0, z: -3.6 }, { x: 11.5, z: 3.5 }, { x: 11.5, z: -3.5 },
    // front yard, walk and driveway
    { x: 13.5, z: -5.8 }, { x: 15.0, z: -10.5 }, { x: 13.4, z: 4.8 },
    { x: 16.8, z: -6.0 }, { x: 16.8, z: -2.6 },            // porch deck / balcony above
    { x: 18.6, z: 0.8 },                                    // driveway at the garage bay
    // house, ground floor and the room above it
    { x: 19.2, z: -6.0 }, { x: 23.2, z: -6.5 },            // living room / front bedroom
    { x: 20.4, z: -3.2 }, { x: 23.6, z: -3.2 },            // kitchen / back bedroom
    { x: 26.4, z: -6.9 }, { x: 25.9, z: -7.9 },            // hall + stair head
    // garage
    { x: 22.4, z: 0.9 }, { x: 24.0, z: 1.6 },
    // side yards — the foot of the exterior staircase is here
    { x: 16.8, z: -13.3 }, { x: 21.5, z: -12.0 }, { x: 21.0, z: 5.6 }, { x: 28.5, z: 5.4 },
    // back yard and spawn approach
    { x: 30.4, z: -6.0 }, { x: 30.4, z: 1.2 }, { x: 35.0, z: -11.0 },
    { x: 34.2, z: 4.2 }, { x: 37.2, z: -3.0 }, { x: 38.4, z: 3.2 },
    // between the lots
    { x: 21.0, z: -17.5 }, { x: 30.0, z: -16.0 }, { x: 33.0, z: 10.5 },
    // fire station east half
    { x: 7.2, z: -21.5 }, { x: 7.6, z: -28.5 }, { x: 8.0, z: -16.0 },
    { x: 13.6, z: -21.0 }, { x: 13.2, z: -30.0 },
    // access road verge and bungalow
    { x: 6.6, z: 16.0 }, { x: 7.0, z: 24.0 }, { x: 5.2, z: 31.0 },
    { x: 12.0, z: 15.0 }, { x: 18.5, z: 14.6 },
    { x: 18.5, z: 21.0 }, { x: 23.5, z: 19.4 }, { x: 18.6, z: 24.2 }, { x: 24.6, z: 23.6 },
    { x: 13.0, z: 21.5 }, { x: 29.0, z: 21.5 }, { x: 21.0, z: 28.5 }
];

/** Navigation nodes — all on walkable ground, none inside a wall. */
export const WAYPOINTS = [
    ...AXIS_NODES,
    ...RING_NODES,
    ...EAST_NODES,
    ...EAST_NODES.map(mirrorXZ)
];

// ── elevated holds ──────────────────────────────────────────────────────────
const EAST_PERCHES = [
    { x: 16.8, y: 3.30, z: -6.8 },    // balcony, over the front door
    { x: 16.8, y: 3.30, z: -3.2 },    // balcony, south end
    { x: 22.4, y: 3.30, z: -6.4 },    // upper front room, back from the balcony doors
    { x: 23.3, y: 3.46, z: 0.9 },     // garage roof, out of the upper window
    { x: 12.0, y: 6.28, z: -22.0 }    // fire station roof stair head
];
const AXIS_PERCHES = [
    { x: 0, y: 6.20, z: -25.0 },      // fire station ridge
    { x: 0, y: 5.80, z: -20.5 }       // fire station roof, overlooking the circle
];

/** Elevated positions bots may hold. */
export const PERCHES = [
    ...AXIS_PERCHES,
    ...EAST_PERCHES,
    ...EAST_PERCHES.map(mirrorXYZ)
];

// ── minimap ─────────────────────────────────────────────────────────────────
const EAST_RECTS = [
    { x0: 18.0, z0: -9.0, x1: 28.0, z1: -1.4, k: 'house' },
    { x0: 19.5, z0: -1.4, x1: 27.0, z1: 3.0, k: 'garage' },
    { x0: 15.6, z0: -9.0, x1: 18.0, z1: -1.6, k: 'porch' },
    { x0: 15.9, z0: -12.8, x1: 17.7, z1: -9.0, k: 'porch' },      // exterior staircase
    { x0: 15.5, z0: 17.0, x1: 27.0, z1: 26.0, k: 'house' }
];
const EAST_FENCES = [
    [14.2, -14.6, 14.2, -10.4], [14.2, -14.6, 32.0, -14.6], [16.4, 7.6, 32.0, 7.6]
];
const mirrorRect = r => ({ x0: -r.x0, z0: r.z0, x1: -r.x1, z1: r.z1, k: r.k });
const mirrorFence = f => [-f[0], f[1], -f[2], f[3]];

/**
 * Simplified geometry for the minimap, in world space. `circle` and `bounds`
 * are new in v2 — the cul-de-sac cannot be drawn as a rectangle.
 */
export const MINIMAP = {
    road: { x0: -ROAD_HALF, z0: ROAD_Z0, x1: ROAD_HALF, z1: ROAD_Z1 },
    circle: { x: 0, z: 0, r: CIRCLE_R },
    bounds: { x0: MAP_BOUNDS.minX, z0: MAP_BOUNDS.minZ, x1: MAP_BOUNDS.maxX, z1: MAP_BOUNDS.maxZ },
    rects: [
        { x0: -11.0, z0: -31.0, x1: 11.0, z1: -19.0, k: 'house' },
        { x0: -7.85, z0: -4.7, x1: -5.35, z1: 5.9, k: 'vehicle' },
        { x0: 5.53, z0: -3.8, x1: 8.08, z1: 5.1, k: 'vehicle' },
        ...EAST_RECTS,
        ...EAST_RECTS.map(mirrorRect)
    ],
    fences: [
        ...EAST_FENCES,
        ...EAST_FENCES.map(mirrorFence)
    ]
};
