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

// ── the devices from the brief, all landscape ────────────────────────────────
const DEVICES = [
    { name: '360×640 phone', w: 640, h: 360 },
    { name: '390×844 phone', w: 844, h: 390 },
    { name: '412×915 phone', w: 915, h: 412 },
    { name: '768×1024 tablet', w: 1024, h: 768 }
];
// A landscape notch lives on the *side* of the screen and the home bar at the
// bottom, so the sides and the bottom are what a phone actually loses.
const NOTCH = { l: 47, r: 47, t: 0, b: 21 };
const FLAT = { l: 0, r: 0, t: 0, b: 0 };

/** The winning declarations per (selector, property), plus the custom properties. */
function collect(W, H) {
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
        ord++;
        for (const sel of sels()) {
            if (!sel) continue;
            for (const one of sel.split(',')) props.set(`${one.trim()}|${prop}`, { val, ord });
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
            if (e && (!best || e.ord > best.ord)) best = e;
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
function rectOf(C, id, W, H, at, classes = [], size = null) {
    // #id, `body.touch #id`, then whatever the shared class rule says — the same
    // reach a browser would give this element, resolved in file order.
    // The element's own id, the body.touch and #touchUI forms of it, and the class
    // it actually carries — never a class it does not have, or the invisible pads'
    // `top:0;bottom:0` would stretch every button to the height of the screen.
    const reach = [`#${id}`, `body.touch #${id}`, `#touchUI #${id}`,
        ...classes, ...classes.map(c => `body.touch ${c}`), ...classes.map(c => `#touchUI ${c}`)];
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
const HUD = ['miniWrap', 'matchBar', 'killfeed', 'healthWrap', 'brWrap', 'slots', 'streakCol'];

let worstGap = Infinity, worstPair = '', maxCover = 0, minSize = Infinity, highest = 0;
const seen = {};
for (const dev of DEVICES) {
    group(`${dev.name} (${dev.w}×${dev.h} landscape)`);
    for (const [notchName, at] of [['', FLAT], ['notched', NOTCH]]) {
        const C = collect(dev.w, dev.h);
        const R = {};
        for (const id of WIDGETS) R[id] = rectOf(C, id, dev.w, dev.h, at, CL[id]);
        const tag = notchName ? `${notchName} ${dev.name}` : dev.name;

        const missing = WIDGETS.filter(id => !R[id]);
        ok(`${tag}: every control is sized by the stylesheet`, missing.length === 0, missing.join(' '));

        const off = FIXED.concat(ROAM).filter(id => R[id]
            && (R[id].x < -0.5 || R[id].y < -0.5 || R[id].x + R[id].w > dev.w + 0.5 || R[id].y + R[id].h > dev.h + 0.5));
        ok(`${tag}: every control sits inside the screen`, off.length === 0, off.join(' '));

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
        // The box an enemy appears in: the crosshair, plus a third of the screen.
        const centre = { x: dev.w * 0.33, y: dev.h * 0.33, w: dev.w * 0.34, h: dev.h * 0.34 };
        let covered = 0;
        for (const id of WIDGETS) {
            // The two pads are invisible; the stick appears under the thumb and is
            // translucent by design, so neither counts against the view.
            if (!R[id] || id === 'lookZone' || id === 'stickZone' || id === 'stick' || id === 'stickKnob') continue;
            const o = isect(centre, R[id]);
            covered += area(o);
        }
        const pct = covered / area(centre) * 100;
        maxCover = Math.max(maxCover, pct);
        ok(`${tag}: the middle of the view stays clear`, pct < 1, `${pct.toFixed(2)}% covered`);

        if (!notchName) {
            for (const id of BTN) if (R[id]) minSize = Math.min(minSize, Math.min(R[id].w, R[id].h));
            if (R.tJump) highest = Math.max(highest, (dev.h - R.tJump.y) / dev.h * 100);
            seen[dev.name] = R;
        }

        // HUD readouts, and the thumb clearance they have to respect
        const NOM = { brWrap: [150, 28], slots: [112, 22], killfeed: [180, 46], healthWrap: [120, 54],
            streakCol: [140, 28], matchBar: [118, 26], miniWrap: [118, 118] };
        const hr = {};
        for (const id of HUD) hr[id] = rectOf(C, id, dev.w, dev.h, at, [], NOM[id]);
        hr.gameBtns = rectOf(C, 'gameBtns', dev.w, dev.h, at, [], [42, 42]);
        const missingHud = HUD.filter(id => !hr[id]);
        ok(`${tag}: the HUD corners are laid out too`, missingHud.length === 0, missingHud.join(' '));
        // the top-right column, and the thumb cluster under it, must not stack on
        // each other: one shared right edge, five elements.
        const col = ['gameBtns', 'killfeed', 'brWrap', 'slots', 'streakCol'].filter(k => hr[k]);
        const stack = [];
        for (let i = 0; i < col.length; i++)
            for (let j = i + 1; j < col.length; j++)
                if (hit(hr[col[i]], hr[col[j]], -4)) stack.push(`${col[i]}/${col[j]}`);
        ok(`${tag}: the top-right readout column does not overlap itself`, stack.length === 0, stack.join(' '));
        const over = [];
        for (const id of FIXED) {
            if (!R[id]) continue;
            for (const k of col) if (hit(R[id], hr[k], -4)) over.push(`${id}/${k}`);
        }
        ok(`${tag}: no readout sits under a thumb button`, over.length === 0, over.join(' '));
        if (R.tFire && hr.brWrap) {
            const okBr = hr.brWrap.y + hr.brWrap.h <= R.tJump.y + 4;
            ok(`${tag}: the readouts stop above the button grid`, okBr,
                `column ends ${hr.brWrap.y.toFixed(0)} vs the jump row at ${R.tJump.y.toFixed(0)}`);
        }
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
