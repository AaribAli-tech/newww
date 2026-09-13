// ============================================================================
// materials.js — procedural PBR texture + material library
// Every surface in the game gets a real albedo map, a derived normal map and a
// roughness map so lighting reads like a photographed surface instead of flat
// vertex colour.
// ============================================================================
import * as THREE from 'three';

const TEX_CACHE = new Map();

// ── canvas plumbing ─────────────────────────────────────────────────────────
function mkCanvas(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    // these canvases exist to be read back by the normal/roughness derivation
    c.getContext('2d', { willReadFrequently: true });
    return c;
}

function asTexture(canvas, repeat = 1, srgb = true) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
}

/** Sobel a canvas' luminance into a tangent-space normal map. */
function normalFromCanvas(src, strength = 2.0) {
    const size = src.width;
    const sctx = src.getContext('2d');
    const data = sctx.getImageData(0, 0, size, size).data;
    const lum = new Float32Array(size * size);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        lum[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
    }
    const out = mkCanvas(size);
    const octx = out.getContext('2d');
    const img = octx.createImageData(size, size);
    const at = (x, y) => lum[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1)) -
                       (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
            const dy = (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1)) -
                       (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
            let nx = dx * strength, ny = dy * strength, nz = 1;
            const len = Math.hypot(nx, ny, nz);
            nx /= len; ny /= len; nz /= len;
            const o = (y * size + x) * 4;
            img.data[o]     = (nx * 0.5 + 0.5) * 255;
            img.data[o + 1] = (ny * 0.5 + 0.5) * 255;
            img.data[o + 2] = (nz * 0.5 + 0.5) * 255;
            img.data[o + 3] = 255;
        }
    }
    octx.putImageData(img, 0, 0);
    return out;
}

/** Greyscale copy remapped into a roughness range. */
function roughFromCanvas(src, lo = 0.55, hi = 0.95) {
    const size = src.width;
    const data = src.getContext('2d').getImageData(0, 0, size, size).data;
    const out = mkCanvas(size);
    const octx = out.getContext('2d');
    const img = octx.createImageData(size, size);
    for (let i = 0; i < data.length; i += 4) {
        const l = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255;
        const v = (lo + (hi - lo) * (1 - l)) * 255;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    return out;
}

/**
 * Build a full PBR material from one draw function.
 * opts: { size, repeat, normalScale, rough:[lo,hi], metalness, color, ...matOpts }
 */
function surface(key, drawFn, opts = {}) {
    if (TEX_CACHE.has(key)) return TEX_CACHE.get(key);
    const size = opts.size || 256;
    const c = mkCanvas(size);
    drawFn(c.getContext('2d'), size);

    const params = {
        map: asTexture(c, opts.repeat || 1),
        roughness: 1.0,
        metalness: opts.metalness ?? 0.0
    };
    if (opts.normalScale !== 0) {
        params.normalMap = asTexture(normalFromCanvas(c, opts.normalStrength ?? 2), opts.repeat || 1, false);
        params.normalScale = new THREE.Vector2(opts.normalScale ?? 0.8, opts.normalScale ?? 0.8);
    }
    const [lo, hi] = opts.rough || [0.6, 0.95];
    params.roughnessMap = asTexture(roughFromCanvas(c, lo, hi), opts.repeat || 1, false);
    if (opts.color) params.color = new THREE.Color(opts.color);
    if (opts.envMapIntensity !== undefined) params.envMapIntensity = opts.envMapIntensity;
    if (opts.side) params.side = opts.side;
    if (opts.transparent) { params.transparent = true; params.opacity = opts.opacity ?? 1; }
    if (opts.alphaTest) { params.alphaTest = opts.alphaTest; params.transparent = true; }
    if (opts.emissive) { params.emissive = new THREE.Color(opts.emissive); params.emissiveIntensity = opts.emissiveIntensity ?? 1; }

    const mat = new THREE.MeshStandardMaterial(params);
    TEX_CACHE.set(key, mat);
    return mat;
}

// ── little painting helpers ────────────────────────────────────────────────
function fill(ctx, size, color) { ctx.fillStyle = color; ctx.fillRect(0, 0, size, size); }

function grain(ctx, size, amount, alpha = 1) {
    const img = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < img.data.length; i += 4) {
        const n = (Math.random() - 0.5) * amount;
        img.data[i]     = Math.max(0, Math.min(255, img.data[i] + n));
        img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
        img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
    }
    ctx.putImageData(img, 0, 0);
    if (alpha < 1) { /* no-op, kept for signature symmetry */ }
}

function blobs(ctx, size, count, rMin, rMax, colors, alpha = 1) {
    ctx.globalAlpha = alpha;
    for (let i = 0; i < count; i++) {
        ctx.fillStyle = colors[(Math.random() * colors.length) | 0];
        const x = Math.random() * size, y = Math.random() * size;
        const r = rMin + Math.random() * (rMax - rMin);
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * (0.6 + Math.random() * 0.8), Math.random() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

function scratches(ctx, size, count, color, wMax = 1.2, len = 40) {
    ctx.strokeStyle = color;
    for (let i = 0; i < count; i++) {
        ctx.lineWidth = 0.3 + Math.random() * wMax;
        ctx.globalAlpha = 0.15 + Math.random() * 0.4;
        const x = Math.random() * size, y = Math.random() * size;
        const a = Math.random() * Math.PI * 2, l = 5 + Math.random() * len;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
}

function cracks(ctx, size, count, color) {
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    for (let i = 0; i < count; i++) {
        let x = Math.random() * size, y = Math.random() * size;
        let a = Math.random() * Math.PI * 2;
        ctx.globalAlpha = 0.25 + Math.random() * 0.35;
        ctx.lineWidth = 0.6 + Math.random();
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let s = 0; s < 12; s++) {
            a += (Math.random() - 0.5) * 1.1;
            x += Math.cos(a) * 6; y += Math.sin(a) * 6;
            ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
}

// ============================================================================
// GROUND
// ============================================================================
// Warm-grey, not blue-grey: dark surfaces pick up a lot of sky colour from the
// environment map, so the albedo has to lean warm to end up neutral on screen.
export const asphalt = () => surface('asphalt', (ctx, s) => {
    fill(ctx, s, '#4a463f');
    blobs(ctx, s, 900, 0.6, 2.4, ['#3c3830', '#585349', '#635d52', '#332f29'], 0.85);
    grain(ctx, s, 26);
    cracks(ctx, s, 7, '#2a2721');
    blobs(ctx, s, 40, 3, 9, ['#454138', '#524d43'], 0.4);
    // sun-bleached patches down the middle of the road
    blobs(ctx, s, 14, 10, 26, ['rgba(150,142,124,0.14)'], 1);
}, { repeat: 8, rough: [0.80, 0.99], normalScale: 0.45, size: 256, envMapIntensity: 0.25 });

// Real concrete has an albedo around 0.3. Painting it near-white blows out
// instantly under a strong sun plus ACES tone mapping.
export const concrete = () => surface('concrete', (ctx, s) => {
    fill(ctx, s, '#8f8b80');
    grain(ctx, s, 22);
    blobs(ctx, s, 300, 1, 3, ['#827e74', '#9d998e'], 0.5);
    cracks(ctx, s, 4, '#6a6760');
    blobs(ctx, s, 20, 5, 16, ['rgba(90,86,78,0.22)'], 1);   // staining
    // faint slab seams
    ctx.strokeStyle = '#6d6a63'; ctx.globalAlpha = 0.6; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, s / 2); ctx.lineTo(s, s / 2); ctx.stroke();
    ctx.globalAlpha = 1;
}, { repeat: 4, rough: [0.74, 0.96], normalScale: 0.5, envMapIntensity: 0.4 });

export const sidewalk = () => surface('sidewalk', (ctx, s) => {
    fill(ctx, s, '#9d998c');
    grain(ctx, s, 18);
    blobs(ctx, s, 260, 1, 2.6, ['#8f8b7e', '#a9a598'], 0.45);
    blobs(ctx, s, 16, 6, 18, ['rgba(105,100,90,0.20)'], 1);
    ctx.strokeStyle = '#726e64'; ctx.lineWidth = 3; ctx.globalAlpha = 0.75;
    ctx.strokeRect(1.5, 1.5, s - 3, s - 3);
    ctx.globalAlpha = 1;
}, { repeat: 6, rough: [0.72, 0.95], normalScale: 0.7, envMapIntensity: 0.4 });

// Sun-beaten Nevada lawn — olive and khaki rather than golf-course green.
export const lawn = () => surface('lawn', (ctx, s) => {
    fill(ctx, s, '#5f6b3a');
    blobs(ctx, s, 700, 1, 4, ['#4e5c2f', '#6d7645', '#78804d', '#565f33'], 0.75);
    // dead patches showing the dirt through
    blobs(ctx, s, 30, 8, 24, ['#8a7c4e', '#95875c', '#7d6f48'], 0.34);
    // grass blade streaks
    ctx.lineWidth = 0.7;
    for (let i = 0; i < 900; i++) {
        ctx.strokeStyle = ['#485330', '#7c8452', '#69713d', '#8b8253'][(Math.random() * 4) | 0];
        ctx.globalAlpha = 0.45;
        const x = Math.random() * s, y = Math.random() * s;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (Math.random() - 0.5) * 3, y - 2 - Math.random() * 3); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    grain(ctx, s, 16);
}, { repeat: 20, rough: [0.88, 1.0], normalScale: 0.45, envMapIntensity: 0.45 });

export const sand = () => surface('sand', (ctx, s) => {
    fill(ctx, s, '#c8ac82');
    grain(ctx, s, 26);
    blobs(ctx, s, 400, 1, 3, ['#bda072', '#d6bb95', '#b39468'], 0.55);
    blobs(ctx, s, 60, 1.2, 2.4, ['#8f7a58', '#a08a66'], 0.7); // pebbles
    // wind ripples
    ctx.strokeStyle = '#b89b72'; ctx.globalAlpha = 0.25; ctx.lineWidth = 2;
    for (let y = 0; y < s; y += 9) {
        ctx.beginPath();
        for (let x = 0; x <= s; x += 8) ctx.lineTo(x, y + Math.sin(x * 0.08 + y) * 2.5);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
}, { repeat: 40, rough: [0.9, 1.0], normalScale: 0.35 });

export const dirt = () => surface('dirt', (ctx, s) => {
    fill(ctx, s, '#8a7355');
    grain(ctx, s, 30);
    blobs(ctx, s, 400, 1, 4, ['#7a6448', '#9a8264', '#6d5a40'], 0.6);
}, { repeat: 8, rough: [0.9, 1.0], normalScale: 0.5 });

// ============================================================================
// HOUSE EXTERIOR
// ============================================================================
function sidingDraw(base, shade, light) {
    return (ctx, s) => {
        fill(ctx, s, base);
        const rows = 8, h = s / rows;
        for (let i = 0; i < rows; i++) {
            const y = i * h;
            // board face with subtle vertical gradient
            const g = ctx.createLinearGradient(0, y, 0, y + h);
            g.addColorStop(0, light);
            g.addColorStop(0.35, base);
            g.addColorStop(1, shade);
            ctx.fillStyle = g;
            ctx.fillRect(0, y, s, h - 1);
            // shadow line under each lap — subtle, or the wall reads as corrugated metal
            ctx.fillStyle = 'rgba(0,0,0,0.16)';
            ctx.fillRect(0, y + h - 2, s, 2);
        }
        // weathering
        blobs(ctx, s, 40, 3, 14, ['rgba(90,80,60,0.10)', 'rgba(255,255,255,0.08)'], 1);
        scratches(ctx, s, 40, 'rgba(60,50,35,0.5)', 0.8, 18);
        grain(ctx, s, 10);
    };
}

export const sidingYellow = () => surface('sidingY', sidingDraw('#e3cf62', '#b8a544', '#f2e393'),
    { repeat: 2, rough: [0.66, 0.88], normalScale: 0.55, normalStrength: 2 });

export const sidingTeal = () => surface('sidingT', sidingDraw('#3f9a86', '#2c7365', '#5cbcaa'),
    { repeat: 2, rough: [0.66, 0.88], normalScale: 0.55, normalStrength: 2 });

export const sidingWhite = () => surface('sidingW', sidingDraw('#e9e6dc', '#c4c0b4', '#faf8f2'),
    { repeat: 2, rough: [0.6, 0.85], normalScale: 1.0, normalStrength: 3 });

export const trim = () => surface('trim', (ctx, s) => {
    fill(ctx, s, '#d9d5c9');
    grain(ctx, s, 8);
    scratches(ctx, s, 30, 'rgba(130,120,100,0.42)', 0.6, 14);
    blobs(ctx, s, 18, 4, 12, ['rgba(120,112,96,0.16)'], 1);
}, { repeat: 1, rough: [0.5, 0.74], normalScale: 0.3, envMapIntensity: 0.45 });

export const shingles = () => surface('shingle', (ctx, s) => {
    fill(ctx, s, '#514f4c');
    const rows = 10, h = s / rows;
    for (let r = 0; r < rows; r++) {
        const y = r * h;
        const off = (r % 2) * (s / 12);
        for (let c = -1; c < 12; c++) {
            const x = off + c * (s / 12);
            const tone = ['#4a4845', '#5a5854', '#43413e', '#615f5b'][(Math.random() * 4) | 0];
            ctx.fillStyle = tone;
            ctx.fillRect(x + 0.5, y + 0.5, s / 12 - 1, h - 1.5);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(0, y + h - 2, s, 2);
    }
    grain(ctx, s, 26);
    blobs(ctx, s, 30, 4, 12, ['rgba(120,115,105,0.12)'], 1);
}, { repeat: 4, rough: [0.8, 0.98], normalScale: 1.2, normalStrength: 3 });

export const brick = () => surface('brick', (ctx, s) => {
    fill(ctx, s, '#8d6a52');
    const rows = 12, h = s / rows;
    for (let r = 0; r < rows; r++) {
        const y = r * h, off = (r % 2) * (s / 8);
        for (let c = -1; c < 9; c++) {
            ctx.fillStyle = ['#9c6d4f', '#a5745a', '#8a5f47', '#b07f62', '#94664e'][(Math.random() * 5) | 0];
            ctx.fillRect(off + c * (s / 8) + 1.5, y + 1.5, s / 8 - 3, h - 3);
        }
    }
    grain(ctx, s, 22);
}, { repeat: 3, rough: [0.82, 0.98], normalScale: 1.1, normalStrength: 3 });

export const stucco = () => surface('stucco', (ctx, s) => {
    fill(ctx, s, '#cfc6b2');
    grain(ctx, s, 26);
    blobs(ctx, s, 900, 0.8, 2.2, ['#c2b9a5', '#dcd3bf'], 0.6);
}, { repeat: 3, rough: [0.78, 0.96], normalScale: 0.8 });

// ============================================================================
// HOUSE INTERIOR
// ============================================================================
export const plaster = () => surface('plaster', (ctx, s) => {
    fill(ctx, s, '#ddd6c6');
    grain(ctx, s, 12);
    blobs(ctx, s, 30, 6, 20, ['rgba(180,170,150,0.16)'], 1);
    scratches(ctx, s, 18, 'rgba(150,140,120,0.35)', 0.6, 20);
}, { repeat: 2, rough: [0.75, 0.94], normalScale: 0.4 });

export const wallpaper = () => surface('wallpaper', (ctx, s) => {
    fill(ctx, s, '#cbb98f');
    ctx.strokeStyle = 'rgba(150,130,95,0.5)'; ctx.lineWidth = 2;
    for (let x = 0; x < s; x += 16) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, s); ctx.stroke(); }
    blobs(ctx, s, 60, 2, 5, ['rgba(170,150,110,0.4)'], 1);
    grain(ctx, s, 10);
}, { repeat: 2, rough: [0.8, 0.95], normalScale: 0.3 });

export const woodFloor = () => surface('woodFloor', (ctx, s) => {
    fill(ctx, s, '#8a6038');
    const planks = 8, h = s / planks;
    for (let i = 0; i < planks; i++) {
        const y = i * h;
        const base = ['#8a6038', '#7a5330', '#96693e', '#805a34'][(Math.random() * 4) | 0];
        ctx.fillStyle = base;
        ctx.fillRect(0, y, s, h - 1);
        // grain lines
        ctx.strokeStyle = 'rgba(60,38,20,0.35)'; ctx.lineWidth = 0.8;
        for (let g = 0; g < 7; g++) {
            const gy = y + Math.random() * h;
            ctx.beginPath();
            for (let x = 0; x <= s; x += 10) ctx.lineTo(x, gy + Math.sin(x * 0.05 + i) * 1.2);
            ctx.stroke();
        }
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(0, y + h - 1.5, s, 1.5);
        // plank end seam
        const sx = Math.random() * s;
        ctx.fillRect(sx, y, 1.5, h);
    }
    grain(ctx, s, 10);
}, { repeat: 4, rough: [0.42, 0.72], normalScale: 0.7, normalStrength: 2.5 });

export const carpet = () => surface('carpet', (ctx, s) => {
    fill(ctx, s, '#6b5a4a');
    grain(ctx, s, 24);
    blobs(ctx, s, 1200, 0.7, 1.8, ['#5d4d3f', '#7a6857', '#665545'], 0.8);
}, { repeat: 5, rough: [0.9, 1.0], normalScale: 0.5 });

export const tile = () => surface('tile', (ctx, s) => {
    fill(ctx, s, '#9a9a94');
    const n = 4, t = s / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        ctx.fillStyle = ['#d8d5cc', '#cfccc2', '#e0ddd4'][(Math.random() * 3) | 0];
        ctx.fillRect(x * t + 2, y * t + 2, t - 4, t - 4);
    }
    grain(ctx, s, 12);
}, { repeat: 3, rough: [0.25, 0.55], normalScale: 0.9, normalStrength: 3 });

export const wood = () => surface('wood', (ctx, s) => {
    fill(ctx, s, '#5a4030');
    ctx.strokeStyle = 'rgba(45,28,14,0.45)'; ctx.lineWidth = 1;
    for (let g = 0; g < 30; g++) {
        const gy = Math.random() * s;
        ctx.beginPath();
        for (let x = 0; x <= s; x += 8) ctx.lineTo(x, gy + Math.sin(x * 0.04) * 2);
        ctx.stroke();
    }
    grain(ctx, s, 16);
}, { repeat: 2, rough: [0.6, 0.88], normalScale: 0.6 });

export const whitePicket = () => surface('picket', (ctx, s) => {
    fill(ctx, s, '#eeeae0');
    grain(ctx, s, 10);
    scratches(ctx, s, 30, 'rgba(140,130,110,0.5)', 0.7, 20);
    blobs(ctx, s, 14, 3, 9, ['rgba(160,150,130,0.2)'], 1);
}, { repeat: 1, rough: [0.55, 0.82], normalScale: 0.4 });

// ============================================================================
// METALS / VEHICLES
// ============================================================================
export const paintedMetal = (key, color, rough = 0.35) => surface('paint_' + key, (ctx, s) => {
    fill(ctx, s, color);
    grain(ctx, s, 8);
    scratches(ctx, s, 30, 'rgba(255,255,255,0.25)', 0.5, 16);
    blobs(ctx, s, 12, 2, 7, ['rgba(0,0,0,0.10)'], 1);
}, { repeat: 2, rough: [rough, rough + 0.22], metalness: 0.55, normalScale: 0.25 });

export const rustyMetal = () => surface('rusty', (ctx, s) => {
    fill(ctx, s, '#6f6a63');
    blobs(ctx, s, 120, 2, 10, ['#7a4a28', '#8d5a30', '#5c4a3a'], 0.55);
    grain(ctx, s, 26);
    scratches(ctx, s, 50, 'rgba(30,25,20,0.5)', 1, 22);
}, { repeat: 3, rough: [0.6, 0.95], metalness: 0.6, normalScale: 0.7 });

// Slightly lighter than a "real" black rifle so the shapes read against a
// bright desert background, and rough enough that the key light does not blow
// the whole receiver out to white.
export const gunMetal = () => surface('gunmetal', (ctx, s) => {
    fill(ctx, s, '#43484c');
    grain(ctx, s, 12);
    // fine machining lines
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 0.6;
    for (let y = 0; y < s; y += 2) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke(); }
    scratches(ctx, s, 70, 'rgba(200,205,210,0.26)', 0.6, 14);
    blobs(ctx, s, 25, 2, 6, ['rgba(20,22,24,0.35)'], 1);
    // worn edges
    blobs(ctx, s, 14, 3, 8, ['rgba(180,186,192,0.18)'], 1);
}, { repeat: 1, rough: [0.34, 0.62], metalness: 0.80, normalScale: 0.45, envMapIntensity: 0.55 });

export const polymer = () => surface('polymer', (ctx, s) => {
    fill(ctx, s, '#2c2e30');
    grain(ctx, s, 10);
    // stippled polymer texture
    blobs(ctx, s, 2200, 0.5, 1.2, ['#222426', '#37393c'], 0.85);
    scratches(ctx, s, 20, 'rgba(160,165,170,0.16)', 0.5, 10);
}, { repeat: 1, rough: [0.62, 0.88], metalness: 0.04, normalScale: 0.8, normalStrength: 3, envMapIntensity: 0.4 });

export const rubber = () => surface('rubber', (ctx, s) => {
    fill(ctx, s, '#1a1a1c');
    grain(ctx, s, 14);
    blobs(ctx, s, 600, 0.6, 1.6, ['#131315', '#232326'], 0.8);
}, { repeat: 2, rough: [0.85, 1.0], normalScale: 0.5 });

export const tireTread = () => surface('tire', (ctx, s) => {
    fill(ctx, s, '#191a1c');
    ctx.fillStyle = '#0e0f10';
    for (let i = 0; i < 16; i++) ctx.fillRect(0, i * (s / 16), s, s / 32);
    for (let i = 0; i < 12; i++) ctx.fillRect(i * (s / 12), 0, s / 40, s);
    grain(ctx, s, 12);
}, { repeat: 2, rough: [0.88, 1.0], normalScale: 1.0, normalStrength: 3 });

// ============================================================================
// FABRIC / CHARACTERS
// ============================================================================
function camoDraw(palette) {
    return (ctx, s) => {
        fill(ctx, s, palette[0]);
        // multicam-style organic blotches, several layers
        for (let layer = 1; layer < palette.length; layer++) {
            ctx.fillStyle = palette[layer];
            for (let i = 0; i < 26; i++) {
                const cx = Math.random() * s, cy = Math.random() * s;
                ctx.beginPath();
                const pts = 7 + ((Math.random() * 4) | 0);
                for (let p = 0; p <= pts; p++) {
                    const a = (p / pts) * Math.PI * 2;
                    const r = (14 + Math.random() * 24) * (layer === 1 ? 1.15 : 0.8);
                    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.75;
                    p === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                }
                ctx.closePath(); ctx.fill();
            }
        }
        // fabric weave
        ctx.globalAlpha = 0.10;
        for (let y = 0; y < s; y += 2) { ctx.fillStyle = '#000'; ctx.fillRect(0, y, s, 1); }
        for (let x = 0; x < s; x += 2) { ctx.fillStyle = '#fff'; ctx.fillRect(x, 0, 1, s); }
        ctx.globalAlpha = 1;
        grain(ctx, s, 16);
    };
}

// Blue team — woodland / OD green
export const camoBlue = () => surface('camoA', camoDraw(['#4a5340', '#39412f', '#5d6a4c', '#2c3325', '#6b7355']),
    { repeat: 2, rough: [0.8, 0.98], normalScale: 0.5, normalStrength: 2 });
// Red team — arid / desert
export const camoRed = () => surface('camoB', camoDraw(['#8a7351', '#6f5b3e', '#a08a63', '#544530', '#b09873']),
    { repeat: 2, rough: [0.8, 0.98], normalScale: 0.5, normalStrength: 2 });

export const vestFabric = (key, color) => surface('vest_' + key, (ctx, s) => {
    fill(ctx, s, color);
    // cordura weave
    ctx.globalAlpha = 0.22;
    for (let y = 0; y < s; y += 3) { ctx.fillStyle = '#000'; ctx.fillRect(0, y, s, 1.4); }
    for (let x = 0; x < s; x += 3) { ctx.fillStyle = '#fff'; ctx.fillRect(x, 0, 1.4, s); }
    ctx.globalAlpha = 1;
    grain(ctx, s, 14);
    scratches(ctx, s, 20, 'rgba(0,0,0,0.3)', 0.6, 12);
}, { repeat: 2, rough: [0.78, 0.96], normalScale: 0.7, normalStrength: 3 });

export const skin = (tone) => surface('skin_' + tone, (ctx, s) => {
    fill(ctx, s, tone);
    grain(ctx, s, 9);
    blobs(ctx, s, 60, 1, 3, ['rgba(120,80,60,0.15)', 'rgba(255,220,200,0.15)'], 1);
}, { repeat: 1, rough: [0.6, 0.8], normalScale: 0.2 });

export const glove = () => surface('glove', (ctx, s) => {
    fill(ctx, s, '#2b2b2d');
    grain(ctx, s, 12);
    blobs(ctx, s, 900, 0.6, 1.5, ['#232325', '#343437'], 0.8);
    scratches(ctx, s, 25, 'rgba(150,150,155,0.2)', 0.5, 12);
}, { repeat: 1, rough: [0.62, 0.88], normalScale: 0.9, normalStrength: 3 });

export const bootLeather = () => surface('boot', (ctx, s) => {
    fill(ctx, s, '#2a231a');
    grain(ctx, s, 14);
    blobs(ctx, s, 500, 0.8, 2.2, ['#221c15', '#342b20'], 0.8);
    scratches(ctx, s, 30, 'rgba(140,120,90,0.25)', 0.7, 16);
}, { repeat: 1, rough: [0.6, 0.9], normalScale: 0.8, normalStrength: 3 });

export const mannequinPlastic = () => surface('mannequin', (ctx, s) => {
    fill(ctx, s, '#d9c3a4');
    grain(ctx, s, 8);
    blobs(ctx, s, 30, 4, 14, ['rgba(160,135,105,0.18)'], 1);
    scratches(ctx, s, 20, 'rgba(120,100,80,0.3)', 0.6, 18);
}, { repeat: 1, rough: [0.3, 0.55], normalScale: 0.25 });

// ============================================================================
// SPECIAL
// ============================================================================
/** Chain-link: alpha-cut diamond mesh. */
export const chainLink = () => {
    if (TEX_CACHE.has('chainlink')) return TEX_CACHE.get('chainlink');
    const s = 128;
    const c = mkCanvas(s);
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    ctx.strokeStyle = '#9aa0a4';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    const step = s / 4;
    for (let i = -4; i <= 8; i++) {
        ctx.beginPath(); ctx.moveTo(i * step, 0); ctx.lineTo(i * step + s, s); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(i * step, s); ctx.lineTo(i * step + s, 0); ctx.stroke();
    }
    const map = asTexture(c, 1);
    const mat = new THREE.MeshStandardMaterial({
        map, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide,
        metalness: 0.85, roughness: 0.42, color: 0xb9bec2
    });
    TEX_CACHE.set('chainlink', mat);
    return mat;
};

export const glass = () => {
    if (TEX_CACHE.has('glass')) return TEX_CACHE.get('glass');
    const m = new THREE.MeshPhysicalMaterial({
        color: 0xbcd6e0, metalness: 0.0, roughness: 0.06,
        transmission: 0.0, transparent: true, opacity: 0.28,
        envMapIntensity: 2.2, side: THREE.DoubleSide
    });
    TEX_CACHE.set('glass', m);
    return m;
};

export const glassDirty = () => {
    if (TEX_CACHE.has('glassD')) return TEX_CACHE.get('glassD');
    const s = 256, c = mkCanvas(s), ctx = c.getContext('2d');
    fill(ctx, s, '#9fb8c4');
    blobs(ctx, s, 60, 4, 18, ['rgba(220,225,225,0.25)', 'rgba(140,140,130,0.2)'], 1);
    scratches(ctx, s, 40, 'rgba(255,255,255,0.35)', 0.5, 24);
    const m = new THREE.MeshStandardMaterial({
        map: asTexture(c, 1), color: 0x4a5c66, transparent: true, opacity: 0.62,
        metalness: 0.55, roughness: 0.10, envMapIntensity: 1.1, side: THREE.DoubleSide
    });
    TEX_CACHE.set('glassD', m);
    return m;
};

export const emissiveMat = (color, intensity = 2) => {
    const key = 'emis_' + color + intensity;
    if (TEX_CACHE.has(key)) return TEX_CACHE.get(key);
    const m = new THREE.MeshStandardMaterial({
        color: 0x111111, emissive: new THREE.Color(color), emissiveIntensity: intensity, roughness: 0.4
    });
    TEX_CACHE.set(key, m);
    return m;
};

export const plain = (color, rough = 0.8, metal = 0.0) => {
    const key = `plain_${color}_${rough}_${metal}`;
    if (TEX_CACHE.has(key)) return TEX_CACHE.get(key);
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    TEX_CACHE.set(key, m);
    return m;
};

/** Text-on-a-panel material (signs, plates, screens). */
export function signMaterial(key, w, h, drawFn) {
    const cacheKey = 'sign_' + key;
    if (TEX_CACHE.has(cacheKey)) return TEX_CACHE.get(cacheKey);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    drawFn(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = 8;
    t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.62, metalness: 0.08 });
    TEX_CACHE.set(cacheKey, m);
    return m;
}

// ============================================================================
// PHOTOREAL UPGRADE
//
// The procedural surfaces above are the guaranteed baseline — the game is fully
// playable on them alone. If the photo texture set is present on disk we swap
// it onto the SAME cached material objects after the match is already running,
// so no other module needs to know this happened and a missing file costs
// nothing but a warning.
// ============================================================================
const PHOTO_SET = {
    asphalt:  { file: 'asphalt.jpg',       repeat: 7,  rough: [0.70, 0.98], normal: 0.85 },
    concrete: { file: 'concrete.jpg',      repeat: 4,  rough: [0.68, 0.94], normal: 0.60 },
    sidewalk: { file: 'concrete.jpg',      repeat: 6,  rough: [0.66, 0.92], normal: 0.70 },
    lawn:     { file: 'grass.jpg',         repeat: 16, rough: [0.88, 1.00], normal: 0.55 },
    sand:     { file: 'sand.jpg',          repeat: 34, rough: [0.90, 1.00], normal: 0.40 },
    dirt:     { file: 'sand.jpg',          repeat: 9,  rough: [0.90, 1.00], normal: 0.55 },
    sidingY:  { file: 'siding_yellow.jpg', repeat: 2,  rough: [0.58, 0.86], normal: 0.95 },
    sidingT:  { file: 'siding_teal.jpg',   repeat: 2,  rough: [0.58, 0.86], normal: 0.95 },
    sidingW:  { file: 'trim.jpg',          repeat: 2,  rough: [0.55, 0.82], normal: 0.70 },
    shingle:  { file: 'shingle.jpg',       repeat: 5,  rough: [0.80, 0.98], normal: 1.00 },
    brick:    { file: 'stone.jpg',         repeat: 3,  rough: [0.82, 0.98], normal: 1.00 },
    // interiors and trim
    plaster:  { file: 'plaster.jpg',       repeat: 2,  rough: [0.74, 0.94], normal: 0.45 },
    woodFloor:{ file: 'woodfloor.jpg',     repeat: 4,  rough: [0.42, 0.72], normal: 0.75 },
    wood:     { file: 'deck.jpg',          repeat: 2,  rough: [0.60, 0.88], normal: 0.80 },
    trim:     { file: 'trim.jpg',          repeat: 1,  rough: [0.45, 0.72], normal: 0.35 },
    picket:   { file: 'trim.jpg',          repeat: 1,  rough: [0.55, 0.82], normal: 0.45 },
    rusty:    { file: 'rust.jpg',          repeat: 3,  rough: [0.60, 0.95], normal: 0.85 }
};

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('load failed: ' + url));
        img.src = url;
    });
}

const nextTick = () => new Promise(r => requestAnimationFrame(() => r()));

/** Derivation runs at 512 — plenty for normals, and 4x cheaper than 1024. */
function downsample(img, size) {
    const c = mkCanvas(size);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    return c;
}

function applyPhoto(mat, img, cfg) {
    const old = { map: mat.map, normalMap: mat.normalMap, roughnessMap: mat.roughnessMap };

    // albedo straight from the decoded image — no canvas round-trip needed
    const albedo = new THREE.Texture(img);
    albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
    albedo.repeat.set(cfg.repeat, cfg.repeat);
    albedo.anisotropy = 8;
    albedo.colorSpace = THREE.SRGBColorSpace;
    albedo.needsUpdate = true;
    mat.map = albedo;

    const small = downsample(img, 512);
    const nrm = asTexture(normalFromCanvas(small, 2.2), cfg.repeat, false);
    const rgh = asTexture(roughFromCanvas(small, cfg.rough[0], cfg.rough[1]), cfg.repeat, false);
    mat.normalMap = nrm;
    if (mat.normalScale) mat.normalScale.set(cfg.normal, cfg.normal);
    else mat.normalScale = new THREE.Vector2(cfg.normal, cfg.normal);
    mat.roughnessMap = rgh;

    // the procedural maps baked colour in; the photo carries its own
    mat.color.setHex(0xffffff);
    mat.needsUpdate = true;

    old.map?.dispose();
    old.normalMap?.dispose();
    old.roughnessMap?.dispose();
}

let photoState = 'idle';
export function photoStatus() { return photoState; }

/**
 * Upgrade in the background, one texture per frame, so the swap never shows up
 * as a hitch. Safe to call before every material exists — missing keys are
 * simply skipped.
 */
export async function upgradeTextures(basePath = 'assets/textures/', onProgress) {
    if (photoState !== 'idle') return;
    photoState = 'loading';
    const keys = Object.keys(PHOTO_SET).filter(k => TEX_CACHE.has(k));
    let done = 0, ok = 0;
    for (const key of keys) {
        const cfg = PHOTO_SET[key];
        try {
            const img = await loadImage(basePath + cfg.file);
            applyPhoto(TEX_CACHE.get(key), img, cfg);
            ok++;
        } catch (err) {
            console.warn('[materials] keeping procedural texture for', key, '—', err.message);
        }
        done++;
        onProgress?.(done / keys.length);
        await nextTick();
    }
    photoState = ok > 0 ? 'ready' : 'unavailable';
    return ok;
}

export function disposeAll() {
    for (const m of TEX_CACHE.values()) {
        if (m.map) m.map.dispose();
        if (m.normalMap) m.normalMap.dispose();
        if (m.roughnessMap) m.roughnessMap.dispose();
        m.dispose?.();
    }
    TEX_CACHE.clear();
}
