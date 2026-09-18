// ============================================================================
// build-tester.mjs — builds public/tester/, the little sandbox page used to try
// a character model on its own (move / crouch / jump / shoot) before it goes into
// the game. See src/tester/tester.js for why it exists.
//
//   node scripts/build-tester.mjs           # one-shot
//   npm run build                           # the game build calls this too
//
// The model files live in src/assets/rebel/ and are copied verbatim: an FBX is
// already smaller than the GLB the same mesh would export to at this poly count,
// and FBXLoader reads it in the browser, so there is nothing to convert.
// ============================================================================
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'public');
const SUB = 'tester';                                   // public/tester/
const MODEL_DIR = path.join(SRC, 'assets', 'rebel');
const log = (...a) => process.stdout.write(a.join(' ') + '\n');
const kb = n => (n / 1024).toFixed(0) + ' KB';
const sha = buf => createHash('sha256').update(buf).digest('hex').slice(0, 10);
const exists = async p => { try { await fs.stat(p); return true; } catch { return false; } };

async function write(rel, data) {
    const p = path.join(OUT, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
    return { file: rel, bytes: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data) };
}

export async function buildTester({ quiet = false } = {}) {
    const out = [];

    // The asset folder is a copy, not a merge: a renamed or dropped texture from an
    // earlier run would otherwise keep serving and hide the fact that it went away.
    const assetDir = path.join(OUT, SUB, 'assets');
    for (const f of await fs.readdir(assetDir).catch(() => [])) {
        await fs.rm(path.join(assetDir, f), { force: true });
    }

    // 1. the model and its textures
    // The FBX asks for BodyTexture.png / HeadTexture.png / BootsAndSkinTexture.png
    // (paths off the author's own disk), so the local copies keep those names: a
    // three.js loader will still request them, and they should not 404.
    const files = [
        ['rebel.fbx', 'rebel.fbx'],
        ['body.png', 'BodyTexture.png'],
        ['head.png', 'HeadTexture.png'],
        ['boots.png', 'BootsAndSkinTexture.png']
    ];
    let missing = 0;
    for (const [from, to] of files) {
        const p = path.join(MODEL_DIR, from);
        if (!await exists(p)) { missing++; continue; }
        out.push(await write(`${SUB}/assets/${to}`, await fs.readFile(p)));
    }
    if (missing && !quiet) log(`   ! ${missing} model file(s) missing in src/assets/rebel — the page will report it`);

    // 2. the script
    const esbuild = await import('esbuild');
    const res = await esbuild.build({
        entryPoints: [path.join(SRC, SUB, 'tester.js')],
        bundle: true, format: 'esm', target: ['es2022'], platform: 'browser',
        minify: true, legalComments: 'none', write: false, logLevel: 'warning'
    });
    const code = res.outputFiles[0].contents;
    const jsName = `${SUB}/js/tester.${sha(Buffer.from(code))}.js`;
    out.push(await write(jsName, code));

    // 3. the page, with the hashed script tag pointed at it
    let html = await fs.readFile(path.join(SRC, SUB, 'index.html'), 'utf8');
    // no leading slash: the same folder has to work under /tester/ and at the
    // root of a standalone server (see ASSET in tester.js)
    const local = jsName.replace(SUB + '/', '');
    html = html.replace('<!--TESTER_SCRIPT-->',
        `<link rel="modulepreload" href="${local}">\n<script type="module" src="${local}"></script>`);
    if (html.includes('<!--TESTER_SCRIPT-->')) throw new Error('no <!--TESTER_SCRIPT--> placeholder in src/tester/index.html');
    out.push(await write(`${SUB}/index.html`, html));

    // 4. drop previous hashes so the folder does not grow forever
    const jsDir = path.join(OUT, SUB, 'js');
    for (const f of await fs.readdir(jsDir).catch(() => [])) {
        if (/^tester\.[a-f0-9]{10}\.js$/.test(f) && `${SUB}/js/${f}` !== jsName) {
            await fs.rm(path.join(jsDir, f), { force: true });
        }
    }

    const bytes = out.reduce((a, x) => a + x.bytes, 0);
    if (!quiet) log(`   ${out.length} files → public/${SUB}/ (${kb(bytes)}) · ${jsName}`);
    return out;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('build-tester.mjs')) {
    const t0 = Date.now();
    log('\n NUKETOWN model tester');
    try {
        await buildTester();
        log(`\n built in ${((Date.now() - t0) / 1000).toFixed(1)}s → public/${SUB}/  (open /${SUB}/)\n`);
    } catch (err) {
        console.error('\n build failed:', err && err.message ? err.message : err, '\n');
        process.exit(1);
    }
}
