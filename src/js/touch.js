// ============================================================================
// touch.js — thumb controls for phones and tablets.
//
// Layout, as held in two hands in landscape:
//
//   ┌────────────────────────────────────────────────────────┐
//   │  [minimap]                                   [II] pause│
//   │                                                        │
//   │        (whole right half is the LOOK pad)      [streaks]
//   │                                                        │
//   │   (move stick)                     [R] [ADS] [JUMP]   │
//   │    ◉ float wherever       [1][2][3][4]                │
//   │    you press                ( ⦿ FIRE )                 │
//   └────────────────────────────────────────────────────────┘
//
// The stick is floating — it appears under the thumb wherever it lands in the
// left zone, which matters on a phone where nobody holds it in the same place
// twice. Everything drives the SAME state the keyboard and mouse drive
// (player.axis, player.keys, player.mouseDown/mouseRight, player.addLookDelta),
// so there is no second code path for shooting, ADS or movement to drift out of
// sync with the desktop one.
//
// Only installed when the device has no hover and a coarse pointer, i.e. a real
// touch device rather than a touchscreen laptop.
// ============================================================================

const STICK_R = 56;          // px radius of the stick throw
const DEAD_ZONE = 0.16;      // fraction of the stick that counts as centred
const LOOK_GAIN = 1.5;       // finger px → the same feel as mouse px

/**
 * Capture without the exception: `setPointerCapture` throws NotFoundError when
 * the pointer is already gone (a tap that ended inside the same frame, or a
 * synthetic event from a test), and an uncaught throw in this file would leave a
 * stick half-dragged and the fire button stuck down.
 */
const capture = (node, id) => {
    try { node.setPointerCapture(id); } catch { /* already released */ }
};

const el = (tag, id, cls) => {
    const n = document.createElement(tag);
    if (id) n.id = id;
    if (cls) n.className = cls;
    return n;
};

/**
 * @param {object} opts
 * @param {() => object} opts.getPlayer  live player (the rig is rebuilt per match)
 * @param {object} [opts.cw]             collision world, kept for future aiming helpers
 * @param {() => void} [opts.onCycleSpectate]  tap-on-the-look-pad action
 */
export function installTouchControls({ getPlayer, cw, onCycleSpectate }) {
    document.body.classList.add('touch');

    const root = el('div', 'touchUI');
    const stickZone = el('div', 'tStickZone', 'tz');
    const lookZone = el('div', 'tLookZone', 'tz');
    const pad = el('div', 'tpad');
    const knob = el('div', 'tknob');
    pad.appendChild(knob);
    stickZone.appendChild(pad);
    root.appendChild(stickZone);
    root.appendChild(lookZone);

    // ── buttons ─────────────────────────────────────────────────────────────
    const btnRow = el('div', 'tActions', 'trow');
    const fireRow = el('div', 'tFireRow', 'trow');
    const mk = (label, cls, opts = {}) => {
        const b = el('button', opts.id, 'tbtn ' + (cls || ''));
        b.type = 'button';
        b.innerHTML = label;
        if (opts.title) b.title = opts.title;
        (opts.row || btnRow).appendChild(b);
        return b;
    };

    const weaponRow = el('div', 'tWeapons', 'trow');
    root.appendChild(weaponRow);
    root.appendChild(btnRow);
    root.appendChild(fireRow);

    const fire = mk('FIRE', 'fire', { row: fireRow, title: 'Shoot' });
    const ads = mk('ADS', 'hold', { title: 'Aim down sights (hold)' });
    const reload = mk('RLD', '', { title: 'Reload' });
    const jump = mk('JMP', 'hold', { title: 'Jump' });
    const crouch = mk('CRH', 'tog', { title: 'Crouch' });
    const sprint = mk('SPR', 'tog', { title: 'Sprint' });
    // the full loadout is bigger than four slots, so Q's "next weapon" gets a
    // thumb button too — otherwise the last eleven guns are unreachable
    const cycle = mk('WPN', '', { title: 'Next weapon' });   // stays on the action row
    const slots = [];
    for (let i = 0; i < 4; i++) {
        // into #tWeapons, above the action row — leaving them on the default row
        // stacked ten buttons across the right thumb and pushed FIRE's row apart
        const b = mk(String(i + 1), 'slot', { title: 'Weapon ' + (i + 1), row: weaponRow });
        slots.push(b);
    }

    // ── move stick ──────────────────────────────────────────────────────────
    let stickId = null;
    let originX = 0, originY = 0;

    const setAxis = (x, y) => {
        const p = getPlayer();
        if (!p) return;
        const len = Math.hypot(x, y);
        const scale = len > 1 ? 1 / len : 1;
        p.axis.x = x * scale;
        p.axis.y = -y * scale;              // screen up = forward
        // past 80% throw is a sprint request, same as holding Shift
        p.sprintTouch = len * scale > 0.8;
    };
    const resetStick = () => {
        stickId = null;
        pad.classList.remove('on');
        knob.style.transform = 'translate(-50%,-50%)';
        setAxis(0, 0);
    };

    stickZone.addEventListener('pointerdown', e => {
        if (stickId !== null) return;
        stickId = e.pointerId;
        const r = stickZone.getBoundingClientRect();
        originX = e.clientX - r.left;
        originY = e.clientY - r.top;
        pad.style.left = originX + 'px';
        pad.style.top = originY + 'px';
        pad.classList.add('on');
        capture(stickZone, e.pointerId);
        setAxis(0, 0);
        e.preventDefault();
    });
    stickZone.addEventListener('pointermove', e => {
        if (e.pointerId !== stickId) return;
        const r = stickZone.getBoundingClientRect();
        const dx = (e.clientX - r.left - originX) / STICK_R;
        const dy = (e.clientY - r.top - originY) / STICK_R;
        const len = Math.hypot(dx, dy);
        if (len < DEAD_ZONE) { setAxis(0, 0); knob.style.transform = 'translate(-50%,-50%)'; return; }
        knob.style.transform =
            `translate(calc(-50% + ${Math.max(-1, Math.min(1, dx)) * STICK_R}px),` +
            ` calc(-50% + ${Math.max(-1, Math.min(1, dy)) * STICK_R}px))`;
        setAxis(dx, dy);
    });
    const stickEnd = e => { if (e.pointerId === stickId) { resetStick(); e.preventDefault(); } };
    stickZone.addEventListener('pointerup', stickEnd);
    stickZone.addEventListener('pointercancel', stickEnd);

    // ── look pad (right half) ───────────────────────────────────────────────
    let lookId = null, lastX = 0, lastY = 0, moved = 0, downAt = 0;

    lookZone.addEventListener('pointerdown', e => {
        if (lookId !== null) return;
        const p = getPlayer();
        if (!p) return;
        lookId = e.pointerId;
        lastX = e.clientX; lastY = e.clientY;
        moved = 0; downAt = performance.now();
        capture(lookZone, e.pointerId);
        e.preventDefault();
    });
    lookZone.addEventListener('pointermove', e => {
        if (e.pointerId !== lookId) return;
        const p = getPlayer();
        if (!p) return;
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
        p.addLookDelta(dx * LOOK_GAIN, dy * LOOK_GAIN);
        e.preventDefault();
    });
    const lookEnd = e => {
        if (e.pointerId !== lookId) return;
        lookId = null;
        // a tap (not a drag) on the look pad cycles the spectated teammate, so
        // the desktop "click to switch" gesture still exists without a mouse
        if (moved < 14 && performance.now() - downAt < 420 && onCycleSpectate) onCycleSpectate();
    };
    lookZone.addEventListener('pointerup', lookEnd);
    lookZone.addEventListener('pointercancel', lookEnd);

    // ── button plumbing ─────────────────────────────────────────────────────
    const hold = (node, onDown, onUp) => {
        let id = null;
        node.addEventListener('pointerdown', e => {
            if (id !== null) return;
            id = e.pointerId;
            node.classList.add('down');
            onDown();
            capture(node, e.pointerId);
            e.preventDefault();
            e.stopPropagation();
        });
        const up = e => {
            if (e.pointerId !== id) return;
            id = null;
            node.classList.remove('down');
            if (onUp) onUp();
            e.preventDefault();
            e.stopPropagation();
        };
        node.addEventListener('pointerup', up);
        node.addEventListener('pointercancel', up);
    };

    const toggle = (node, onChange) => {
        let on = false;
        node.addEventListener('pointerdown', e => {
            on = !on;
            node.classList.toggle('down', on);
            onChange(on);
            e.preventDefault();
            e.stopPropagation();
        });
        node.api = { set: v => { on = v; node.classList.toggle('down', v); } };
        return node;
    };

    const tap = (node, fn) => hold(node, fn, null);

    hold(fire,
        () => { const p = getPlayer(); if (p) p.mouseDown = true; },
        () => { const p = getPlayer(); if (p) p.mouseDown = false; });

    // ADS is hold-to-aim: the right thumb is already on the look pad, so a
    // toggle it would have to leave is worse than this dedicated spot
    hold(ads,
        () => { const p = getPlayer(); if (p) p.mouseRight = true; },
        () => { const p = getPlayer(); if (p) p.mouseRight = false; });

    tap(reload, () => { const p = getPlayer(); if (p) p.startReload(); });
    hold(jump,
        () => { const p = getPlayer(); if (p) p.keys.Space = true; },
        () => { const p = getPlayer(); if (p) p.keys.Space = false; });
    toggle(crouch, on => {
        const p = getPlayer();
        if (!p) return;
        // the same field KeyC writes; clearing ControlLeft keeps hold-to-crouch
        // from fighting the button on a hybrid device with a keyboard attached
        p.isCrouching = on;
        p.keys.ControlLeft = false;
    });
    toggle(sprint, on => { const p = getPlayer(); if (p) p.keys.ShiftLeft = on; });
    slots.forEach((b, i) => tap(b, () => { const p = getPlayer(); if (p) p.switchTo(i); }));
    tap(cycle, () => {
        const p = getPlayer();
        if (p) p.switchTo((p.current + 1) % p.weapons.length);
    });

    // ── install ─────────────────────────────────────────────────────────────
    root.setAttribute('aria-hidden', 'true');
    document.body.appendChild(root);

    let lastSlot = -1, lastReload = null, poll = 0;
    const sync = () => {
        const p = getPlayer();
        if (!p) return;
        if (p.current !== lastSlot) { lastSlot = p.current; highlightSlot(lastSlot); }
        const re = !!p.mag.reloading;
        if (re !== lastReload) { lastReload = re; markReloading(re); }
    };

    const highlightSlot = i => slots.forEach((b, k) => b.classList.toggle('on', k === i));
    const markReloading = on => reload.classList.toggle('busy', !!on);
    const setVisible = on => {
        root.classList.toggle('on', on);
        clearInterval(poll);
        // 5 reads a second costs nothing and cannot drift; rAF would be DOM work
        // on every single frame for a phone that is already fighting for budget
        if (on) poll = setInterval(sync, 200);
    };
    setVisible(false);

    return {
        root,
        setVisible,
        /** Clear everything so a pause or a death cannot leave a thumb "held down". */
        releaseAll() {
            const p = getPlayer();
            resetStick();
            if (p) {
                p.mouseDown = false; p.mouseRight = false;
                p.keys.Space = false; p.keys.ShiftLeft = false;
                p.axis.x = 0; p.axis.y = 0; p.sprintTouch = false;
            }
            if (ads.classList) ads.classList.remove('down');
            crouch.api.set(false);
            sprint.api.set(false);
        },
        highlightSlot,
        markReloading,
        /** stop the poller when the game is torn down (hot reload, tests) */
        destroy() { clearInterval(poll); root.remove(); }
    };
}
