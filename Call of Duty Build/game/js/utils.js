export const TEAM_A = 0;   // Blue — the player's team
export const TEAM_B = 1;   // Red

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const rand = (a, b) => Math.random() * (b - a) + a;
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const randElement = arr => arr[(Math.random() * arr.length) | 0];
export const dist2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
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
