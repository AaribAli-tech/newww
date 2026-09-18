// ============================================================================
// serve.mjs — the preview/deploy stand-in for the old server.ps1.
//
// Serves public/ with the same content types, cache headers and brotli encoding
// that Vercel will apply, so what you measure on localhost is what a player gets.
// Bind is 0.0.0.0 so the same command works in a container or on a LAN.
//
//   node scripts/serve.mjs [port]        (default 8420, same as PLAY.bat)
// ============================================================================
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = process.env.SITE_DIR
    ? path.resolve(ROOT, process.env.SITE_DIR)      // a subfolder as its own site
    : path.join(ROOT, 'public');
const PORT = Number(process.argv[2] || process.env.PORT || 8420);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
    '.glb': 'model/gltf-binary',
    '.fbx': 'application/octet-stream',
    '.gltf': 'model/gltf+json',
    '.bin': 'application/octet-stream',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav'
};

// Mirrors vercel.json so the preview is an honest one.
function cacheFor(ext, rel) {
    if (rel === 'sw.js') return 'no-cache, no-store, must-revalidate';
    if (rel === 'index.html') return 'public, max-age=0, must-revalidate';
    if (rel === 'manifest.webmanifest') return 'public, max-age=3600, must-revalidate';
    if (ext === '.js' && /(^|\/)js\//.test(rel)) return 'public, max-age=31536000, immutable';
    if (ext === '.woff2') return 'public, max-age=31536000, immutable';
    if (ext === '.css') return 'public, max-age=31536000, immutable';
    return 'public, max-age=604800, stale-while-revalidate=86400';
}

// The same set Vercel encodes; media and meshopt buffers are left alone because
// re-compressing already-compressed bytes costs CPU and buys nothing.
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.map', '.txt']);
const cache = new Map();   // rel → { buf, ext, mtimeMs, br, gzip }

async function resolveFile(urlPath) {
    let rel = decodeURIComponent((urlPath || '/').split('?')[0].split('#')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';
    rel = rel.replace(/^\/+/, '');
    const full = path.join(SITE, rel);
    // refuse anything that climbs out of public/
    if (!full.startsWith(SITE + path.sep) && full !== SITE) return null;
    const st = await fs.stat(full).catch(() => null);
    if (st && st.isFile()) return { rel, full, size: st.size, mtimeMs: st.mtimeMs };
    // a folder serves its index.html, which is what Vercel does too — this is how
    // /tester/ (the model sandbox page) resolves.
    if (st && st.isDirectory()) {
        // Redirect, do not serve: a page with relative asset paths resolves them
        // against the URL it was reached at, so /tester must become /tester/.
        if (!rel.endsWith('/')) return { redirect: rel.replace(/\/+$/, '') + '/' };
        const idx = path.join(full, 'index.html');
        const st3 = await fs.stat(idx).catch(() => null);
        if (st3 && st3.isFile()) {
            return { rel: rel.replace(/\/+$/, '') + '/index.html', full: idx, size: st3.size, mtimeMs: st3.mtimeMs };
        }
    }
    // clean URLs: /foo → /foo.html
    if (!path.extname(rel)) {
        const alt = full + '.html';
        const st2 = await fs.stat(alt).catch(() => null);
        if (st2 && st2.isFile()) return { rel: rel + '.html', full: alt, size: st2.size, mtimeMs: st2.mtimeMs };
    }
    return null;
}

async function body(entry, ext, encoding) {
    const key = entry.rel;
    let rec = cache.get(key);
    if (!rec || rec.mtimeMs !== entry.mtimeMs) {
        const buf = await fs.readFile(entry.full);
        rec = { buf, ext, mtimeMs: entry.mtimeMs };
        if (COMPRESSIBLE.has(ext)) {
            try { rec.br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10 } }); } catch { /* optional */ }
            rec.gzip = zlib.gzipSync(buf, { level: 9 });
        }
        cache.set(key, rec);
    }
    if (encoding === 'br' && rec.br) return { buf: rec.br, encoding };
    if (encoding === 'gzip' && rec.gzip) return { buf: rec.gzip, encoding };
    return { buf: rec.buf, encoding: null };
}

const server = createServer(async (req, res) => {
    const t0 = Date.now();
    try {
        const entry = await resolveFile(req.url);
        if (entry && entry.redirect) {
            res.writeHead(301, { Location: entry.redirect, 'Cache-Control': 'no-store' });
            res.end();
            return;
        }
        if (!entry) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end('Not found\n');
            return;
        }
        const ext = path.extname(entry.full).toLowerCase();
        const accept = req.headers['accept-encoding'] || '';
        const encoding = accept.includes('br') ? 'br' : (accept.includes('gzip') ? 'gzip' : null);
        const small = entry.size < 1024;
        const out = await body(entry, ext, small ? null : encoding);

        const headers = {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': cacheFor(ext, entry.rel),
            'Vary': 'Accept-Encoding',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'strict-origin-when-cross-origin'
        };
        if (out.encoding) headers['Content-Encoding'] = out.encoding;
        headers['Content-Length'] = out.buf.length;
        if (entry.rel === 'sw.js') headers['Service-Worker-Allowed'] = '/';

        res.writeHead(200, headers);
        res.end(out.buf);
        const ms = Date.now() - t0;
        process.stdout.write(` ${req.method} /${entry.rel} → ${out.buf.length} B` +
            `${out.encoding ? ' (' + out.encoding + ')' : ''}${ms > 25 ? ' ⏳' + ms + 'ms' : ''}\n`);
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('server error: ' + err.message + '\n');
    }
});

server.listen(PORT, '0.0.0.0', () => {
    process.stdout.write(
        `\n   NUKETOWN — web build\n` +
        `   http://localhost:${PORT}/  (serving ${path.relative(ROOT, SITE)}/, brotli + Vercel cache headers)\n` +
        `   press ctrl-c to stop\n\n`
    );
});
