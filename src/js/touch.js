// ============================================================================
// touch.js — the touch HUD, so the game is playable with two thumbs.
//
// Layout, Free Fire style: the left 40% of the screen is a thumbstick that
// appears wherever you put your thumb; the right side turns the camera wherever
// you drag that is not a button; fire sits bottom-right with jump, crouch, reload
// and weapon-swap in an arc around it. Everything is one `player.touch` object
// read by player.js, which is the only place movement is decided:
//
//   player.touch = { moveX, moveY,   // -1..1 analog, dead-zoned here
//                    sprint,          // stick at the rim, or the sprint button
//                    fire, ads,       // held booleans (ads may toggle by setting)
//                    jump,            // one-frame pulse
//                    lookDX, lookDY } // raw pixel deltas, consumed each frame
//
// Why deltas instead of applying the look here: the sensitivity scaling, the ADS
// zoom cancellation, the pitch clamp and the viewmodel sway all live in
// Player._applyLook, and the mouse goes through the same door. Two paths that
// each know how to turn a camera is two paths that drift apart.
//
// Pointer Events, one tracked pointerId each, with setPointerCapture — that is
// what makes move + look + fire possible at the same time; a `touchstart`
// handler with `changedTouches` and no capture loses a finger the moment the
// browser decides the gesture is a scroll.
// ============================================================================

// The same test the desktop gate used: `(hover: none) and (pointer: coarse)`.
// `maxTouchPoints` is deliberately not enough — a touchscreen laptop has it and
// plays fine with a mouse. `?touch=1` forces the HUD on, for testing on a
// desktop and for a hybrid machine whose media query lies.
export const IS_TOUCH = (() => {
    try {
        if (/[?&]touch=1/.test(location.search)) return true;
        if (/[?&]touch=0/.test(location.search)) return false;
    } catch { /* no location (node tests) */ }
    return !!(window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches);
})();

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Stick geometry, in CSS pixels of the base radius; the CSS sizes the base and
// reads these back, so changing the look is a one-line change in index.html.
const STICK_R = 45;           // half the base, i.e. the full-throw radius. Kept at
                              // half of --base's smallest value in index.html so the knob
                              // cannot travel past the ring the thumb is aiming at.
const DEAD = 0.14;            // fraction of STICK_R before it counts as pushing
const SPRINT_AT = 0.92;       // pushed to the rim ...
const SPRINT_OFF = 0.72;      // ... and it unlocks only when this much lighter

export function initTouch(hooks) {
    if (!IS_TOUCH) return null;
    const root = $('touchUI');
    if (!root) return null;
    document.body.classList.add('touch');

    const player = () => hooks.getPlayer();
    // `settings` is handed over as a getter because main.js swaps the whole object
    // when a profile is loaded; reading it through this keeps the HUD in step.
    const settings = () => (typeof hooks.settings === 'function' ? hooks.settings() : hooks.settings) || {};

    const t = {
        moveX: 0, moveY: 0, sprint: false, sprintBtn: false, fire: false, ads: false,
        jump: false, lookDX: 0, lookDY: 0
    };
    // The object is handed to the player once; player.js reads it every frame and
    // clears the pulse fields itself.
    if (player()) player().touch = t;

    // ── vibration ───────────────────────────────────────────────────────────
    // A buzz on the things you want confirmed without looking: the first shot of
    // a burst, a reload, a weapon swap. Not on every shot at 780 RPM — that is
    // not feedback, that is a motor heating up in your pocket.
    let buzzedThisBurst = false;
    const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* denied */ } };

    // ── the stick ───────────────────────────────────────────────────────────
    const stickZone = $('stickZone'), stick = $('stick'), knob = $('stickKnob');
    let stickId = null, sx0 = 0, sy0 = 0, sprintHeld = false, sprintT = 0, lastFrac = 0;

    const stickPlace = (x, y) => {
        // The base appears under the thumb rather than being nailed to a corner:
        // it is what lets you re-grip mid-fight without looking for it.
        stick.style.left = `${x}px`;
        stick.style.top = `${y}px`;
        stick.classList.add('on');
        stickZone.classList.add('grab');
    };
    const stickMove = (x, y) => {
        let dx = x - sx0, dy = y - sy0;
        const len = Math.hypot(dx, dy);
        const r = (settings().ctrlSize || 1) * STICK_R;
        if (len > r) { dx *= r / len; dy *= r / len; }
        const m = Math.hypot(dx, dy) / r;
        if (m < DEAD) { t.moveX = t.moveY = 0; }
        else {
            const k = (m - DEAD) / (1 - DEAD);        // re-ramp so a dead zone is not a step
            t.moveX = (dx / r) * k / Math.max(0.35, m);
            t.moveY = (dy / r) * k / Math.max(0.35, m);
            const l = Math.hypot(t.moveX, t.moveY);
            if (l > 1) { t.moveX /= l; t.moveY /= l; }
        }
        knob.style.transform = `translate(${dx}px,${dy}px)`;
        // How far the thumb is into the throw, remembered for frame(), which is
        // where the run is actually latched (see there).
        lastFrac = Math.min(1, len / r);
    };
    const stickEnd = () => {
        stickId = null;
        t.moveX = t.moveY = 0;
        sprintHeld = false; sprintT = 0; lastFrac = 0;
        stick.classList.remove('on');
        stickZone.classList.remove('grab');
        knob.style.transform = '';
    };
    stickZone.addEventListener('pointerdown', e => {
        if (stickId !== null) return;
        e.preventDefault();
        stickId = e.pointerId;
        sx0 = e.clientX; sy0 = e.clientY;
        stickPlace(sx0, sy0);
        try { stickZone.setPointerCapture(e.pointerId); } catch { /* older engines */ }
    });
    stickZone.addEventListener('pointermove', e => {
        if (e.pointerId !== stickId) return;
        e.preventDefault();
        stickMove(e.clientX, e.clientY);
    });
    for (const type of ['pointerup', 'pointercancel'])
        stickZone.addEventListener(type, e => { if (e.pointerId === stickId) { e.preventDefault(); stickEnd(); } });

    // ── the look pad ────────────────────────────────────────────────────────
    const lookZone = $('lookZone');
    let lookId = null, lx = 0, ly = 0;
    lookZone.addEventListener('pointerdown', e => {
        if (lookId !== null) return;
        e.preventDefault();
        lookId = e.pointerId; lx = e.clientX; ly = e.clientY;
        lookZone.classList.add('grab');
        try { lookZone.setPointerCapture(e.pointerId); } catch { /* older engines */ }
    });
    lookZone.addEventListener('pointermove', e => {
        if (e.pointerId !== lookId) return;
        e.preventDefault();
        const p = player();
        if (!p) return;
        t.lookDX += (e.clientX - lx) * (settings().touchSens || 1);
        t.lookDY += (e.clientY - ly) * (settings().touchSens || 1);
        lx = e.clientX; ly = e.clientY;
    });
    for (const type of ['pointerup', 'pointercancel'])
        lookZone.addEventListener(type, e => {
            if (e.pointerId !== lookId) return;
            e.preventDefault();
            lookId = null;
            lookZone.classList.remove('grab');
        });

    // ── buttons ─────────────────────────────────────────────────────────────
    // Every control gets its own pointerId and its own capture, which is what
    // lets a held fire button survive a simultaneous stick push. `hold` drives a
    // boolean; `tap` pulses for one frame or calls straight through.
    const bind = (el, { hold, down, up, tap } = {}) => {
        if (!el) return;
        let id = null;
        const press = e => {
            if (id !== null) return;
            e.preventDefault();
            e.stopPropagation();
            id = e.pointerId;
            el.classList.add('down');
            try { el.setPointerCapture(e.pointerId); } catch { /* older engines */ }
            if (hold) down && down();
            else if (tap) tap();
        };
        const release = e => {
            if (e.pointerId !== id) return;
            e.preventDefault();
            e.stopPropagation();
            id = null;
            el.classList.remove('down');
            if (hold) up && up();
        };
        el.addEventListener('pointerdown', press);
        el.addEventListener('pointerup', release);
        el.addEventListener('pointercancel', release);
        el.addEventListener('lostpointercapture', release);
        // A tap on glass must not also produce the browser's own click: on iOS
        // that is a 300 ms delay, and double-tap is a zoom request.
        el.addEventListener('click', e => e.preventDefault());
    };

    bind($('tFire'), {
        hold: true,
        down: () => { t.fire = true; if (!buzzedThisBurst) { buzz(14); buzzedThisBurst = true; } },
        up: () => { t.fire = false; buzzedThisBurst = false; }
    });
    bind($('tFire2'), {
        hold: true,
        down: () => { t.fire = true; if (!buzzedThisBurst) { buzz(14); buzzedThisBurst = true; } },
        up: () => { t.fire = false; buzzedThisBurst = false; }
    });
    // Aim down sights. One handler for both modes, because two handlers on one
    // button is how you end up with a toggle and a hold fighting over the flag.
    const adsBtn = $('tAds');
    let adsId = null;
    if (adsBtn) {
        adsBtn.addEventListener('pointerdown', e => {
            e.preventDefault(); e.stopPropagation();
            if (adsId !== null) return;
            adsId = e.pointerId;
            try { adsBtn.setPointerCapture(e.pointerId); } catch { /* older engines */ }
            adsBtn.classList.add('down');
            // Tap by default: a scope you must keep pressing is a scope nobody
            // uses on a phone. The settings row offers the hold for the purists.
            t.ads = settings().adsMode === 'hold' ? true : !t.ads;
            adsBtn.classList.toggle('lit', t.ads);
        });
        const adsOff = e => {
            if (e.pointerId !== adsId) return;
            e.preventDefault(); e.stopPropagation();
            adsId = null;
            adsBtn.classList.remove('down');
            if (settings().adsMode === 'hold') { t.ads = false; adsBtn.classList.remove('lit'); }
        };
        adsBtn.addEventListener('pointerup', adsOff);
        adsBtn.addEventListener('pointercancel', adsOff);
        adsBtn.addEventListener('click', e => e.preventDefault());
    }
    bind($('tJump'), { tap: () => { t.jump = true; } });
    bind($('tSprint'), {
        hold: true,
        down: () => { t.sprintBtn = true; },
        up: () => { t.sprintBtn = false; }
    });
    bind($('tCrouch'), {
        tap: () => {
            const p = player();
            if (p) p.isCrouching = !p.isCrouching;      // the same flip KeyC does
        }
    });
    bind($('tReload'), {
        tap: () => { const p = player(); if (p) { p.startReload(); buzz(18); } }
    });
    bind($('tSwap'), {
        tap: () => { const p = player(); if (p) { p.cycleSlot(1); buzz(12); } }
    });
    bind($('tBoard'), {
        hold: true,                                     // hold it like Tab
        down: () => hooks.scoreboard && hooks.scoreboard(true),
        up: () => hooks.scoreboard && hooks.scoreboard(false)
    });
    bind($('tSkip'), { tap: () => hooks.skip && hooks.skip() });
    bind($('tNext'), { tap: () => hooks.nextPlayer && hooks.nextPlayer(1) });
    // Free roam: Space and C are "fly up / down", so the same buttons the death
    // screen needs are two keys on the keyboard. They only show while roaming.
    bind($('tUp'), {
        hold: true,
        down: () => hooks.roam && hooks.roam.key('Space', true),
        up: () => hooks.roam && hooks.roam.key('Space', false)
    });
    bind($('tDown'), {
        hold: true,
        down: () => hooks.roam && hooks.roam.key('KeyC', true),
        up: () => hooks.roam && hooks.roam.key('KeyC', false)
    });
    // Go fullscreen and ask for landscape. Both are prompts the user has to
    // answer, so the menu carries a copy of the button for before a match starts.
    const toggleFull = () => {
        const el = document.documentElement;
        if (!document.fullscreenElement) {
            const req = el.requestFullscreen && el.requestFullscreen({ navigationUI: 'hide' });
            if (req && req.catch) req.catch(() => { /* refused: stay windowed */ });
        } else if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
        // The orientation lock is only honoured inside fullscreen, and only on
        // Android; where it is refused, the rotate overlay explains the rest.
        setTimeout(() => {
            try {
                const o = screen.orientation;
                if (o && o.lock && document.fullscreenElement) o.lock('landscape').catch(() => {});
            } catch { /* unsupported */ }
        }, 250);
    };
    for (const id of ['tFull', 'menuFull']) {
        const el = $(id);
        if (!el) continue;
        el.addEventListener('pointerdown', e => {
            e.preventDefault(); e.stopPropagation();
            toggleFull();
            el.classList.add('down');
            setTimeout(() => el.classList.remove('down'), 140);
        });
    }

    // ── the surfaces themselves ─────────────────────────────────────────────
    // Block the gestures that belong to the browser, not the game: rubber-band
    // scroll, pull-to-refresh, pinch and double-tap zoom. `touch-action:none` in
    // CSS does most of this; iOS Safari still fires its own gesture events.
    for (const type of ['gesturestart', 'gesturechange', 'dblclick'])
        root.addEventListener(type, e => e.preventDefault());
    document.addEventListener('touchmove', e => {
        if (e.target && e.target.closest && e.target.closest('#touchUI')) e.preventDefault();
    }, { passive: false });
    // Never let a tap on the play area become a text-selection or a callout.
    root.addEventListener('contextmenu', e => e.preventDefault());

    // ── per-frame glue ──────────────────────────────────────────────────────
    const sizeVar = v => root.style.setProperty('--tsize', String(v));
    const opacityVar = v => root.style.setProperty('--topaque', String(v));

    const api = {
        /** The one object the player reads; handed over once, kept alive. */
        state: t,
        visible: false,
        /** Show the controls only over live play, never over a menu to click. */
        frame() {
            const p = player();
            const on = !!(hooks.visible && hooks.visible());
            if (on !== api.visible) {
                api.visible = on;
                root.classList.toggle('on', on);
                if (!on) { stickEnd(); t.fire = false; t.ads = false; t.sprintBtn = false;
                    if (adsBtn) adsBtn.classList.remove('lit'); }
            }
            if (!on) return;
            // Clamped here as well as by the input, because settings.js is a
            // hand-editable file and a size of 5 would bury the whole screen.
            const cs = clamp(settings().ctrlSize || 1, 0.8, 1.4);
            sizeVar(cs);
            opacityVar(clamp(settings().ctrlOpacity ?? 0.5, 0.25, 0.95));
            const roamOn = !!(hooks.roaming && hooks.roaming());
            root.classList.toggle('roam', roamOn);
            if (roamOn) {
                if (hooks.roam) {
                    // The free-roam camera moves on WASD, so the stick is translated
                    // into the same keys rather than into a second movement path.
                    const m = Math.hypot(t.moveX, t.moveY);
                    if (m < DEAD) {
                        for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) hooks.roam.key(k, false);
                    } else {
                        const a = Math.atan2(t.moveX, -t.moveY);
                        hooks.roam.key('KeyW', Math.abs(a) < 1.15);
                        hooks.roam.key('KeyS', Math.abs(a) > 2.0);
                        hooks.roam.key('KeyD', a > 1.15 && a < 2.0);
                        hooks.roam.key('KeyA', a < -1.15 && a > -2.0);
                    }
                    hooks.roam.key('ShiftLeft', t.sprint);
                    if (t.lookDX || t.lookDY) hooks.roam.look(t.lookDX, t.lookDY, 1);
                }
                t.lookDX = t.lookDY = 0;
            }
            if (roamOn) {
                // The roam camera is key-driven, so the stick becomes keys here.
                api.roamMove();
                if (hooks.roam && (t.lookDX || t.lookDY)) {
                    hooks.roam.look(t.lookDX, t.lookDY, 1);
                    t.lookDX = t.lookDY = 0;      // the player is not alive to spend them
                }
            }
            // State the buttons mirror, so they read correctly without a press:
            // crouch is a toggle and ADS can be flipped from the keyboard too.
            if (p) {
                $('tCrouch') && $('tCrouch').classList.toggle('lit', !!p.isCrouching);
                adsBtn && adsBtn.classList.toggle('lit', !!t.ads);
                const can = !!(hooks.canSkip && hooks.canSkip());
                $('tSkip') && $('tSkip').classList.toggle('hide', !can);
            }
            // Edge-locked sprint. The grace period is measured in frames rather
            // than in pointermove events, because a thumb that reaches the rim and
            // holds still stops sending events; and hysteresis on the way out keeps
            // a trembling thumb from flickering between walking and running.
            if (!sprintHeld && lastFrac > SPRINT_AT && (sprintT += 1) > 4) sprintHeld = true;
            else if (sprintHeld && lastFrac < SPRINT_OFF) { sprintHeld = false; sprintT = 0; }
            // The stick pushes at a run only if the ruleset lets it: ADS and
            // crouch veto sprint exactly as the keyboard does, and player.js has
            // the last word — it is the one that knows about being airborne.
            t.sprint = sprintHeld || !!t.sprintBtn;
        },
        /** Movement from the stick, translated for the roam camera's key model. */
        roamMove() {
            const r = hooks.roam;
            if (!r) return;
            const m = Math.hypot(t.moveX, t.moveY);
            const set = (code, on) => r.key(code, on);
            if (m < DEAD) {
                for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD']) set(k, false);
            } else {
                const a = Math.atan2(t.moveX, -t.moveY);            // 0 = forward
                set('KeyW', Math.abs(a) < 1.15);
                set('KeyS', Math.abs(a) > 2.0);
                set('KeyD', a > 1.15 && a < 2.0);
                set('KeyA', a < -1.15 && a > -2.0);
            }
            set('ShiftLeft', t.sprint);
        },
        destroy() { root.classList.remove('on'); }
    };
    return api;
}
