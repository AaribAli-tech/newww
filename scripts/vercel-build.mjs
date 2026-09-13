// ============================================================================
// vercel-build.mjs — what Vercel runs instead of a real build.
//
// The deploy output in public/ is committed, so a Vercel build has exactly one
// job: prove the folder is complete before it goes live. That keeps a deploy to
// a copy — no npm install, no esbuild, nothing that can fail on their machines
// because it works on yours.
//
// Set the build command to `BUILD_ON_VERCEL=1 npm install --include=dev && npm run build`
// if you would rather have Vercel rebuild from src/ on every push.
// ============================================================================
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public');
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

async function stat(p) { try { return await fs.stat(p); } catch { return null; } }

// Optional CI-side build: only when asked for and when the toolchain is present.
if (process.env.BUILD_ON_VERCEL === '1') {
    let esbuild = false;
    try { await import('esbuild'); esbuild = true; } catch { /* deps not installed */ }
    if (esbuild) {
        log(' BUILD_ON_VERCEL=1 — rebuilding from src/');
        const { spawnSync } = await import('node:child_process');
        const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs'), '--force'],
            { stdio: 'inherit', cwd: ROOT });
        if (r.status !== 0) { log(' ! build failed'); process.exit(1); }
    } else {
        log(' BUILD_ON_VERCEL=1 but devDependencies are not installed — using the committed public/');
    }
}

// ── validate ────────────────────────────────────────────────────────────────
const problems = [];
const html = await stat(path.join(OUT, 'index.html'));
if (!html) problems.push('public/index.html is missing — run `npm run build` and commit the result');

let bundle = null;
let css = null;
if (html) {
    const text = await fs.readFile(path.join(OUT, 'index.html'), 'utf8');
    bundle = (text.match(/src="\/(js\/game\.[a-f0-9]+\.js)"/) || [])[1];
    css = (text.match(/href="\/(css\/styles\.[a-f0-9]+\.css)"/) || [])[1];
    if (!bundle) problems.push('index.html does not reference a bundled /js/game.<hash>.js');
    if (!css) problems.push('index.html does not reference a built /styles.<hash>.css');
    if (/@SITE_URL@|@@FONT_PRELOAD@@/.test(text)) problems.push('index.html still has unresolved build tokens');
    if (/cdn\.jsdelivr\.net/.test(text)) problems.push('index.html still loads three.js from a CDN');
    for (const ref of [bundle, css].filter(Boolean)) {
        if (!await stat(path.join(OUT, ref))) problems.push(`${ref} is referenced but not on disk`);
    }
}

for (const [dir, want] of [['assets/models', 12], ['assets/textures', 13]]) {
    const p = path.join(OUT, dir);
    const files = await fs.readdir(p).catch(() => null);
    if (!files) problems.push(`${dir}/ is missing`);
    else if (files.length < want) problems.push(`${dir}/ has ${files.length} files, expected ${want}`);
}
if (!await stat(path.join(OUT, 'sw.js'))) problems.push('public/sw.js is missing');

let bytes = 0;
let count = 0;
for (const dir of [OUT]) {
    const walk = async d => {
        for (const e of await fs.readdir(d, { withFileTypes: true })) {
            const f = path.join(d, e.name);
            if (e.isDirectory()) await walk(f);
            else { bytes += (await stat(f)).size; count++; }
        }
    };
    if (await stat(dir)) await walk(dir);
}

if (problems.length) {
    log('\n ! public/ does not look like a complete build:');
    for (const p of problems) log('   - ' + p);
    log('\n   Run `npm run build` locally and commit public/ before deploying.\n');
    process.exit(1);
}

log(` ✓ public/ is complete — ${count} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, deploying as-is`);
log('   (a static deploy: no install step, no bundling, no node runtime)');
