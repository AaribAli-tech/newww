// ============================================================================
// make-deploy-zip.mjs — builds nuketown-vercel-deploy.zip, the folder someone
// can download, unzip and push straight at Vercel with two commands.
//
// What goes in: the built site (public/), the deploy config and validator, the
// source that can be played locally (src/js, src/index.html, src/fonts) and the
// scripts. What stays out: node_modules, .cache, and the 13 MB of asset masters
// under src/assets — the compressed copies in public/ are all a player needs, and
// leaving the masters out is what keeps this download at a few MB instead of 20.
//
//   npm run build && node scripts/make-deploy-zip.mjs [--name other-folder]
// ============================================================================
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

const argName = (flag, dflt) => {
    const i = process.argv.indexOf(flag);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const FOLDER = argName('--name', 'nuketown-vercel-deploy');
const STAGE = path.join(ROOT, '.cache', 'deploy-stage');
const OUT_ZIP = path.join(ROOT, `${FOLDER}.zip`);

const INCLUDE_DIRS = ['public', 'scripts', 'src/js', 'src/fonts'];
const INCLUDE_FILES = ['vercel.json', 'package.json', 'package-lock.json', 'README.md',
    'DEPLOY.txt', 'START.bat'];

async function exists(p) { try { await fs.stat(p); return true; } catch { return false; } }

async function stage() {
    await fs.rm(STAGE, { recursive: true, force: true });
    const target = path.join(STAGE, FOLDER);
    await fs.mkdir(target, { recursive: true });

    let files = 0, bytes = 0;
    const add = async (abs, rel) => {
        const dst = path.join(target, rel);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        const buf = await fs.readFile(abs);
        await fs.writeFile(dst, buf);
        files++; bytes += buf.length;
    };

    for (const rel of INCLUDE_FILES) {
        const abs = path.join(ROOT, rel);
        if (await exists(abs)) await add(abs, rel);
        else log(`   ! ${rel} is missing from the repo — leaving it out`);
    }
    for (const dir of INCLUDE_DIRS) {
        const abs = path.join(ROOT, dir);
        if (!await exists(abs)) { log(`   ! ${dir}/ missing — run npm run build first`); continue; }
        const walk = async d => {
            for (const e of await fs.readdir(d, { withFileTypes: true })) {
                const f = path.join(d, e.name);
                if (e.isDirectory()) await walk(f);
                else if (!/\.(map)$/.test(e.name)) await add(f, path.relative(ROOT, f));
            }
        };
        await walk(abs);
    }

    // a gitignore so if this folder ever gets committed to a repo it stays clean
    await fs.writeFile(path.join(target, '.gitignore'),
        '/node_modules/\n/.vercel/\n/.cache/\n*.log\n');
    return { files, bytes };
}

const { files, bytes } = await stage();

// A built index.html is the whole point of the package: refuse to ship without it.
const html = await fs.readFile(path.join(STAGE, FOLDER, 'public/index.html'), 'utf8').catch(() => null);
if (!html || !/\/js\/game\.[a-f0-9]+\.js/.test(html)) {
    log('\n public/index.html is missing or is not the built page.\n Run: npm run build\n');
    process.exit(1);
}

await fs.rm(OUT_ZIP, { force: true });
const zipped = (() => {
    if (spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0)
        return spawnSync('zip', ['-qr9', OUT_ZIP, FOLDER], { cwd: STAGE, stdio: 'inherit' });
    // python3's zipfile CLI is everywhere a zip tool is not
    const py = spawnSync('python3', ['-c', 'import zipfile,sys;print(1)'], { stdio: 'ignore' });
    if (py.status !== 0) return { status: 1 };
    return spawnSync('python3', ['-m', 'zipfile', 'c', OUT_ZIP, FOLDER],
        { cwd: STAGE, stdio: 'inherit' });
})();

if (zipped.status !== 0) {
    log('\n ! no zip tool found (tried `zip` and `python3 -m zipfile`).');
    log(`   The staged folder is ready to upload as-is: ${path.relative(ROOT, path.join(STAGE, FOLDER))}`);
    process.exit(1);
}

const size = (await fs.stat(OUT_ZIP)).size;
log(`\n ✓ ${path.basename(OUT_ZIP)} — ${files} files, ${(bytes / 1048576).toFixed(1)} MB staged, ` +
    `${(size / 1048576).toFixed(1)} MB zipped`);
log(`   unzip it, then:  npm i -g vercel && vercel --prod\n`);
