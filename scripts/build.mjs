// ============================================================================
// build.mjs — src/ + Call of Duty Build/ → public/, ready for Vercel.
//
// What it does, in order:
//   1. optimises the game's assets (textures, GLBs) — see optimize-assets.mjs
//   2. bundles the 21 ES modules and three.js into ONE hashed .js file, so the
//      browser makes a single request instead of 21, and the 3D engine is served
//      from the same CDN edge as everything else instead of a cold jsdelivr hop
//   3. folds the inline <style> plus the self-hosted font faces into ONE hashed
//      .css file, and preloads the two fonts the menu cannot paint without
//   4. writes icons, a web app manifest, an OG card and a service worker that
//      makes every visit after the first one a disk hit
//   5. prints a size report so regressions are visible
//
//   node scripts/build.mjs [--watch] [--force] [--no-minify] [--sourcemap]
//
// public/ is committed on purpose: Vercel then serves a static folder and does
// not need to install or build anything on deploy (see vercel.json).
// ============================================================================
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimizeAssets } from './optimize-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'public');
const CACHE = path.join(ROOT, '.cache', 'assets');

const argv = process.argv.slice(2);
const OPTS = {
    watch: argv.includes('--watch'),
    force: argv.includes('--force'),
    minify: !argv.includes('--no-minify'),
    sourcemap: argv.includes('--sourcemap')
};

const log = (...a) => process.stdout.write(a.join(' ') + '\n');
const kb = n => (n / 1024).toFixed(0) + ' KB';
const sha = buf => createHash('sha256').update(buf).digest('hex').slice(0, 10);

async function exists(p) { try { await fs.stat(p); return true; } catch { return false; } }
async function writeOut(rel, data) {
    const p = path.join(OUT, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, data);
    return { file: rel, bytes: Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data) };
}

// ── 0. clean previous output ────────────────────────────────────────────────
// Generated files only: an og.png or any extra media you dropped into public/
// survives a rebuild.
async function cleanOut() {
    const doomed = [];
    for (const dir of ['js', 'css', 'fonts', 'assets/models', 'assets/textures', 'icons']) {
        const d = path.join(OUT, dir);
        for (const f of await fs.readdir(d).catch(() => [])) doomed.push(path.join(d, f));
    }
    for (const f of await fs.readdir(OUT).catch(() => [])) {
        if (/^(styles\..*\.css|index\.html|sw\.js|manifest\.webmanifest|favicon\.svg|build-info\.json)$/.test(f)) {
            doomed.push(path.join(OUT, f));
        }
    }
    await Promise.all(doomed.map(f => fs.rm(f, { force: true })));
    return doomed.length;
}

// ── 1. assets ───────────────────────────────────────────────────────────────
async function copyAssets() {
    const written = [];
    for (const dir of ['textures', 'models']) {
        const from = path.join(CACHE, dir);
        if (!await exists(from)) continue;
        for (const f of (await fs.readdir(from)).sort()) {
            const data = await fs.readFile(path.join(from, f));
            written.push(await writeOut(`assets/${dir}/${f}`, data));
        }
    }
    return written;
}

// ── 2. javascript ───────────────────────────────────────────────────────────
async function bundleJS() {
    const esbuild = await import('esbuild');
    const result = await esbuild.build({
        entryPoints: [path.join(SRC, 'js', 'main.js')],
        bundle: true,
        format: 'esm',
        target: ['es2022'],
        platform: 'browser',
        minify: OPTS.minify,
        sourcemap: OPTS.sourcemap ? 'linked' : false,
        legalComments: 'none',
        // three.js resolves out of node_modules; the game's own modules stay
        // relative. Nothing is left external, so no import map is needed and a
        // deploy is self-contained.
        metafile: true,
        write: false,
        logLevel: 'warning'
    });
    const jsFile = result.outputFiles[0];
    let contents = jsFile.contents;
    const mapFile = result.outputFiles.find(f => f.path.endsWith('.map'));
    if (mapFile) await writeOut('js/game.map', mapFile.contents);

    const hash = sha(Buffer.from(contents));
    const name = `js/game.${hash}.js`;
    await writeOut(name, contents);
    const inputs = Object.keys(result.metafile.inputs).length;
    return { name, hash, bytes: contents.length, inputs };
}

// ── 3. css + fonts ──────────────────────────────────────────────────────────
async function buildCSS(html) {
    const fontDir = path.join(SRC, 'fonts');
    let fontCSS = await fs.readFile(path.join(fontDir, 'fonts.css'), 'utf8');

    // Each font is copied under its own hash so a returning player can keep it
    // for a year without revalidating.
    const hashed = new Map();
    const preloads = [];
    for (const f of (await fs.readdir(fontDir)).filter(x => x.endsWith('.woff2')).sort()) {
        const bytes = await fs.readFile(path.join(fontDir, f));
        const name = `fonts/${f.replace(/\.woff2$/, '')}.${sha(bytes)}.woff2`;
        await writeOut(name, bytes);
        hashed.set(f, name);
        fontCSS = fontCSS.split(`url('${f}')`).join(`url('/${name}')`);
        // the two faces the menu and HUD actually show first
        if (f === 'teko-700.woff2' || f === 'rajdhani-400.woff2') preloads.push(name);
    }
    fontCSS = fontCSS.replace(/url\('([^']+)'\)/g, (m, u) => (u.startsWith('/') ? m : 'url(\'' + u + '\')'));

    // lift the inline <style> block out of the HTML so it caches separately
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    const inlineCSS = styleMatch ? styleMatch[1] : '';
    if (!styleMatch) log('   ! no inline <style> block found; leaving the HTML alone');

    const css = fontCSS.trimEnd() + '\n\n' + inlineCSS.trim() + '\n';
    const hash = sha(Buffer.from(css));
    // under css/ so vercel.json can pin one unambiguous cache rule for it
    const name = `css/styles.${hash}.css`;
    await writeOut(name, css);
    return { name, hash, bytes: Buffer.byteLength(css), preloads, files: [...hashed.values()] };
}

// ── 4. html ─────────────────────────────────────────────────────────────────
async function buildHTML(html, js, css) {
    const siteUrl = process.env.PUBLIC_URL
        || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
        || '';

    let out = html;
    // the bundler resolved three.js already, so the import map must go — a
    // stray jsdelivr hop is pure latency once everything is same-origin
    out = out.replace(/<script type="importmap">[\s\S]*?<\/script>\s*/, '');
    out = out.replace(/<!--[\s\S]*?self-hosted[\s\S]*?-->\s*<link rel="stylesheet" href="fonts\.css">/, '');
    out = out.replace(/<link rel="stylesheet" href="fonts\.css">\s*/, '');
    // absolute, so the SW's precache list and the page agree on every URL
    out = out.replace(/href="(favicon\.svg|manifest\.webmanifest|icons\/[^"]*)"/g, 'href="/$1"');
    out = out.replace(/<style>[\s\S]*?<\/style>\s*/, '');
    out = out.replace(/<script type="module" src="js\/main\.js"><\/script>/,
        `<script type="module" src="/${js.name}"></script>`);

    const head = [
        `<link rel="stylesheet" href="/${css.name}">`,
        `<link rel="preload" as="script" crossorigin href="/${js.name}">`,
        ...css.preloads.map(f =>
            `<link rel="preload" as="font" type="font/woff2" crossorigin href="/${f}">`)
    ].join('\n');
    out = out.replace('<!-- @@FONT_PRELOAD@@ -->', head);
    out = out.replace(/@@SITE_URL@@/g, siteUrl);

    return await writeOut('index.html', out);
}

// ── 5. icons, manifest ──────────────────────────────────────────────────────
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="12" fill="#0a0d12"/>
<rect x="1" y="1" width="62" height="62" rx="11" fill="none" stroke="#FF7A18" stroke-opacity=".45"/>
<g fill="#FF7A18">
<circle cx="32" cy="32" r="6.5"/>
<path d="M32 8a24 24 0 0 1 20.8 12L37 26.5a6.5 6.5 0 0 0-5-3z"/>
<path d="M52.8 44A24 24 0 0 1 27 55.6l7.8-16.2a6.5 6.5 0 0 0 4.8 2.6z"/>
<path d="M11.2 44A24 24 0 0 1 11.2 20L27 26.5a6.5 6.5 0 0 0 0 11z"/>
</g>
</svg>`;

function manifestJSON() {
    return JSON.stringify({
        name: 'NUKETOWN — browser FPS',
        short_name: 'NUKETOWN',
        description: '5v5 Team Deathmatch and one-life Round Control in the browser.',
        start_url: '/',
        scope: '/',
        display: 'fullscreen',
        orientation: 'landscape',
        background_color: '#06080b',
        theme_color: '#06080b',
        categories: ['games', 'action'],
        icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
    }, null, 2) + '\n';
}

async function buildIcons() {
    const written = [];
    await writeOut('favicon.svg', FAVICON);
    written.push({ file: 'favicon.svg', bytes: Buffer.byteLength(FAVICON) });
    try {
        const sharp = (await import('sharp')).default;
        const buf = Buffer.from(FAVICON);
        for (const size of [192, 512, 180]) {
            const png = await sharp(buf, { density: 300 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
            const name = size === 180 ? 'icons/apple-touch-icon.png' : `icons/icon-${size}.png`;
            written.push(await writeOut(name, png));
        }
    } catch (err) {
        log('   ! icons skipped (sharp unavailable):', err.message);
    }
    written.push(await writeOut('manifest.webmanifest', manifestJSON()));
    return written;
}

// ── 6. service worker ───────────────────────────────────────────────────────
async function buildSW(files) {
    // Everything that makes the game playable, cached on first visit: a return
    // trip is a disk read, and the match stays enterable offline.
    const keep = [...new Set(files.filter(f =>
        /\.(js|css|woff2|glb|jpg)$/.test(f) && !f.startsWith('icons/')))];
    const precache = ['/'].concat(keep.map(f => '/' + f.replace(/^\.\//, '')));

    const sw = `/* NUKETOWN service worker — generated by scripts/build.mjs. Do not edit. */
const VERSION = '__VERSION__';
const RUNTIME = 'nuketown-' + VERSION;
const PRECACHE = ${JSON.stringify(precache, null, 2)};

self.addEventListener('install', event => {
  // 'default', not 'reload': the page has already pulled these bytes, so the
  // priming pass must read them out of the HTTP cache instead of paying for a
  // second download of the whole game.
  event.waitUntil((async () => {
    const cache = await caches.open(RUNTIME);
    await Promise.all(PRECACHE.map(url =>
      cache.add(new Request(url, { cache: 'default' })).catch(() => null)));
    // a missing optional file must not fail the install
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.indexOf('nuketown-') === 0 && key !== RUNTIME) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'NUKETOWN_SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // leave the CDN/fonts alone

  // Navigations: network first so a new deploy is never shadowed by the shell,
  // with the cached page as the offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const live = await fetch(req);
        const cache = await caches.open(RUNTIME);
        cache.put('/', live.clone());
        return live;
      } catch (err) {
        const cached = await caches.match('/');
        return cached || new Response('offline', { status: 503 });
      }
    })());
    return;
  }

  // Assets: cache first. They are content-hashed or version-pinned, so a hit is
  // always the right bytes.
  event.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const live = await fetch(req);
      if (live && live.status === 200) {
        const cache = await caches.open(RUNTIME);
        cache.put(req, live.clone());
      }
      return live;
    } catch (err) {
      return new Response('offline', { status: 503 });
    }
  })());
});
`;
    const version = sha(Buffer.from(precache.join('\n')));
    return await writeOut('sw.js', sw.replace('__VERSION__', version));
}

// ── 7. go ───────────────────────────────────────────────────────────────────
async function build() {
    const t0 = Date.now();
    log('\n NUKETOWN web build');
    log('────────────────────────────────────────────────────────────');

    const removed = await cleanOut();
    if (removed) log(`\n 0/5 cleaned ${removed} stale generated files`);

    log('\n 1/5 assets');
    await optimizeAssets({ force: OPTS.force, quiet: false });
    const assets = await copyAssets();

    log('\n 2/5 javascript');
    const js = await bundleJS();
    log(`   ${js.inputs} modules + three.js → ${js.name} (${kb(js.bytes)})`);

    log('\n 3/5 css + fonts');
    let html = await fs.readFile(path.join(SRC, 'index.html'), 'utf8');
    const css = await buildCSS(html);
    log(`   font faces + inline style → ${css.name} (${kb(css.bytes)})`);

    log('\n 4/5 html');
    const htmlOut = await buildHTML(html, js, css);
    html = null;
    log(`   index.html (${kb(htmlOut.bytes)})`);

    log('\n 5/5 shell extras');
    const extras = (await buildIcons()).concat(assets);
    const all = [js.name, css.name, ...css.files, htmlOut.file, ...extras.map(e => e.file)];
    const sw = await buildSW(all);
    const manifest = {
        version: sha(Buffer.from(all.join('\n'))),
        builtAt: new Date().toISOString(),
        files: [js.name, css.name, sw.file, ...extras.map(e => ({ file: e.file, bytes: e.bytes }))]
    };
    await writeOut('build-info.json', JSON.stringify(manifest, null, 2) + '\n');
    log(`   icons, manifest, sw.js (${kb(sw.bytes)}), build-info.json`);

    await report(js, css, assets, htmlOut, sw);
    log(`\n built in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${path.relative(ROOT, OUT)}/\n`);

    if (OPTS.watch) {
        log(' watching src/ for changes (ctrl-c to stop)');
        for (const dir of [path.join(SRC, 'js'), path.join(SRC, 'fonts')]) {
            fs.watch(dir, { persistent: true }, (_e, file) => {
                if (!file || !/\.(js|css)$/.test(file)) return;
                log(`\n ↻ ${file} changed`);
                build().catch(err => log('   ! ' + err.message));
            });
        }
    }
}

async function report(js, css, assets, htmlOut, sw) {
    let raw = js.bytes + css.bytes + htmlOut.bytes + sw.bytes + assets.reduce((a, x) => a + x.bytes, 0);
    let wire = raw;
    try {
        const zlib = await import('node:zlib');
        const brotli = f => zlib.brotliCompressSync(Buffer.from(f), {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
        }).length;
        const read = async f => await fs.readFile(path.join(OUT, f));
        // text gets brotli'd by Vercel; the media is already entropy-coded, so it
        // rides along at its file size
        wire = brotli(await read('index.html')) + brotli(await read(js.name)) +
            brotli(await read(css.name)) + brotli(await read(sw.file)) +
            assets.reduce((a, x) => a + x.bytes, 0);
    } catch { /* brotli is a report nicety only */ }
    log('\n────────────────────────────────────────────────────────────');
    log(` payload   ${kb(raw)} on disk`);
    log(`           ${kb(wire)} over the wire (brotli + already-compressed media)`);
}

build().catch(err => {
    log('\n BUILD FAILED\n ' + (err.stack || err.message));
    process.exitCode = 1;
});
