export const TEAM_A = 0;   // Blue — the player's team
export const TEAM_B = 1;   // Red

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const rand = (a, b) => Math.random() * (b - a) + a;
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const randElement = arr => arr[(Math.random() * arr.length) | 0];
export const dist2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * The fence line, in metres. `map.js` re-exports this as MAP_BOUNDS so the
 * geometry and the entities that live inside it agree on one rectangle.
 */
export const MAP_RECT = { minX: -42, maxX: 42, minZ: -40, maxZ: 38 };

/**
 * Pin an XZ position inside the perimeter. `margin` keeps it off the fence rather
 * than merely off the coordinates: a soldier pressed against the chain-link reads
 * to the player as "that one spawned outside the map", which is a complaint about
 * the game even when the physics is technically correct. Returns true if anything
 * was moved, so callers can kill the outward velocity and stop grinding.
 */
export function clampToMap(pos, margin = 1.0, b = MAP_RECT) {
    if (!pos) return false;
    // A NaN position would stick an entity at sea forever, invisible and
    // untargetable — repair the axis that is actually broken and leave the rest.
    if (!Number.isFinite(pos.x)) pos.x = 0;
    if (!Number.isFinite(pos.z)) pos.z = 0;
    const nx = clamp(pos.x, b.minX + margin, b.maxX - margin);
    const nz = clamp(pos.z, b.minZ + margin, b.maxZ - margin);
    if (nx === pos.x && nz === pos.z) return false;
    pos.x = nx; pos.z = nz;
    return true;
}
export const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
};

export const BOT_NAMES_A = ['MASON', 'WOODS', 'HUDSON', 'BOWMAN', 'WEAVER'];
export const BOT_NAMES_B = ['KRAVCHENKO', 'DRAGOVICH', 'STEINER', 'ZHAO', 'PETRENKO', 'VOLKOV'];

export function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
