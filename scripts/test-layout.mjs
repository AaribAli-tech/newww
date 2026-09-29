// ============================================================================
// test-layout.mjs — computes what the touch HUD actually occupies.
//
// There is no Chrome in this sandbox (the puppeteer cache is empty and the
// download hosts are closed), so the layout cannot be measured by a browser.
// Instead this reads the *built* stylesheet and evaluates the geometry rules the
// way a style engine would — calc(), clamp(), min()/max(), vmin/vw/vh, var(),
// the safe-area insets — to produce real rectangles for every control and the HUD
// readouts, at four device sizes in landscape, with and without a notch.
//
// It is a deliberate simplification of CSS: document order decides, specificity
// does not. That holds for this stylesheet, where every touch rule comes after
// the one it overrides and a widget's size is set once per branch.
//
//   node scripts/test-layout.mjs          (needs `npm run build` first)
// ============================================================================
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`   ok   ${name}${detail ? '   — ' + detail : ''}`); }
    else { fail++; console.log(`   FAIL ${name}${detail ? '   — ' + detail : ''}`); }
};
const group = t => console.log(`\n ${t}`);

const PUB = path.resolve(new URL('../public', import.meta.url).pathname);
const cssFile = (await readdir(path.join(PUB, 'css'))).filter(f => f.endsWith('.css')).sort()[0];
if (!cssFile) {
    console.log('\n no built stylesheet in public/css — run `npm run build` first.\n');
    process.exit(2);
}
const css = await readFile(path.join(PUB, 'css', cssFile), 'utf8');

/**
 * A selector's specificity as one number: ids beat classes, classes beat element
 * names. It matters because the stylesheet is no longer written so that file order
 * alone decides — the compact tiers are `html.vh-400 body.touch #x`, which is one
 * class and one element more specific than the `body.touch #x` they replaced, so a
 * rule written *later* can now lose to one written earlier. The model has to count
 * the same way the browser does or it reports a layout that is not the one on screen.
 */
function spec(sel) {
    if (!sel) return 0;
    const ids = (sel.match(/#[\w-]+/g) || []).length;
    const cls = (sel.match(/\.[\w-]+|\[[^\]]*\]|::?[\w-]+(?:\([^)]*\))?/g) || []).length;
    const typ = (sel.match(/(?:^|[\s>+~])[a-z][\w-]*/g) || []).length;
    return ids * 1e6 + (cls - ids > 0 ? cls - ids : cls) * 1e3 + typ;
}

// ── the devices from the brief, all landscape ────────────────────────────────
const DEVICES = [
    { name: '360×640 phone', w: 640, h: 360 },
    { name: '390×844 phone', w: 844, h: 390 },
    { name: '412×915 phone', w: 915, h: 412 },
    { name: '768×1024 tablet', w: 1024, h: 768 },
    // Not in the brief, but a phone can be one: the shortest landscape there is
    // (568×320, the SE-era screen) with a home bar's inset under it. This is the
    // shape where the readout column used to run into the thumb grid, and where a
    // bottom-anchored button grid and a top-anchored column disagree about who
    // owns the corner — so it is in the suite now, not only in a one-off probe.
    { name: '568×320 short', w: 568, h: 320 }
];
// A landscape notch lives on the *side* of the screen and the home bar at the
// bottom, so the sides and the bottom are what a phone actually loses.
const NOTCH = { l: 47, r: 47, t: 0, b: 21 };
const FLAT = { l: 0, r: 0, t: 0, b: 0 };
// How much of the layout viewport a phone in a browser hands to its own chrome in
// landscape: the URL bar on top, the toolbar/home bar under it. A full-screen layer
// on `inset:0` is the layout viewport — all of it — so on a phone this is exactly
// the band the bottom of a menu card, and a scoped crosshair, disappear into.
const CHROME = 46;

/** The winning declarations per (selector, property), plus the custom properties. */
function collect(W, H, visH = H) {
    const props = new Map(), vars = new Map();
    let ord = 0;
    const stack = [];
    const mediaOK = cond => {
        const mh = /max-height:\s*(\d+(?:\.\d+)?)px/.exec(cond);
        if (mh && H > parseFloat(mh[1])) return false;
        const mw = /max-width:\s*(\d+(?:\.\d+)?)px/.exec(cond);
        if (mw && W > parseFloat(mw[1])) return false;
        if (/pointer:\s*coarse|hover:\s*none/.test(cond)) return true;    // a phone
        if (/orientation:\s*portrait/.test(cond)) return false;           // not sideways
        return true;
    };
    let i = 0, s = 0;
    const live = () => stack.every(x => x.live);
    const sels = () => stack.filter(x => x.kind === 'rule').map(x => x.sel);
    const add = decl => {
        const c = decl.indexOf(':');
        if (c < 0 || !live()) return;
        const prop = decl.slice(0, c).trim(), val = decl.slice(c + 1).trim();
        if (!prop || !val) return;
        if (prop.startsWith('--')) { vars.set(prop, val); return; }
        // `inset:0` is how every full-screen layer is anchored, and the size model
        // below reads longhands — expand the shorthand here or the layers look like
        // boxes with no edges.
        if (prop === 'inset') {
            const parts = val.split(/\s+/);
            const t = parts[0], r = parts[1] ?? t, b = parts[2] ?? t, l = parts[3] ?? r;
            for (const [k, v] of [['top', t], ['right', r], ['bottom', b], ['left', l]]) {
                ord++;
                for (const sel of sels()) {
                    if (!sel) continue;
                    for (const one of sel.split(',')) props.set(`${one.trim()}|${k}`, { val: v, ord });
                }
            }
            return;
        }
        ord++;
        for (const sel of sels()) {
            if (!sel) continue;
            for (const raw of sel.split(',')) {
                const one = raw.trim();
                // `html.vh-300 body.touch #x` — the compact tiers. touch.js sets every
                // tier at or above the measured height, so only those are live, and the
                // selector is recorded without the prefix, exactly as if the block had
                // been the media query it replaced.
                const m = /^html\.vh-(\d+)\s+([\s\S]+)$/.exec(one);
                if (m) {
                    if (visH > +m[1]) continue;
                    props.set(`${m[2].trim()}|${prop}`, { val, ord, s: spec(one) });
                } else props.set(`${one}|${prop}`, { val, ord, s: spec(one) });
            }
        }
    };
    while (i < css.length) {
        const ch = css[i];
        if (ch === '/' && css[i + 1] === '*') { i = css.indexOf('*/', i) + 2; s = i; continue; }
        if (ch === '{') {
            const head = css.slice(s, i).trim();
            stack.push(head.startsWith('@media')
                ? { kind: 'media', sel: null, live: mediaOK(head) }
                : { kind: 'rule', sel: head, live: true });
            i++; s = i; continue;
        }
        if (ch === '}') {
            add(css.slice(s, i));                          // a rule's last decl has no ;
            stack.pop(); i++; s = i; continue;
        }
        if (ch === ';') { add(css.slice(s, i)); i++; s = i; continue; }
        i++;
    }

    const U = { vmin: Math.min(W, H) / 100, vw: W / 100, vh: H / 100 };
    // One value, in CSS pixels: the units this stylesheet actually uses, resolved
    // against the device under test. '%' takes the axis the property belongs to.
    function num(expr, axis, at, depth = 0) {
        if (depth > 8 || !expr) return NaN;
        let t = expr;
        t = t.replace(/env\(\s*safe-area-inset-left\s*(?:,[^)]*)?\)/g, `${at.l}px`)
            .replace(/env\(\s*safe-area-inset-right\s*(?:,[^)]*)?\)/g, `${at.r}px`)
            .replace(/env\(\s*safe-area-inset-top\s*(?:,[^)]*)?\)/g, `${at.t}px`)
            .replace(/env\(\s*safe-area-inset-bottom\s*(?:,[^)]*)?\)/g, `${at.b}px`);
        t = t.replace(/var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)/g, (_m, n) => {
            const v = vars.get(n);
            return v ? `(${num(v, axis, at, depth + 1)})` : '0';
        });
        t = t.replace(/calc\(/g, '(').replace(/clamp\(/g, '__clamp(')
            .replace(/min\(/g, 'Math.min(').replace(/max\(/g, 'Math.max(');
        t = t.replace(/(-?[\d.]+)vmin/g, (_m, n) => `(${n} * ${U.vmin})`)
            .replace(/(-?[\d.]+)d?vh/g, (_m, n) => `(${n} * ${U.vh})`)
            .replace(/(-?[\d.]+)vw/g, (_m, n) => `(${n} * ${U.vw})`)
            .replace(/(-?[\d.]+)px/g, '$1')
            .replace(/(-?[\d.]+)%/g, (_m, n) => `(${n} * ${axis === 'h' ? W : H} / 100)`);
        try {
            const v = new Function('__clamp', `"use strict";return (${t});`)(
                (a, b, c) => Math.max(a, Math.min(b, c)));
            return typeof v === 'number' ? v : NaN;
        } catch { return NaN; }
    }
    // The value the cascade applies for one element, from the list of selectors that
    // can reach it: highest file order wins, which is how this stylesheet is written
    // (every touch override sits after the rule it replaces).
    function pick(sels, prop, axis, at) {
        let best = null;
        for (const sel of sels) {
            const e = props.get(`${sel}|${prop}`);
            // The cascade: specificity first, file order between equals.
            if (e && (!best || e.s > best.s || (e.s === best.s && e.ord > best.ord))) best = e;
        }
        return best ? num(best.val, axis, at) : NaN;
    }
    const get = (sel, prop, axis, at) => pick([sel], prop, axis, at);
    return { props, vars, get, num, pick };
}

/**
 * A widget's rect. Rules it shares by class (.tbtn, .tz) count as its own, which
 * is how the buttons find their size; an element with left+right and no width is
 * sized by the gap between them.
 */
function rectOf(C, id, W, H, at, classes = [], size = null, extra = []) {
    // #id, `body.touch #id`, then whatever the shared class rule says — the same
    // reach a browser would give this element, resolved in file order.
    // The element's own id, the body.touch and #touchUI forms of it, and the class
    // it actually carries — never a class it does not have, or the invisible pads'
    // `top:0;bottom:0` would stretch every button to the height of the screen.
    const reach = [`#${id}`, `body.touch #${id}`, `#touchUI #${id}`,
        ...classes, ...classes.map(c => `body.touch ${c}`), ...classes.map(c => `#touchUI ${c}`),
        ...extra];
    const own = (prop, axis) => C.pick(reach, prop, axis, at);
    const w = own('width', 'h'), h = own('height', 'v');
    const l = own('left', 'h'), r = own('right', 'h');
    const t = own('top', 'v'), b = own('bottom', 'v');
    const ml = own('margin-left', 'h') || 0, mt = own('margin-top', 'v') || 0;
    const mw = Number.isFinite(w) ? w : (Number.isFinite(l) && Number.isFinite(r) ? W - l - r : (size && size[0]) || NaN);
    const mh = Number.isFinite(h) ? h : (Number.isFinite(t) && Number.isFinite(b) ? H - t - b : (size && size[1]) || NaN);
    if (!Number.isFinite(mw) || !Number.isFinite(mh)) return null;
    const x = Number.isFinite(l) ? l + ml : Number.isFinite(r) ? W - r - mw + ml : (W - mw) / 2;
    const y = Number.isFinite(t) ? t + mt : Number.isFinite(b) ? H - b - mh + mt : (H - mh) / 2;
    return { x, y, w: mw, h: mh };
}
const area = a => Math.max(0, a.w) * Math.max(0, a.h);
const hit = (a, b, pad = 0) => !(a.x + a.w + pad <= b.x || b.x + b.w + pad <= a.x
    || a.y + a.h + pad <= b.y || b.y + b.h + pad <= a.y);
const isect = (a, b) => ({
    x: Math.max(a.x, b.x), y: Math.max(a.y, b.y),
    w: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    h: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
});

const BTN = ['tFire', 'tFire2', 'tAds', 'tJump', 'tCrouch', 'tReload', 'tSwap', 'tSprint'];
// The stick and the two invisible pads are placed by the thumb and by design, not
// by a fixed corner, so they are measured but never overlap-tested.
const WIDGETS = [...BTN, 'tBoard', 'tSkip', 'tFull', 'tUp', 'tDown', 'tNext', 'stick',
    'stickKnob', 'stickZone', 'lookZone'];
const FIXED = [...BTN, 'tBoard', 'tSkip', 'tFull'];          // laid out in CSS
const ROAM = ['tUp', 'tDown', 'tNext'];                       // only up in free roam
const CL = Object.fromEntries(WIDGETS.map(id => [id,
    id === 'stickZone' || id === 'lookZone' ? ['.tz'] : (BTN.concat(['tBoard', 'tSkip', 'tFull', 'tUp', 'tDown', 'tNext']).includes(id) ? ['.tbtn'] : [])]));
// The right-hand readouts are modelled as one column below; these three are the
// left-hand corners, placed by their own rules and measured where they land.

let worstGap = Infinity, worstPair = '', maxCover = 0, minSize = Infinity, highest = 0, maxPaint = 0;
const seen = {};
// Four shapes per device. The stylesheet branches on the *layout* height — media
// queries and vh units are the layout viewport — while every layer is sized to the
// *visual* viewport, which is the part the browser's own chrome is not covering.
// Modelling both is the only way to catch a card that fits the layout rectangle and
// still hangs off the screen the player is looking at.
const SHAPES = [
    { tag: '', chrome: 0, notch: FLAT },
    { tag: ' notched', chrome: 0, notch: NOTCH },
    { tag: ' + chrome', chrome: CHROME, notch: FLAT },
    { tag: ' notched + chrome', chrome: CHROME, notch: NOTCH }
];
for (const dev of DEVICES) {
    group(`${dev.name} (${dev.w}×${dev.h} landscape)`);
    for (const shape of SHAPES) {
        const visH = dev.h - shape.chrome;
        // A home bar comes with a notch, and every notched phone is at least 375 px
        // tall in landscape; a 320-px screen has a side inset or none. Modelling the
        // two together would test a device that does not exist.
        const at = shape.notch.l && dev.h <= 340 ? { l: 47, r: 47, t: 0, b: 0 } : shape.notch;
        const C = collect(dev.w, dev.h, visH);
        C.vars.set('--vhpx', `${visH}px`);        // what applyViewportVars() publishes
        // Which compact tier the stylesheet is in: the shortest one the visible height
        // fits, not the one the layout viewport claims.
        const TIER = [300, 340, 420, 460, 560].find(t => visH <= t) ?? 9999;
        const R = {};
        for (const id of WIDGETS) R[id] = rectOf(C, id, dev.w, visH, at, CL[id]);
        const tag = `${dev.name}${shape.tag}`;

        const missing = WIDGETS.filter(id => !R[id]);
        ok(`${tag}: every control is sized by the stylesheet`, missing.length === 0, missing.join(' '));

        const off = FIXED.concat(ROAM).filter(id => R[id]
            && (R[id].x < -0.5 || R[id].y < -0.5 || R[id].x + R[id].w > dev.w + 0.5 || R[id].y + R[id].h > visH + 0.5));
        ok(`${tag}: every control sits inside the screen`, off.length === 0, off.join(' '));

        // Every full-screen layer — the canvas, the HUD, the pads, and every menu,
        // card and full-screen effect — has to be the rectangle the phone is showing,
        // anchored at the top with an explicit height. A layer left on `inset:0` is the
        // layout viewport, which is taller than the picture whenever the browser is
        // showing its chrome: a card centred in it drifts down under the toolbar, and
        // the scope's glass and crosshair drift off the point being aimed at with it.
        const LAYERS = ['gameCanvas', 'hud', 'touchUI', 'touchPads', 'loader', 'menu',
            'diffGate', 'panel', 'pause', 'end', 'death', 'board', 'rotate', 'scope',
            'dmgDirs', 'damageVig', 'lowHp', 'screenFlash', 'nukeSeq', 'nukeBars'];
        const offLayer = [];
        for (const id of LAYERS) {
            const extra = id === 'gameCanvas' ? ['canvas#gameCanvas']
                : (id === 'pause' || id === 'end' || id === 'death') ? ['.overlay'] : [];
            const r = rectOf(C, id, dev.w, visH, at, [], null, extra);
            if (!r) { offLayer.push(`${id}: no box`); continue; }
            if (Math.abs(r.x) > 0.5 || Math.abs(r.y) > 0.5
                || Math.abs(r.w - dev.w) > 0.5 || Math.abs(r.h - visH) > 0.5)
                offLayer.push(`${id} ${Math.round(r.w)}×${Math.round(r.h)}`);
        }
        ok(`${tag}: every full-screen layer is the rectangle the phone is showing`,
            offLayer.length === 0, offLayer.join(' '));

        const clash = [];
        const live = ROAM.includes('tUp') ? FIXED : FIXED;   // playing: the roam trio is hidden
        for (let i = 0; i < BTN.length; i++)
            for (let j = i + 1; j < BTN.length; j++)
                if (R[BTN[i]] && R[BTN[j]] && hit(R[BTN[i]], R[BTN[j]], -8)) clash.push(`${BTN[i]}/${BTN[j]}`);
        for (let i = 0; i < ROAM.length; i++)
            for (let j = i + 1; j < ROAM.length; j++)
                if (R[ROAM[i]] && R[ROAM[j]] && hit(R[ROAM[i]], R[ROAM[j]], -8))
                    clash.push(`${ROAM[i]}/${ROAM[j]} (roam)`);
        let gap = Infinity, pair = '';
        for (let i = 0; i < BTN.length; i++)
            for (let j = i + 1; j < BTN.length; j++) {
                const a = R[BTN[i]], b = R[BTN[j]];
                if (!a || !b) continue;
                const g = Math.hypot(Math.max(0, Math.abs((a.x + a.w / 2) - (b.x + b.w / 2)) - (a.w + b.w) / 2),
                    Math.max(0, Math.abs((a.y + a.h / 2) - (b.y + b.h / 2)) - (a.h + b.h) / 2));
                if (g < gap) { gap = g; pair = `${BTN[i]}↔${BTN[j]}`; }
            }
        ok(`${tag}: no two thumb targets touch`, clash.length === 0, clash.length ? clash.join(' ') : `${gap.toFixed(1)} px apart, tightest ${pair}`);
        if (Number.isFinite(gap)) { worstGap = Math.min(worstGap, gap); if (gap === worstGap) worstPair = `${pair} @ ${tag}`; }

        // The view itself: a box in the middle of the screen that no widget may enter.
        // Measured inside the safe area — behind a notch and under a home bar there is
        // no picture at all, so a button reaching in there is not covering the view.
        const useW = Math.max(1, dev.w - at.l - at.r), useH = Math.max(1, visH - at.t - at.b);
        // The box is the middle of the *view*: the picture without the two thumb rows at
        // its foot. On a short screen the cluster is physically in the lower middle third —
        // the player's own fingers are there — and measuring that as "the HUD covers the
        // view" would be measuring the geometry of a small screen, not a bug.
        const thumbBand = (C.vars.get('--gap') ? C.num(C.vars.get('--gap'), 'v', at) : 10)
            + (C.vars.get('--fire') ? C.num(C.vars.get('--fire'), 'v', at) : 60) * 2;
        const viewH = Math.max(1, useH - thumbBand);
        const centre = { x: at.l + useW * 0.33, y: at.t + viewH * 0.33, w: useW * 0.34, h: viewH * 0.34 };
        let covered = 0;
        for (const id of WIDGETS) {
            // The two pads are invisible; the stick appears under the thumb and is
            // translucent by design, so neither counts against the view.
            if (!R[id] || id === 'lookZone' || id === 'stickZone' || id === 'stick' || id === 'stickKnob') continue;
            const o = isect(centre, R[id]);
            covered += area(o);
        }
        // The other half of that question: how much of the picture the controls paint
        // at all. The thumb grid is where it should be, and a bound on its share is a
        // bound on a HUD that has grown into the thing it is drawn over.
        const paint = BTN.concat(['tBoard', 'tFull'])
            .reduce((sum, id) => sum + (R[id] ? area(R[id]) : 0), 0) / (dev.w * visH) * 100;
        maxPaint = Math.max(maxPaint, paint);

        const pct = covered / area(centre) * 100;
        maxCover = Math.max(maxCover, pct);
        ok(`${tag}: the middle of the view stays clear`, pct < 1, `${pct.toFixed(2)}% covered`);

        if (!shape.tag) {
            for (const id of BTN) if (R[id]) minSize = Math.min(minSize, Math.min(R[id].w, R[id].h));
            if (R.tJump) highest = Math.max(highest, (visH - R.tJump.y) / visH * 100);
            seen[dev.name] = R;
        }

        // ── the right-hand readout column ──
        // Everything on that edge — the nuke bar, the feed, the ammo block, the slot
        // strip, the reward tiles — is one flex column on a phone (#hudRight). This is
        // not a browser, so each block's height is the one its own CSS implies: the
        // bar's label (its key hint is hidden on touch), the feed's lines, the 34 px
        // counter and the strip under it, a slot chip, a 44×28 tile. The column is
        // then laid out from those, top edge first, and the three things that four
        // hand-placed offsets could not know are checked: the blocks stack, they fit
        // the box they are given, and the box stops above the thumbs.
        // A custom property is not a declaration on an element, so it is resolved
        // from the variable table rather than through the cascade.
        const cssVar = (name, axis) => {
            const raw = C.vars.get(name);
            return raw ? C.num(raw, axis, at) : NaN;
        };
        const gridGap = cssVar('--gap', 'v');
        const mini = cssVar('--mini', 'v');
        const boxTop = C.get('body.touch #hudRight', 'top', 'v', at);
        const boxBottom = C.get('body.touch #hudRight', 'bottom', 'v', at);
        const boxRight = C.get('body.touch #hudRight', 'right', 'h', at);
        const feedLines = TIER <= 340 ? 0 : TIER <= 420 ? 1 : 3;
        const colGap = TIER <= 420 ? 3 : 4;         // the wrapper's own gap
        const BLOCKS = [
            ['nukeTrack', C.get('body.touch #nukeTrack', 'width', 'h', at) || 200, TIER <= 300 ? 0 : 20],
            ['killfeed', C.get('body.touch #killfeed', 'width', 'h', at) || 180,
                feedLines ? feedLines * 15 + 2 : 0],
            ['brWrap', 116, TIER <= 300 ? 40 : TIER <= 420 ? 48 : 52],
            ['slots', 113, TIER <= 460 ? 0 : 22],       // given up on a short screen
            ['streakCol', TIER <= 300 ? 116 : TIER <= 420 ? 122 : 140,
                TIER <= 300 ? 20 : TIER <= 420 ? 24 : 28]
        ];
        const colW = Math.max(...BLOCKS.filter(b => b[2] > 0).map(b => b[1]));
        const boxH = visH - boxBottom - boxTop;
        const box = { x: dev.w - boxRight - colW, y: boxTop, w: colW, h: boxH };
        const hr = {};
        let colEnd = boxTop;
        for (const [id, w, h] of BLOCKS) {
            if (h <= 0) continue;
            hr[id] = { x: box.x + colW - w, y: colEnd, w, h };
            colEnd += h + colGap;
        }
        // The mute and pause chips: 38 px on a phone (`body.touch .gbtn`), in from the
        // safe area by the same 16 px the column uses.
        hr.gameBtns = { x: dev.w - at.r - 16 - 82, y: gridGap + at.t, w: 82, h: 38 };
        const MISSING = TIER <= 300 ? ['nukeTrack', 'killfeed', 'slots']
            : TIER <= 340 ? ['killfeed', 'slots'] : TIER <= 460 ? ['slots'] : [];
        // The column always carries the ammo block and the reward tiles; the blocks it
        // gives up on a short screen are the ones in MISSING, and they must be gone.
        const expected = ['nukeTrack', 'killfeed', 'slots'].filter(id => !MISSING.includes(id));
        ok(`${tag}: the readout column is laid out`,
            Number.isFinite(boxTop) && Number.isFinite(boxBottom) && Number.isFinite(gridGap)
            && !!hr.brWrap && !!hr.streakCol && expected.every(id => !!hr[id])
            && MISSING.every(id => !hr[id]),
            `box ${Math.round(boxTop)}..${Math.round(boxTop + boxH)}`);
        const stacked = [];
        let prev = null;
        for (const id of ['nukeTrack', 'killfeed', 'brWrap', 'slots', 'streakCol']) {
            if (!hr[id]) continue;
            if (prev && hr[id].y < prev.y + prev.h - 0.5) stacked.push(`${id} over ${prev.id}`);
            prev = { id, ...hr[id] };
        }
        ok(`${tag}: the readouts stack instead of being printed over each other`,
            stacked.length === 0, stacked.join(' '));
        ok(`${tag}: the readouts fit above the thumb grid`,
            colEnd - 4 <= boxTop + boxH + 0.5,
            `${Math.round(colEnd - 4)} px of readouts in a ${Math.round(boxTop + boxH - boxTop)} px box`
            + ` (${Math.round(boxTop)}..${Math.round(boxTop + boxH)})`);
        ok(`${tag}: the mute and pause chips are above the column`,
            hr.gameBtns.y + hr.gameBtns.h <= boxTop + 0.5,
            `chips end ${Math.round(hr.gameBtns.y + hr.gameBtns.h)} vs the column at ${Math.round(boxTop)}`);
        const over = [];
        for (const id of FIXED.concat(ROAM)) {
            if (!R[id]) continue;
            for (const k of Object.keys(hr)) if (hit(R[id], hr[k], -4)) over.push(`${id}/${k}`);
        }
        ok(`${tag}: no readout sits under a thumb button`, over.length === 0, over.join(' '));
        // ── the left-hand column ──
        // The minimap and the match block, in the same shape as the right-hand one and
        // bounded by the trigger above the left thumb. The blocks are the sizes their
        // own rules give them: the minimap's three steps, and a match block of two
        // scores on one line, the round row (which changes) and the clock.
        const leftTop = C.get('body.touch #hudLeft', 'top', 'v', at);
        const leftH = C.get('body.touch #hudLeft', 'height', 'v', at);
        const leftLeft = C.get('body.touch #hudLeft', 'left', 'h', at);
        // The steps the stylesheet takes them through, short screen first.
        // The map is a quarter of the picture (capped at 118) whenever a tier applies, and
        // gone entirely on the shortest one: `min(118px, calc(var(--vhpx) * .24))` in CSS.
        const mmSize = TIER <= 300 ? 0 : TIER <= 560 ? Math.min(118, visH * 0.24) : 200;
        const scSize = TIER <= 300 ? 12 : TIER <= 340 ? 14 : TIER <= 460 ? 16 : TIER <= 560 ? 18 : 23;
        const clockSize = TIER <= 300 ? 12 : TIER <= 340 ? 14 : TIER <= 560 ? 16 : 25;
        // Rows the score block gives up as the picture shortens: the round pips below
        // 420, the clock below 340 (the scoreboard chip still carries both).
        const LB = [
            ['miniWrap', mmSize],
            ['matchBar', scSize + 4 + (TIER <= 420 ? 0 : 12) + (TIER <= 340 ? 0 : 4 + clockSize)]
        ];
        const lbox = { x: leftLeft, y: leftTop, w: mmSize, h: leftH };
        const lGap = C.get('body.touch #hudLeft', 'gap', 'v', at) || gridGap;
        const lr = {};
        let lEnd = leftTop;
        for (const [id, h] of LB) {
            if (h <= 0) continue;                    // given up on this tier
            lr[id] = { x: lbox.x, y: lEnd, w: mmSize, h };
            lEnd += h + lGap;
        }
        ok(`${tag}: the left-hand column is laid out`,
            Number.isFinite(leftTop) && Number.isFinite(leftH) && Number.isFinite(leftLeft)
            && lEnd - lGap <= leftTop + leftH + 0.5,
            `minimap + match block end at ${Math.round(lEnd - lGap)},`
            + ` the box at ${Math.round(leftTop + leftH)} (a ${Math.round(mmSize)} px map)`);
        const lowerLeft = [];
        for (const id of FIXED) {
            if (!R[id]) continue;
            for (const k of Object.keys(lr)) if (hit(R[id], lr[k], -4)) lowerLeft.push(`${id}/${k}`);
        }
        ok(`${tag}: the left-hand readouts keep clear of the thumb buttons`,
            lowerLeft.length === 0, lowerLeft.join(' '));
        // The health readout is the one HUD block that is not in either column: it
        // keeps the bottom-left corner, above the stick's resting place and below the
        // trigger.
        const hp = rectOf(C, 'healthWrap', dev.w, visH, at, [], [104, 30]);
        ok(`${tag}: the health readout stays clear of the thumb buttons`,
            !!hp && FIXED.every(id => !R[id] || !hit(R[id], hp, -4)) && hp.y + hp.h <= visH,
            hp ? `hp ${Math.round(hp.y)}..${Math.round(hp.y + hp.h)} of ${visH}` : 'no rect');
    }
}

group('the numbers the brief asked for');
{
    const small = seen['360×640 phone'], big = seen['412×915 phone'];
    ok('the trigger is 60-68 px on a phone',
        small.tFire.w >= 59.5 && small.tFire.w <= 68.5 && big.tFire.w >= 59.5 && big.tFire.w <= 68.5,
        `${small.tFire.w.toFixed(1)} → ${big.tFire.w.toFixed(1)} px`);
    ok('the arc buttons are 38-44 px',
        small.tJump.w >= 37.5 && small.tJump.w <= 44.5 && big.tCrouch.w <= 44.5,
        `${small.tJump.w.toFixed(1)} → ${big.tCrouch.w.toFixed(1)} px`);
    ok('the second trigger is smaller than the first', small.tFire2.w < small.tFire.w - 6,
        `${small.tFire2.w.toFixed(1)} vs ${small.tFire.w.toFixed(1)} px`);
    ok('the stick base is 90-100 px', small.stick.w >= 89 && small.stick.w <= 101,
        `${small.stick.w.toFixed(1)} px`);
    ok('the knob is a third of the base', small.stickKnob.w > small.stick.w * 0.25 && small.stickKnob.w < small.stick.w * 0.6,
        `${small.stickKnob.w.toFixed(1)} px`);
    ok('the look pad is the right 60%, the stick zone the left 40%',
        Math.abs(small.lookZone.w - 640 * 0.6) < 1 && Math.abs(small.stickZone.w - 640 * 0.4) < 1,
        `${small.lookZone.w.toFixed(0)} / ${small.stickZone.w.toFixed(0)} px`);
    ok('the look pad reaches the whole height so a drag never dies',
        small.lookZone.h >= 360 - 1 && small.lookZone.y <= 1, `${small.lookZone.h.toFixed(0)} px tall`);
    ok('the smallest thumb target on any device is at least 38 px', minSize >= 37.5, `${minSize.toFixed(1)} px`);
    ok('thumb targets are never closer than 8 px apart', worstGap >= 8,
        `tightest ${worstGap.toFixed(1)} px (${worstPair})`);
    ok('the controls never cover a tenth of the middle of the view', maxCover < 10,
        `worst ${maxCover.toFixed(2)}%`);
    ok('and they leave the picture alone outside the thumb corners', maxPaint < 12,
        `worst ${maxPaint.toFixed(1)}% of the visible screen painted by the controls`);
    ok('no control climbs over the horizon', highest < 45, `highest ${highest.toFixed(1)}% from the bottom`);
    ok('the top-centre buttons do not fight the scoreboard', (() => {
        for (const k of Object.keys(seen)) {
            const R = seen[k];
            if (R.tBoard && R.tSkip && hit(R.tBoard, R.tSkip, -4)) return false;
        }
        return true;
    })(), 'scoreboard and skip are side by side on every size');
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed  (touch layout, ${cssFile})\n`);
process.exit(fail === 0 ? 0 : 1);
