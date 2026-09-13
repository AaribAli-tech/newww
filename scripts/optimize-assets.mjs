// ============================================================================
// optimize-assets.mjs — turns the game's source assets into web-shaped ones.
//
// Two jobs, both cached in .cache/assets so a rebuild after a code change is
// near-instant:
//
//   textures/  1024² JPG photo plates  →  1024² WebP        (~40% smaller)
//   models/    uncompressed GLB         →  WebP textures inside, quantised
//                                          vertices, Meshopt-compressed
//                                          buffers            (~4x smaller)
//
// Nothing here is load-bearing for correctness. Every consumer of these assets
// already treats a missing or unreadable file as "keep the procedural model /
// the procedural texture", so a file the optimiser cannot process is copied
// through untouched and the game still plays the same.
//
//   node scripts/optimize-assets.mjs [--force] [--report]
// ============================================================================
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_ASSETS = path.join(ROOT, 'src', 'assets');
export const CACHE_ASSETS = path.join(ROOT, '.cache', 'assets');

const TEX_QUALITY = 74;       // photo plates: mozjpeg at this q is ~50% of the master and
                              // within a couple of dB of it on screens; and unlike WebP these
                              // noisy plates do not shrink when re-encoded to WebP
const GLB_TEX_QUALITY = 72;   // inside the models: never seen flat-on, so a touch lower
const MAX_TEX_SIZE = 1024;    // the plates are authored at 1024²; the cap guards a 4K drop-in

const log = (...a) => process.stdout.write(a.join(' ') + '\n');

// ── small fs helpers ────────────────────────────────────────────────────────
async function exists(p) { try { await fs.stat(p); return true; } catch { return false; } }
async function readJson(p) { return JSON.parse(await fs.readFile(p, 'utf8')); }
const hashOf = buf => createHash('sha256').update(buf).digest('hex').slice(0, 16);

async function copyThrough(src, dst) {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
}

/**
 * Run `work()` only when the input has changed since the last run.
 * The cache key is the sha256 of the source bytes, so touching a file without
 * editing it costs nothing and a real edit always busts the entry.
 */
async function cached(inFile, outFile, cache, work) {
    const bytes = await fs.readFile(inFile);
    const key = hashOf(bytes);
    const entry = cache[key];
    if (entry && entry.out === outFile && await exists(outFile)) {
        return { skipped: true, in: bytes.length, out: entry.size };
    }
    const result = await work(bytes);
    const size = (await fs.stat(result)).size;
    cache[key] = { out: outFile, size };
    return { skipped: false, in: bytes.length, out: size };
}

// ── textures ────────────────────────────────────────────────────────────────
async function optimizeTextures(inDir, outDir, cache, sharp) {
    const files = (await fs.readdir(inDir)).filter(f => /\.(jpe?g|png|webp)$/i.test(f)).sort();
    const rows = [];
    for (const f of files) {
        const inFile = path.join(inDir, f);
        const outName = f.replace(/\.(jpe?g|png)$/i, m => (m.toLowerCase() === '.png' ? '.jpg' : m));
        const outFile = path.join(outDir, outName);
        const r = await cached(inFile, outFile, cache, async () => {
            const img = sharp(inFile, { failOn: 'none' });
            const meta = await img.metadata();
            const w = Math.min(meta.width || MAX_TEX_SIZE, MAX_TEX_SIZE);
            const h = Math.min(meta.height || MAX_TEX_SIZE, MAX_TEX_SIZE);
            await fs.mkdir(outDir, { recursive: true });
            await img.rotate()
                .resize({ width: w, height: h, fit: 'inside' })
                .jpeg({ quality: TEX_QUALITY, mozjpeg: true, progressive: true })
                .toFile(outFile);
            return outFile;
        });
        rows.push({ name: outName, ...r });
    }
    return rows;
}

// ── models ──────────────────────────────────────────────────────────────────
// Files whose only payload is animation data are already tiny; running them
// through the quantiser would risk resampling keyframes for a few KB.
const SKIP_TRANSFORM = /^anim_/i;

async function optimizeModels(inDir, outDir, cache, opts) {
    const { NodeIO, Logger } = await import('@gltf-transform/core');
    const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
    const fn = await import('@gltf-transform/functions');
    const { MeshoptEncoder } = await import('meshoptimizer');
    const sharp = opts.sharp;

    const io = new NodeIO()
        .setLogger(new Logger(Logger.Verbosity.ERROR))
        .registerExtensions(ALL_EXTENSIONS).registerDependencies({
        'meshopt.encoder': MeshoptEncoder,
        'meshopt.decoder': (await import('meshoptimizer')).MeshoptDecoder
    });

    const files = (await fs.readdir(inDir)).filter(f => f.toLowerCase().endsWith('.glb')).sort();
    const rows = [];
    for (const f of files) {
        const inFile = path.join(inDir, f);
        const outFile = path.join(outDir, f);
        if (SKIP_TRANSFORM.test(f)) {
            const r = await cached(inFile, outFile, cache, async () => {
                await copyThrough(inFile, outFile);
                return outFile;
            });
            rows.push({ name: f, ...r, plain: true });
            continue;
        }
        let failed = null;
        const r = await cached(inFile, outFile, cache, async () => {
            await fs.mkdir(outDir, { recursive: true });
            try {
                const doc = await io.read(inFile);
                await doc.transform(
                    // duplicate meshes/materials/textures first, so the passes below
                    // have one copy of each thing to work on
                    fn.dedup(),
                    fn.prune({ keepAttributes: true, keepLeaves: true }),
                    // textures: re-encode to WebP, capped at 1024². Colours get
                    // 4:2:0 chroma, data maps (normal/roughness) stay 4:4:4 —
                    // gltf-transform picks that from the texture's colour space.
                    fn.textureCompress({
                        encoder: sharp,
                        targetFormat: 'jpeg',
                        resize: [MAX_TEX_SIZE, MAX_TEX_SIZE],
                        quality: GLB_TEX_QUALITY,
                        effort: 6
                    }),
                    // fuse split vertices (a hard-edged normal seam costs a vertex),
                    // then quantise + compress. Order matters: weld must come
                    // before meshopt or the index buffer cannot be optimised.
                    fn.weld(),
                    fn.meshopt({ level: 'high', encoder: MeshoptEncoder }),
                    fn.prune()
                );
                await io.write(outFile, doc);
            } catch (err) {
                failed = err;
                await copyThrough(inFile, outFile);   // ship the original, verbatim
            }
            return outFile;
        });
        if (failed) log(`   ! ${f}: ${failed.message} — shipped the original file instead`);
        rows.push({ name: f, ...r });
    }
    return rows;
}

// ── entry point ─────────────────────────────────────────────────────────────
export async function optimizeAssets({ force = false, quiet = false } = {}) {
    const sharp = (await import('sharp')).default;
    const texDir = path.join(SRC_ASSETS, 'textures');
    const mdlDir = path.join(SRC_ASSETS, 'models');
    const texOut = path.join(CACHE_ASSETS, 'textures');
    const mdlOut = path.join(CACHE_ASSETS, 'models');

    if (force) {
        await fs.rm(CACHE_ASSETS, { recursive: true, force: true });
        await fs.rm(path.join(ROOT, '.cache', 'asset-cache.json'), { force: true });
    }
    const cachePath = path.join(ROOT, '.cache', 'asset-cache.json');
    const cache = await exists(cachePath) ? await readJson(cachePath) : {};
    await fs.mkdir(path.dirname(cachePath), { recursive: true });

    const tex = await optimizeTextures(texDir, texOut, cache, sharp);
    const mdl = await optimizeModels(mdlDir, mdlOut, cache, { sharp });

    // the manifest and the loader's fallback file names must survive verbatim
    for (const f of ['manifest.json']) {
        const src = path.join(mdlDir, f);
        if (await exists(src)) await copyThrough(src, path.join(mdlOut, f));
    }
    await fs.writeFile(cachePath, JSON.stringify(cache, null, 1));

    const total = rows => rows.reduce((a, r) => ({ i: a.i + r.in, o: a.o + r.out }), { i: 0, o: 0 });
    const t = total(tex), m = total(mdl);
    const kb = n => (n / 1024).toFixed(0) + ' KB';

    if (!quiet) {
        for (const r of [...tex, ...mdl]) {
            if (!r) continue;
            log(`   ${r.name.padEnd(24)} ${kb(r.in).padStart(9)} → ${kb(r.out).padStart(9)}` +
                `${r.skipped ? '   (cached)' : ''}${r.plain ? '   (as-is)' : ''}`);
        }
        log(`\n   textures ${kb(t.i)} → ${kb(t.o)}   ·   models ${kb(m.i)} → ${kb(m.o)}`);
    }
    return {
        textures: { rows: tex, ...t },
        models: { rows: mdl, ...m },
        outDirs: { textures: texOut, models: mdlOut }
    };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const t0 = Date.now();
    await optimizeAssets({ force: process.argv.includes('--force') });
    log(`\n done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${path.relative(ROOT, CACHE_ASSETS)}`);
}
