// ============================================================================
// weapons.js — weapon stats, world (3rd person) models and first-person
// viewmodels complete with modelled arms and gripping hands.
//
// CONVENTION for every weapon group: the barrel points down -Z, up is +Y,
// the receiver sits near the origin.  All measurements are metres.
// ============================================================================
import * as THREE from 'three';
import * as M from './materials.js';

// ── stats ───────────────────────────────────────────────────────────────────
export const WEAPON_DEFS = [
    {
        name: 'M4A1 CARBINE', short: 'M4A1', type: 'rifle', fireMode: 'AUTO',
        damage: 31, headMult: 2.2, rpm: 780, magSize: 30, reserve: 180,
        reloadTime: 2.15, range: 70, falloffStart: 26, falloffMin: 0.62,
        recoil: { v: 0.0130, h: 0.0048, kick: 0.055, recover: 9.0 },
        spread: 0.028, adsSpread: 0.0022, moveSpread: 1.9,
        adsFov: 45, adsTime: 0.145, audioType: 'rifle', shellDelay: 0
    },
    {
        name: 'MP5', short: 'MP5', type: 'smg', fireMode: 'AUTO',
        damage: 24, headMult: 1.9, rpm: 880, magSize: 30, reserve: 210,
        reloadTime: 1.85, range: 45, falloffStart: 15, falloffMin: 0.5,
        recoil: { v: 0.0092, h: 0.0055, kick: 0.042, recover: 11.0 },
        spread: 0.038, adsSpread: 0.0048, moveSpread: 1.5,
        adsFov: 52, adsTime: 0.115, audioType: 'smg', shellDelay: 0
    },
    {
        name: 'R700 SNIPER', short: 'R700', type: 'sniper', fireMode: 'BOLT',
        damage: 115, headMult: 2.0, rpm: 48, magSize: 5, reserve: 35,
        reloadTime: 3.1, range: 200, falloffStart: 200, falloffMin: 1.0,
        recoil: { v: 0.055, h: 0.010, kick: 0.16, recover: 5.0 },
        spread: 0.055, adsSpread: 0.0002, moveSpread: 2.4,
        adsFov: 16, adsTime: 0.26, audioType: 'sniper', scope: true, shellDelay: 0.55
    },
    {
        name: 'SPAS-12', short: 'SPAS', type: 'shotgun', fireMode: 'PUMP',
        damage: 19, headMult: 1.4, rpm: 78, magSize: 8, reserve: 48,
        reloadTime: 0.62, shellReload: true, range: 26, falloffStart: 8, falloffMin: 0.18,
        recoil: { v: 0.042, h: 0.012, kick: 0.13, recover: 6.5 },
        spread: 0.085, adsSpread: 0.055, moveSpread: 1.2, pellets: 9,
        adsFov: 58, adsTime: 0.15, audioType: 'shotgun', shellDelay: 0.3
    },
    // ── Gun Game ladder additions ───────────────────────────────────────────
    // 0-3 above are the Team Deathmatch loadout and must keep their indices.
    // Everything below reuses one of the five builders through `type`, so the
    // ladder costs no new art.  `audioType` selects one of audio.js's four
    // synth voices and is deliberately not always equal to `type` — there is
    // no pistol voice, so the 9 mm guns borrow the snappy SMG one.
    // Damage is tuned against 100 HP at Nuketown's 5-35 m engagement band.
    {
        name: 'M9 SIDEARM', short: 'M9', type: 'pistol', fireMode: 'SEMI',
        damage: 34, headMult: 2.4, rpm: 420, magSize: 15, reserve: 90,
        reloadTime: 1.55, range: 40, falloffStart: 16, falloffMin: 0.55,
        recoil: { v: 0.0115, h: 0.0042, kick: 0.046, recover: 12.0 },
        spread: 0.030, adsSpread: 0.0040, moveSpread: 1.6,
        adsFov: 55, adsTime: 0.100, audioType: 'smg', shellDelay: 0
    },
    {
        name: 'SKORPION', short: 'SKORP', type: 'pistol', fireMode: 'AUTO',
        damage: 20, headMult: 1.8, rpm: 1050, magSize: 24, reserve: 144,
        reloadTime: 1.60, range: 38, falloffStart: 14, falloffMin: 0.50,
        recoil: { v: 0.0100, h: 0.0082, kick: 0.038, recover: 12.5 },
        spread: 0.050, adsSpread: 0.0100, moveSpread: 1.4,
        adsFov: 58, adsTime: 0.095, audioType: 'smg', shellDelay: 0
    },
    {
        name: 'UZI', short: 'UZI', type: 'smg', fireMode: 'AUTO',
        damage: 22, headMult: 1.8, rpm: 950, magSize: 25, reserve: 175,
        reloadTime: 1.90, range: 42, falloffStart: 13, falloffMin: 0.46,
        recoil: { v: 0.0102, h: 0.0060, kick: 0.042, recover: 11.5 },
        spread: 0.044, adsSpread: 0.0062, moveSpread: 1.5,
        adsFov: 54, adsTime: 0.110, audioType: 'smg', shellDelay: 0
    },
    {
        name: 'P90', short: 'P90', type: 'smg', fireMode: 'AUTO',
        damage: 23, headMult: 1.9, rpm: 900, magSize: 50, reserve: 200,
        reloadTime: 2.40, range: 48, falloffStart: 18, falloffMin: 0.55,
        recoil: { v: 0.0082, h: 0.0044, kick: 0.036, recover: 12.0 },
        spread: 0.032, adsSpread: 0.0038, moveSpread: 1.4,
        adsFov: 52, adsTime: 0.125, audioType: 'smg', shellDelay: 0
    },
    {
        name: 'AK-47', short: 'AK47', type: 'rifle', fireMode: 'AUTO',
        damage: 36, headMult: 2.2, rpm: 600, magSize: 30, reserve: 180,
        reloadTime: 2.35, range: 78, falloffStart: 30, falloffMin: 0.66,
        recoil: { v: 0.0178, h: 0.0068, kick: 0.070, recover: 8.0 },
        spread: 0.034, adsSpread: 0.0026, moveSpread: 2.0,
        adsFov: 45, adsTime: 0.165, audioType: 'rifle', shellDelay: 0
    },
    {
        name: 'SCAR-H', short: 'SCAR', type: 'rifle', fireMode: 'AUTO',
        damage: 45, headMult: 2.1, rpm: 540, magSize: 20, reserve: 140,
        reloadTime: 2.50, range: 90, falloffStart: 36, falloffMin: 0.72,
        recoil: { v: 0.0210, h: 0.0074, kick: 0.082, recover: 7.5 },
        spread: 0.030, adsSpread: 0.0024, moveSpread: 2.1,
        adsFov: 42, adsTime: 0.185, audioType: 'rifle', shellDelay: 0
    },
    {
        name: 'RPK LIGHT MG', short: 'RPK', type: 'rifle', fireMode: 'AUTO',
        damage: 33, headMult: 2.0, rpm: 700, magSize: 75, reserve: 225,
        reloadTime: 3.40, range: 82, falloffStart: 32, falloffMin: 0.70,
        recoil: { v: 0.0150, h: 0.0080, kick: 0.062, recover: 8.5 },
        spread: 0.052, adsSpread: 0.0032, moveSpread: 2.4,
        adsFov: 46, adsTime: 0.240, audioType: 'rifle', shellDelay: 0
    },
    {
        name: 'MODEL 680', short: 'M680', type: 'shotgun', fireMode: 'PUMP',
        damage: 20, headMult: 1.5, rpm: 66, magSize: 6, reserve: 42,
        reloadTime: 0.60, shellReload: true, range: 30, falloffStart: 10, falloffMin: 0.22,
        recoil: { v: 0.046, h: 0.013, kick: 0.14, recover: 6.2 },
        spread: 0.070, adsSpread: 0.042, moveSpread: 1.2, pellets: 8,
        adsFov: 58, adsTime: 0.160, audioType: 'shotgun', shellDelay: 0.3
    },
    {
        name: 'AA-12', short: 'AA12', type: 'shotgun', fireMode: 'AUTO',
        damage: 15, headMult: 1.3, rpm: 300, magSize: 20, reserve: 60,
        reloadTime: 3.20, range: 24, falloffStart: 7, falloffMin: 0.16,
        recoil: { v: 0.030, h: 0.011, kick: 0.10, recover: 7.0 },
        spread: 0.082, adsSpread: 0.058, moveSpread: 1.2, pellets: 8,
        // ejects on every shot: a shellDelay here would queue a timer per round
        adsFov: 60, adsTime: 0.160, audioType: 'shotgun', shellDelay: 0
    },
    {
        name: 'DRAGUNOV', short: 'SVD', type: 'sniper', fireMode: 'SEMI',
        damage: 78, headMult: 2.0, rpm: 200, magSize: 10, reserve: 50,
        reloadTime: 2.60, range: 150, falloffStart: 150, falloffMin: 1.0,
        recoil: { v: 0.038, h: 0.0090, kick: 0.12, recover: 6.0 },
        spread: 0.048, adsSpread: 0.0016, moveSpread: 2.2,
        adsFov: 24, adsTime: 0.230, audioType: 'sniper', scope: true, shellDelay: 0.20
    },
    {
        name: 'BARRETT .50', short: 'M82', type: 'sniper', fireMode: 'SEMI',
        damage: 165, headMult: 2.0, rpm: 72, magSize: 10, reserve: 20,
        reloadTime: 3.00, range: 220, falloffStart: 220, falloffMin: 1.0,
        recoil: { v: 0.062, h: 0.0110, kick: 0.18, recover: 4.8 },
        spread: 0.045, adsSpread: 0.0004, moveSpread: 2.4,
        adsFov: 20, adsTime: 0.220, audioType: 'sniper', scope: true, shellDelay: 0.35
    }
];

export const WEAPON_TYPES = WEAPON_DEFS.map(d => d.type);

// Gun Game order: the four guns this game is actually played with, one rung each
// — four kills wins it. The order is a difficulty curve rather than a power
// curve: you start on the rifle you know, drop to the SMG you have to close on,
// take the shotgun to a knife fight, and finish on the bolt-action sniper, so
// the last kill of a match is the hardest shot in the game.
//
// It is deliberately short. The fifteen-gun version made a match a grind and put
// a 165-damage BARRETT in front of a player who had just earned it.
export const GUN_GAME_LADDER = [
    0,   // M4A1 CARBINE
    1,   // MP5
    3,   // SPAS-12
    2    // R700 SNIPER — win it with one clean shot
];

// The weapons bots are meant to spawn with. ai.js still rolls across the whole
// of WEAPON_DEFS, which now means Team Deathmatch fills up with .50 cals and
// LMGs — it should roll out of this pool instead.
export const BOT_WEAPON_POOL = [0, 1, 2, 3];

// Grip / muzzle anchor points used by the character IK (weapon-local space).
// `front` is deliberately close to the receiver: further out and the support
// arm reaches full extension, which straightens the elbow and looks wrong.
export const WEAPON_GRIPS = {
    rifle:   { rear: new THREE.Vector3(0, -0.085, 0.04),  front: new THREE.Vector3(0, -0.030, -0.15), muzzle: new THREE.Vector3(0, 0.005, -0.55) },
    smg:     { rear: new THREE.Vector3(0, -0.082, 0.02),  front: new THREE.Vector3(0, -0.035, -0.13), muzzle: new THREE.Vector3(0, 0.005, -0.42) },
    sniper:  { rear: new THREE.Vector3(0, -0.080, 0.06),  front: new THREE.Vector3(0, -0.040, -0.14), muzzle: new THREE.Vector3(0, 0.005, -0.66) },
    shotgun: { rear: new THREE.Vector3(0, -0.080, 0.05),  front: new THREE.Vector3(0, -0.045, -0.15), muzzle: new THREE.Vector3(0, 0.005, -0.52) },
    // Both hands land close together on a pistol; `front` is under the frame so
    // the support elbow still drops rather than flaring out to the side.
    pistol:  { rear: new THREE.Vector3(0, -0.062, 0.038), front: new THREE.Vector3(0, -0.052, -0.010), muzzle: new THREE.Vector3(0, 0.010, -0.150) }
};

// ── primitive helpers ───────────────────────────────────────────────────────
function bx(parent, w, h, d, x, y, z, mat, rx = 0, ry = 0, rz = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = true; parent.add(m); return m;
}
function cyl(parent, rt, rb, h, seg, x, y, z, mat, rx = 0, ry = 0, rz = 0) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = true; parent.add(m); return m;
}
/** Cylinder lying along the Z axis (the usual case for barrels/tubes). */
function tube(parent, rt, rb, len, seg, x, y, z, mat) {
    return cyl(parent, rt, rb, len, seg, x, y, z, mat, Math.PI / 2, 0, 0);
}

function mats() {
    return {
        metal: M.gunMetal(),
        poly: M.polymer(),
        dark: M.plain(0x141618, 0.45, 0.75),
        black: M.plain(0x0c0d0e, 0.6, 0.3),
        tan: M.plain(0x6d5f45, 0.72, 0.05),
        plasticRed: M.plain(0x8c2418, 0.5, 0.1),
        rubber: M.rubber(),
        glass: new THREE.MeshStandardMaterial({
            color: 0x9fc2cf, transparent: true, opacity: 0.14, depthWrite: false,
            roughness: 0.04, metalness: 0.5, envMapIntensity: 1.6
        }),
        dot: new THREE.MeshBasicMaterial({ color: 0xff3a22, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
        dotGlow: new THREE.MeshBasicMaterial({ color: 0xff2a10, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
        glove: M.glove(),
        knuckle: M.plain(0x17181a, 0.5, 0.25),
        skin: M.skin('#c99b6f'),
        sleeveA: M.camoBlue(),
        sleeveB: M.camoRed()
    };
}

// ============================================================================
// SHARED GUN GEOMETRY  (used by both world models and viewmodels; `detail`
// controls how much small hardware gets added)
// ============================================================================
function buildM4(g, m, detail) {
    // ── receivers ──
    bx(g, 0.048, 0.056, 0.235, 0, 0.014, 0.010, m.metal);              // upper
    bx(g, 0.044, 0.062, 0.150, 0, -0.038, 0.048, m.metal);             // lower
    bx(g, 0.050, 0.020, 0.060, 0, 0.045, 0.020, m.metal);              // carry-handle base
    // ── barrel + gas system ──
    tube(g, 0.0105, 0.0105, 0.34, 10, 0, 0.012, -0.275, m.metal);
    bx(g, 0.026, 0.036, 0.045, 0, 0.030, -0.185, m.metal);             // gas block
    tube(g, 0.006, 0.006, 0.16, 6, 0, 0.031, -0.30, m.metal);          // gas tube
    // A2 flash hider
    tube(g, 0.016, 0.014, 0.055, 10, 0, 0.012, -0.462, m.dark);
    tube(g, 0.009, 0.009, 0.02, 8, 0, 0.012, -0.492, m.black);
    // ── handguard: quad rail ──
    for (const [ox, oy] of [[0, 0.035], [0, -0.032], [-0.032, 0], [0.032, 0]]) {
        bx(g, ox === 0 ? 0.060 : 0.014, oy === 0 ? 0.060 : 0.014, 0.215, ox, 0.012 + oy, -0.145, m.dark);
    }
    if (detail) {
        // rail slots
        for (let i = 0; i < 9; i++) bx(g, 0.062, 0.004, 0.010, 0, 0.048, -0.055 - i * 0.022, m.black);
        for (let i = 0; i < 7; i++) bx(g, 0.004, 0.030, 0.010, -0.034, 0.012, -0.070 - i * 0.026, m.black);
        for (let i = 0; i < 7; i++) bx(g, 0.004, 0.030, 0.010, 0.034, 0.012, -0.070 - i * 0.026, m.black);
        // angled foregrip
        bx(g, 0.026, 0.055, 0.036, 0, -0.062, -0.150, m.poly, 0.42);
    }
    // ── magazine (STANAG, slight curve from two segments) ──
    const mag = new THREE.Group(); g.add(mag); mag.position.set(0, -0.062, 0.036);
    bx(mag, 0.028, 0.100, 0.052, 0, -0.048, 0.006, m.poly, 0.10);
    bx(mag, 0.028, 0.075, 0.050, 0, -0.128, 0.028, m.poly, 0.26);
    bx(mag, 0.031, 0.012, 0.055, 0, -0.166, 0.038, m.dark, 0.26);
    g.userData.mag = mag;
    // ── pistol grip ──
    bx(g, 0.030, 0.098, 0.040, 0, -0.108, 0.082, m.poly, 0.30);
    bx(g, 0.032, 0.016, 0.042, 0, -0.155, 0.098, m.poly, 0.30);
    // trigger guard + trigger
    bx(g, 0.020, 0.008, 0.052, 0, -0.078, 0.046, m.metal);
    bx(g, 0.008, 0.024, 0.008, 0, -0.066, 0.046, m.metal, -0.2);
    // ── stock ──
    tube(g, 0.019, 0.019, 0.150, 10, 0, -0.010, 0.190, m.metal);       // buffer tube
    bx(g, 0.044, 0.070, 0.115, 0, -0.014, 0.212, m.poly);              // stock body
    bx(g, 0.050, 0.030, 0.028, 0, -0.040, 0.268, m.rubber);            // butt pad
    bx(g, 0.040, 0.026, 0.055, 0, 0.038, 0.200, m.poly);               // cheek riser
    // ── charging handle ──
    const ch = new THREE.Group(); g.add(ch); ch.position.set(0, 0.040, 0.130);
    bx(ch, 0.052, 0.012, 0.045, 0, 0, 0, m.metal);
    g.userData.charge = ch;
    // ── ejection port ──
    bx(g, 0.006, 0.028, 0.055, 0.026, 0.012, 0.020, m.dark);
    if (detail) {
        bx(g, 0.010, 0.014, 0.014, 0.028, 0.030, 0.052, m.metal);      // forward assist
        bx(g, 0.010, 0.010, 0.020, -0.026, -0.012, 0.062, m.metal);    // mag release
        bx(g, 0.012, 0.006, 0.024, -0.026, -0.006, 0.086, m.metal);    // safety selector
        // sling loop
        cyl(g, 0.008, 0.008, 0.004, 8, 0.030, -0.020, 0.145, m.metal, 0, 0, Math.PI / 2);
    }
    // ── optic: holographic sight ──
    // Built as an OPEN frame. A solid housing would sit dead centre of the
    // screen while aiming and block the target completely.
    const optic = new THREE.Group(); g.add(optic); optic.position.set(0, 0.052, -0.020);
    bx(optic, 0.044, 0.014, 0.076, 0, 0.000, 0.004, m.dark);            // rail clamp
    bx(optic, 0.048, 0.009, 0.020, 0, 0.007, 0.036, m.dark);            // rear bridge
    // window frame: thin side walls, a hood and a sill — the middle stays open
    bx(optic, 0.0045, 0.048, 0.058, -0.0255, 0.033, -0.006, m.dark);
    bx(optic, 0.0045, 0.048, 0.058, 0.0255, 0.033, -0.006, m.dark);
    bx(optic, 0.056, 0.006, 0.062, 0, 0.060, -0.006, m.dark);           // hood
    bx(optic, 0.056, 0.006, 0.020, 0, 0.011, -0.030, m.dark);           // front sill
    bx(optic, 0.028, 0.012, 0.016, 0, 0.061, 0.030, m.dark);            // battery cap
    const lens = bx(optic, 0.046, 0.044, 0.0025, 0, 0.033, -0.030, m.glass);
    lens.castShadow = false;
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.0024, 12), m.dot);
    dot.position.set(0, 0.033, -0.0285); dot.renderOrder = 22; optic.add(dot);
    const halo = new THREE.Mesh(new THREE.CircleGeometry(0.0068, 14), m.dotGlow);
    halo.position.set(0, 0.033, -0.0282); halo.renderOrder = 21; optic.add(halo);
    dot.userData.noMerge = true; halo.userData.noMerge = true;
    g.userData.reticle = dot;
    // sight line for ADS alignment — dead centre of the open window
    g.userData.sight = new THREE.Vector3(0, 0.085, -0.026);
    // iron backup sights
    if (detail) {
        bx(g, 0.004, 0.020, 0.004, -0.010, 0.052, -0.190, m.dark);
        bx(g, 0.004, 0.020, 0.004, 0.010, 0.052, -0.190, m.dark);
    }
}

function buildMP5(g, m, detail) {
    bx(g, 0.044, 0.052, 0.200, 0, 0.008, 0.020, m.metal);              // receiver
    tube(g, 0.020, 0.020, 0.150, 12, 0, 0.010, -0.130, m.metal);       // barrel shroud
    tube(g, 0.0085, 0.0085, 0.20, 8, 0, 0.010, -0.170, m.dark);        // barrel
    tube(g, 0.014, 0.013, 0.030, 8, 0, 0.010, -0.278, m.dark);         // muzzle
    // handguard
    bx(g, 0.038, 0.040, 0.140, 0, -0.014, -0.120, m.poly);
    if (detail) for (let i = 0; i < 6; i++) bx(g, 0.040, 0.004, 0.008, 0, -0.033, -0.065 - i * 0.020, m.dark);
    // cocking-handle tube on the left
    tube(g, 0.011, 0.011, 0.19, 8, -0.028, 0.030, -0.110, m.metal);
    const ch = new THREE.Group(); g.add(ch); ch.position.set(-0.030, 0.030, -0.030);
    bx(ch, 0.024, 0.014, 0.030, 0, 0, 0, m.metal);
    g.userData.charge = ch;
    // magazine — long straight box, slight forward rake
    const mag = new THREE.Group(); g.add(mag); mag.position.set(0, -0.048, -0.012);
    bx(mag, 0.026, 0.175, 0.042, 0, -0.088, -0.008, m.dark, 0.06);
    bx(mag, 0.029, 0.012, 0.045, 0, -0.178, -0.014, m.metal, 0.06);
    g.userData.mag = mag;
    // grip + trigger group
    bx(g, 0.030, 0.095, 0.042, 0, -0.092, 0.078, m.poly, 0.26);
    bx(g, 0.033, 0.014, 0.044, 0, -0.138, 0.090, m.poly, 0.26);
    bx(g, 0.020, 0.008, 0.050, 0, -0.062, 0.048, m.metal);
    bx(g, 0.008, 0.022, 0.008, 0, -0.050, 0.048, m.metal, -0.2);
    // retractable stock
    tube(g, 0.010, 0.010, 0.16, 6, -0.022, 0.006, 0.190, m.metal);
    tube(g, 0.010, 0.010, 0.16, 6, 0.022, 0.006, 0.190, m.metal);
    bx(g, 0.050, 0.048, 0.030, 0, -0.006, 0.270, m.dark);
    // ── sights ──
    // Both the hood and the rear aperture are OPEN frames, and the sight point
    // sits midway down the sight line rather than on the front post. Anchoring
    // on the front post pulls the receiver back onto the camera, and a solid
    // rear drum then fills the whole screen while aiming — same failure the
    // M4's optic is built as an open frame to avoid.
    bx(g, 0.020, 0.014, 0.016, 0, 0.036, -0.196, m.dark);              // post base
    bx(g, 0.0035, 0.016, 0.014, 0, 0.045, -0.196, m.dark);             // post
    bx(g, 0.004, 0.030, 0.014, -0.011, 0.052, -0.196, m.dark);         // hood, left
    bx(g, 0.004, 0.030, 0.014, 0.011, 0.052, -0.196, m.dark);          // hood, right
    bx(g, 0.026, 0.004, 0.014, 0, 0.068, -0.196, m.dark);              // hood, bridge
    bx(g, 0.030, 0.005, 0.016, 0, 0.064, 0.096, m.dark);               // aperture, top
    bx(g, 0.030, 0.005, 0.016, 0, 0.040, 0.096, m.dark);               // aperture, bottom
    bx(g, 0.005, 0.029, 0.016, -0.0125, 0.052, 0.096, m.dark);         // aperture, left
    bx(g, 0.005, 0.029, 0.016, 0.0125, 0.052, 0.096, m.dark);          // aperture, right
    g.userData.sight = new THREE.Vector3(0, 0.052, -0.05);
    if (detail) {
        bx(g, 0.012, 0.008, 0.026, -0.024, -0.028, 0.070, m.metal);    // selector
        bx(g, 0.010, 0.020, 0.010, 0.024, -0.030, -0.010, m.metal);    // mag release
    }
}

function buildR700(g, m, detail) {
    bx(g, 0.042, 0.050, 0.260, 0, 0.010, 0.030, m.metal);              // receiver
    tube(g, 0.0135, 0.0115, 0.520, 12, 0, 0.012, -0.360, m.metal);     // heavy barrel
    tube(g, 0.020, 0.020, 0.050, 12, 0, 0.012, -0.630, m.dark);        // muzzle brake
    if (detail) for (let i = 0; i < 4; i++) bx(g, 0.042, 0.005, 0.006, 0, 0.030, -0.615 - i * 0.011, m.black);
    // stock — full length, thumbhole style
    bx(g, 0.048, 0.055, 0.290, 0, -0.036, -0.100, m.tan);              // forend
    bx(g, 0.050, 0.070, 0.180, 0, -0.026, 0.140, m.tan);               // wrist/comb
    bx(g, 0.052, 0.095, 0.070, 0, -0.030, 0.255, m.tan);               // butt
    bx(g, 0.056, 0.040, 0.026, 0, -0.062, 0.295, m.rubber);            // recoil pad
    bx(g, 0.046, 0.030, 0.090, 0, 0.030, 0.150, m.tan);                // cheek piece
    // bipod
    if (detail) {
        for (const s of [-1, 1]) cyl(g, 0.005, 0.005, 0.14, 6, s * 0.030, -0.120, -0.230, m.dark, 0, 0, s * 0.30);
        bx(g, 0.030, 0.020, 0.030, 0, -0.062, -0.230, m.dark);
    }
    // bolt
    const bolt = new THREE.Group(); g.add(bolt); bolt.position.set(0.026, 0.020, 0.090);
    tube(bolt, 0.008, 0.008, 0.10, 8, 0, 0, 0.010, m.metal);
    cyl(bolt, 0.007, 0.007, 0.045, 8, 0.020, 0, 0.055, m.metal, 0, 0, Math.PI / 2);
    cyl(bolt, 0.011, 0.011, 0.014, 10, 0.044, 0, 0.055, m.metal, 0, 0, Math.PI / 2);
    g.userData.bolt = bolt;
    // internal magazine / floorplate
    const mag = new THREE.Group(); g.add(mag); mag.position.set(0, -0.050, 0.010);
    bx(mag, 0.032, 0.050, 0.080, 0, -0.020, 0, m.metal);
    g.userData.mag = mag;
    // grip + trigger
    bx(g, 0.032, 0.090, 0.044, 0, -0.090, 0.108, m.tan, 0.34);
    bx(g, 0.020, 0.008, 0.048, 0, -0.062, 0.070, m.metal);
    bx(g, 0.008, 0.022, 0.008, 0, -0.050, 0.070, m.metal, -0.2);
    // scope
    const sc = new THREE.Group(); g.add(sc); sc.position.set(0, 0.072, -0.020);
    tube(sc, 0.019, 0.019, 0.230, 14, 0, 0, 0, m.dark);                // main tube
    tube(sc, 0.030, 0.026, 0.070, 14, 0, 0, -0.135, m.dark);           // objective bell
    tube(sc, 0.026, 0.022, 0.055, 14, 0, 0, 0.135, m.dark);            // ocular
    cyl(sc, 0.014, 0.014, 0.022, 10, 0, 0.024, -0.020, m.dark);        // elevation turret
    cyl(sc, 0.013, 0.013, 0.020, 10, 0.024, 0, -0.020, m.dark, 0, 0, Math.PI / 2);
    for (const z of [-0.075, 0.070]) bx(sc, 0.036, 0.040, 0.020, 0, -0.020, z, m.dark);  // rings
    const lensF = cyl(sc, 0.026, 0.026, 0.002, 16, 0, 0, -0.168, m.glass, Math.PI / 2);
    lensF.castShadow = false;
    g.userData.scope = sc;
    g.userData.sight = new THREE.Vector3(0, 0.072, -0.020);
}

function buildSPAS(g, m, detail) {
    bx(g, 0.050, 0.060, 0.230, 0, 0.006, 0.040, m.metal);              // receiver
    tube(g, 0.0165, 0.0165, 0.430, 12, 0, 0.020, -0.240, m.metal);     // barrel
    tube(g, 0.0195, 0.0195, 0.055, 12, 0, 0.020, -0.470, m.dark);      // choke
    tube(g, 0.0155, 0.0155, 0.360, 12, 0, -0.020, -0.210, m.metal);    // mag tube
    // pump / forend
    const pump = new THREE.Group(); g.add(pump); pump.position.set(0, -0.020, -0.190);
    bx(pump, 0.050, 0.050, 0.140, 0, 0, 0, m.poly);
    if (detail) for (let i = 0; i < 6; i++) bx(pump, 0.052, 0.005, 0.008, 0, 0.020, -0.050 + i * 0.020, m.dark);
    g.userData.pump = pump;
    // heat shield over the barrel
    bx(g, 0.036, 0.008, 0.230, 0, 0.040, -0.230, m.dark);
    if (detail) for (let i = 0; i < 8; i++) bx(g, 0.012, 0.010, 0.012, 0, 0.040, -0.130 - i * 0.026, m.black);
    // folding stock
    bx(g, 0.046, 0.070, 0.120, 0, -0.010, 0.190, m.poly);
    bx(g, 0.010, 0.056, 0.100, 0, -0.006, 0.280, m.dark);
    bx(g, 0.052, 0.036, 0.024, 0, -0.034, 0.330, m.rubber);
    // grip + trigger
    bx(g, 0.032, 0.096, 0.044, 0, -0.098, 0.098, m.poly, 0.28);
    bx(g, 0.022, 0.008, 0.052, 0, -0.062, 0.062, m.metal);
    bx(g, 0.008, 0.022, 0.008, 0, -0.050, 0.062, m.metal, -0.2);
    // shell carrier + loading port
    const mag = new THREE.Group(); g.add(mag); mag.position.set(0, -0.030, 0.020);
    g.userData.mag = mag;
    if (detail) {
        for (let i = 0; i < 4; i++)
            cyl(g, 0.009, 0.009, 0.055, 8, -0.034, -0.014 + i * 0.020, 0.150, m.plasticRed, 0, 0, Math.PI / 2);
    }
    // ghost-ring sights
    bx(g, 0.016, 0.030, 0.014, 0, 0.048, -0.420, m.dark);
    cyl(g, 0.014, 0.014, 0.014, 12, 0, 0.052, 0.070, m.dark, Math.PI / 2);
    g.userData.sight = new THREE.Vector3(0, 0.054, -0.420);
}

function buildPistol(g, m, detail) {
    // ── slide ──
    bx(g, 0.030, 0.042, 0.215, 0, 0.014, -0.033, m.metal);
    bx(g, 0.024, 0.008, 0.180, 0, 0.036, -0.040, m.dark);              // top rib between the sights
    // one thin slab per groove: reads as serrations on both flanks at once
    if (detail) for (let i = 0; i < 7; i++) bx(g, 0.032, 0.034, 0.004, 0, 0.014, 0.028 + i * 0.010, m.dark);
    // ── barrel ──
    tube(g, 0.0115, 0.0115, 0.030, 10, 0, 0.010, -0.130, m.metal);     // bushing at the muzzle
    tube(g, 0.0062, 0.0062, 0.040, 8, 0, 0.010, -0.135, m.black);      // bore
    // ── frame ──
    bx(g, 0.026, 0.028, 0.125, 0, -0.016, -0.070, m.poly);             // dust cover
    bx(g, 0.030, 0.036, 0.092, 0, -0.016, 0.028, m.poly);              // trigger housing
    bx(g, 0.028, 0.012, 0.030, 0, 0.000, 0.078, m.metal, -0.22);       // beavertail
    // Hammer kept low: it is only 100 mm from the eye when aiming, so anything
    // near the sight line here covers the whole notch.
    bx(g, 0.008, 0.020, 0.010, 0, 0.024, 0.083, m.metal, -0.30);
    bx(g, 0.005, 0.020, 0.052, 0.015, 0.020, -0.008, m.dark);          // ejection port
    if (detail) for (let i = 0; i < 3; i++) bx(g, 0.028, 0.004, 0.006, 0, -0.031, -0.048 - i * 0.020, m.black);  // accessory rail
    // ── grip (raked back to match the hand pose the viewmodel uses) ──
    bx(g, 0.030, 0.105, 0.045, 0, -0.082, 0.040, m.poly, 0.28);
    if (detail) for (let i = 0; i < 4; i++) bx(g, 0.032, 0.007, 0.047, 0, -0.047 - i * 0.021, 0.050 - i * 0.006, m.dark, 0.28);
    // ── magazine: only the floorplate shows until the reload drops it ──
    const mag = new THREE.Group(); g.add(mag); mag.position.set(0, -0.082, 0.040);
    bx(mag, 0.022, 0.098, 0.034, 0, 0, 0, m.dark, 0.28);
    bx(mag, 0.032, 0.011, 0.046, 0, -0.056, -0.016, m.poly, 0.28);
    g.userData.mag = mag;
    // The slide is deliberately NOT exported as `charge`: the shared reload
    // animation throws that part 75 mm rearward, which is fine for a charging
    // handle and three times a real slide's travel.
    // ── trigger group ──
    bx(g, 0.020, 0.008, 0.050, 0, -0.042, -0.006, m.metal);            // guard, bottom bar
    bx(g, 0.018, 0.028, 0.008, 0, -0.030, -0.030, m.metal);            // guard, front strut
    bx(g, 0.008, 0.024, 0.008, 0, -0.028, -0.002, m.metal, -0.2);      // trigger
    if (detail) {
        bx(g, 0.008, 0.008, 0.032, -0.017, -0.002, 0.014, m.metal);    // slide stop
        bx(g, 0.009, 0.008, 0.020, -0.017, 0.020, 0.052, m.metal);     // safety
        bx(g, 0.008, 0.010, 0.010, -0.017, -0.026, 0.004, m.metal);    // mag release
    }
    // ── sights ──
    bx(g, 0.024, 0.012, 0.014, 0, 0.041, 0.052, m.dark);               // rear block
    bx(g, 0.005, 0.014, 0.008, 0, 0.042, -0.126, m.dark);              // front post
    if (detail) {
        // notch: two posts either side of the gap the front post sits in
        bx(g, 0.004, 0.008, 0.008, -0.008, 0.045, 0.048, m.black);
        bx(g, 0.004, 0.008, 0.008, 0.008, 0.045, 0.048, m.black);
        // Tritium three-dot. Black sights on a black slide are a single
        // silhouette while aiming; these are the only thing that reads.
        // Sat just under the top of each post, so the dots land on the aim
        // point rather than a few milliradians under it.
        bx(g, 0.0034, 0.0034, 0.0015, 0, 0.0465, -0.1214, m.dot);
        bx(g, 0.0026, 0.0026, 0.0015, -0.008, 0.0470, 0.0600, m.dot);
        bx(g, 0.0026, 0.0026, 0.0015, 0.008, 0.0470, 0.0600, m.dot);
    }
    g.userData.sight = new THREE.Vector3(0, 0.048, -0.126);
}

const BUILDERS = { rifle: buildM4, smg: buildMP5, sniper: buildR700, shotgun: buildSPAS, pistol: buildPistol };

// ============================================================================
// WORLD MODEL (carried by bots) — same shapes, less hardware
// ============================================================================
export function createWorldWeapon(type) {
    const g = new THREE.Group();
    const m = mats();
    (BUILDERS[type] || buildM4)(g, m, false);
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    return g;
}

// ============================================================================
// HANDS — built directly in gun space so no guessing at Euler angles
// ============================================================================

/** Hand wrapped around a (roughly vertical) pistol grip, index finger on the trigger. */
function makeGripHand(m, side = 1) {
    const h = new THREE.Group();
    // back of hand + wrist
    bx(h, 0.050, 0.105, 0.038, 0, -0.040, 0.030, m.glove);
    bx(h, 0.046, 0.040, 0.030, 0, 0.014, 0.038, m.glove);
    // knuckle armour
    bx(h, 0.048, 0.030, 0.020, 0, -0.005, -0.004, m.knuckle);
    // palm heel
    bx(h, 0.044, 0.045, 0.030, 0, -0.070, 0.026, m.glove);

    // fingers wrapping the front of the grip (middle, ring, pinky)
    for (let i = 0; i < 3; i++) {
        const y = -0.030 - i * 0.024;
        const f = new THREE.Group(); f.position.set(0, y, 0.010); h.add(f);
        bx(f, 0.044 - i * 0.003, 0.019, 0.040, 0, 0, -0.020, m.glove);          // proximal, over the front
        bx(f, 0.042 - i * 0.003, 0.019, 0.024, 0, -0.008, -0.048, m.glove, 0.6); // curling back under
        bx(f, 0.040 - i * 0.003, 0.017, 0.020, 0, -0.024, -0.052, m.glove, 1.2); // fingertip
    }
    // index finger reaching forward to the trigger
    const idx = new THREE.Group(); idx.position.set(0, -0.006, 0.004); h.add(idx);
    bx(idx, 0.020, 0.019, 0.052, 0, 0, -0.030, m.glove, -0.12);
    bx(idx, 0.018, 0.018, 0.030, 0, -0.010, -0.066, m.glove, 0.65);
    h.userData.trigger = idx;
    // thumb across the back/side of the grip
    const th = new THREE.Group(); th.position.set(side * -0.026, -0.014, 0.030); h.add(th);
    bx(th, 0.022, 0.046, 0.026, 0, -0.020, 0, m.glove, 0.35, 0, side * 0.55);
    bx(th, 0.020, 0.034, 0.022, side * -0.012, -0.050, -0.010, m.glove, 0.9, 0, side * 0.7);
    return h;
}

/** Hand wrapped under/around a horizontal handguard. */
function makeSupportHand(m, side = -1) {
    const h = new THREE.Group();
    // palm under the handguard
    bx(h, 0.048, 0.036, 0.105, 0, -0.038, 0.006, m.glove);
    // heel + wrist stub angled back and down
    bx(h, 0.046, 0.050, 0.048, side * 0.006, -0.052, 0.072, m.glove, -0.35);
    bx(h, 0.042, 0.044, 0.040, side * 0.012, -0.078, 0.104, m.glove, -0.5);
    // back-of-hand plate on the outside
    bx(h, 0.014, 0.048, 0.090, side * 0.030, -0.026, 0.004, m.glove);
    bx(h, 0.010, 0.026, 0.060, side * 0.036, -0.014, 0.004, m.knuckle);

    // four fingers arcing over the top of the handguard
    for (let i = 0; i < 4; i++) {
        const z = -0.042 + i * 0.026;
        const f = new THREE.Group(); f.position.set(side * 0.026, -0.030, z); h.add(f);
        bx(f, 0.032, 0.018, 0.020, side * -0.014, 0.020, 0, m.glove, 0, 0, side * -0.8);
        bx(f, 0.034, 0.017, 0.019, side * -0.040, 0.030, 0, m.glove, 0, 0, side * -0.2);
        bx(f, 0.024, 0.016, 0.018, side * -0.060, 0.020, 0, m.glove, 0, 0, side * 0.6);
    }
    // thumb along the near side
    bx(h, 0.020, 0.024, 0.060, side * -0.026, -0.026, 0.020, m.glove, 0.25);
    return h;
}

/**
 * Forearm running from the hand back toward an off-screen shoulder anchor.
 * Mostly sleeve with a short strip of skin at the wrist — a long bare forearm
 * this close to the camera reads as a featureless flesh-coloured slab.
 */
function makeForearm(parent, m, fromV, toV, rTop, rBot, sleeveMat) {
    const dir = new THREE.Vector3().subVectors(toV, fromV);
    const len = dir.length();
    const mid = new THREE.Vector3().addVectors(fromV, toV).multiplyScalar(0.5);

    const g = new THREE.Group();
    g.position.copy(mid);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    parent.add(g);

    const y0 = -len / 2;
    // glove cuff at the wrist
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(rTop * 1.12, rTop * 1.06, 0.045, 10), m.glove);
    cuff.position.y = y0 + 0.022; g.add(cuff);
    // short strip of bare wrist
    const skinLen = Math.min(0.075, len * 0.16);
    const skin = new THREE.Mesh(new THREE.CylinderGeometry(rTop * 0.98, rTop * 1.08, skinLen, 10), m.skin);
    skin.position.y = y0 + 0.045 + skinLen / 2; g.add(skin);
    // rolled cuff of the sleeve
    const roll = new THREE.Mesh(new THREE.CylinderGeometry(rTop * 1.26, rTop * 1.20, 0.032, 10), sleeveMat);
    roll.position.y = y0 + 0.045 + skinLen + 0.016; g.add(roll);
    // the sleeve itself, running off the bottom of the frame
    const sleeveLen = len - (0.045 + skinLen + 0.032);
    const sl = new THREE.Mesh(new THREE.CylinderGeometry(rTop * 1.20, rBot, sleeveLen, 10), sleeveMat);
    sl.position.y = y0 + 0.045 + skinLen + 0.032 + sleeveLen / 2; g.add(sl);

    g.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    return g;
}

// ============================================================================
// VIEWMODEL
// Returns { group, parts } where `group` should be added to the viewmodel scene.
// ============================================================================
export function createViewModel(index, team = 0) {
    const def = WEAPON_DEFS[index];
    const m = mats();
    const sleeve = team === 0 ? m.sleeveA : m.sleeveB;

    const group = new THREE.Group();
    group.name = 'vm_' + def.short;

    const gun = new THREE.Group();
    group.add(gun);
    (BUILDERS[def.type] || buildM4)(gun, m, true);

    // ── hand placement per weapon ──
    let gripPos, gripRot, supPos, supRot;
    if (def.type === 'rifle') {
        gripPos = new THREE.Vector3(0, -0.088, 0.080); gripRot = new THREE.Euler(0.30, 0, 0);
        supPos = new THREE.Vector3(0, -0.010, -0.150); supRot = new THREE.Euler(0.10, 0, 0.15);
    } else if (def.type === 'smg') {
        gripPos = new THREE.Vector3(0, -0.078, 0.078); gripRot = new THREE.Euler(0.26, 0, 0);
        supPos = new THREE.Vector3(0, -0.014, -0.120); supRot = new THREE.Euler(0.08, 0, 0.18);
    } else if (def.type === 'sniper') {
        gripPos = new THREE.Vector3(0, -0.082, 0.106); gripRot = new THREE.Euler(0.34, 0, 0);
        supPos = new THREE.Vector3(0, -0.032, -0.110); supRot = new THREE.Euler(0.06, 0, 0.12);
    } else if (def.type === 'pistol') {
        // Carried one-handed. The support hand is modelled to wrap a horizontal
        // handguard; cupped round the firing hand at this camera distance the
        // two read as a single lump of glove.
        gripPos = new THREE.Vector3(0, -0.062, 0.038); gripRot = new THREE.Euler(0.28, 0, 0);
        supPos = null; supRot = null;
    } else {
        gripPos = new THREE.Vector3(0, -0.090, 0.096); gripRot = new THREE.Euler(0.28, 0, 0);
        supPos = new THREE.Vector3(0, -0.040, -0.190); supRot = new THREE.Euler(0.05, 0, 0.14);
    }

    const handR = makeGripHand(m, 1);
    handR.position.copy(gripPos); handR.rotation.copy(gripRot);
    gun.add(handR);

    let handL = null;
    if (supPos) {
        handL = makeSupportHand(m, -1);
        handL.position.copy(supPos); handL.rotation.copy(supRot);
        gun.add(handL);
    }

    // forearms leading steeply off the bottom of the screen
    makeForearm(gun, m, new THREE.Vector3(gripPos.x + 0.008, gripPos.y - 0.070, gripPos.z + 0.070),
                new THREE.Vector3(0.20, -0.52, 0.40), 0.032, 0.052, sleeve);
    if (supPos) {
        makeForearm(gun, m, new THREE.Vector3(supPos.x - 0.026, supPos.y - 0.078, supPos.z + 0.090),
                    new THREE.Vector3(-0.14, -0.54, 0.26), 0.031, 0.050, sleeve);
    }

    handR.traverse(o => { if (o.isMesh) o.castShadow = false; });
    if (handL) handL.traverse(o => { if (o.isMesh) o.castShadow = false; });

    // ── muzzle flash rig ──
    const muzzle = new THREE.Group();
    muzzle.userData.noMerge = true;      // flash billboards animate independently
    const mz = (WEAPON_GRIPS[def.type] || WEAPON_GRIPS.rifle).muzzle;
    muzzle.position.set(mz.x, mz.y + 0.008, mz.z * 0.94);
    gun.add(muzzle);

    const flashMat = new THREE.MeshBasicMaterial({
        color: 0xffcf7a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
    });
    const fCore = new THREE.Mesh(new THREE.SphereGeometry(0.030, 8, 6), flashMat);
    const fCone = new THREE.Mesh(new THREE.ConeGeometry(0.030, 0.13, 7), flashMat.clone());
    fCone.rotation.x = -Math.PI / 2; fCone.position.z = -0.065;
    const fStar = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.24), flashMat.clone());
    fStar.position.z = -0.02;
    muzzle.add(fCore, fCone, fStar);
    const flashLight = new THREE.PointLight(0xffb45a, 0, 3.5, 2);
    flashLight.position.z = -0.05;
    muzzle.add(flashLight);

    const parts = {
        gun,
        mag: gun.userData.mag || null,
        charge: gun.userData.charge || null,
        bolt: gun.userData.bolt || null,
        pump: gun.userData.pump || null,
        reticle: gun.userData.reticle || null,
        scope: gun.userData.scope || null,
        sight: (gun.userData.sight || new THREE.Vector3(0, 0.05, -0.1)).clone(),
        handR, handL,
        trigger: handR.userData.trigger,
        muzzle, flash: [fCore, fCone, fStar], flashLight,
        magHome: gun.userData.mag ? gun.userData.mag.position.clone() : null,
        chargeHome: gun.userData.charge ? gun.userData.charge.position.clone() : null,
        boltHome: gun.userData.bolt ? gun.userData.bolt.position.clone() : null,
        pumpHome: gun.userData.pump ? gun.userData.pump.position.clone() : null,
        ejectPort: new THREE.Vector3(0.03, 0.02, def.type === 'sniper' ? 0.09 : 0.02)
    };

    // ADS position: put the sight line exactly on the camera axis
    const adsDist = def.scope ? 0.20 : 0.315;
    parts.adsPos = new THREE.Vector3(-parts.sight.x, -parts.sight.y, -adsDist - parts.sight.z);
    // Hip position: lower right, far enough out that the whole weapon reads.
    // A pistol held at the rifle distance is a quarter of the size on screen,
    // so it comes in closer and less far out to the right.
    parts.hipPos = def.type === 'pistol'
        ? new THREE.Vector3(0.112, -0.088, -0.31)
        : new THREE.Vector3(0.150, -0.118, -0.40);
    parts.hipRot = new THREE.Euler(0.035, -0.085, 0.030);
    parts.adsRot = new THREE.Euler(0, 0, 0);

    return { group, parts, def };
}
