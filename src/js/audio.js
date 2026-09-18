// ============================================================================
// audio.js — synthesised weapon and world audio.
// Master chain: sources → bus → compressor → master → destination, with a
// parallel convolver send so gunshots get a real outdoor tail.
// ============================================================================
let ctx = null, master = null, comp = null, dry = null, verb = null, wet = null;
let muted = false, duckUntil = 0, duckLevel = 1;

function init() {
    if (ctx) {
        if (ctx.state === 'suspended') ctx.resume();
        return ctx;
    }
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);

    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 22;
    comp.ratio.value = 5;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;
    comp.connect(master);

    dry = ctx.createGain(); dry.gain.value = 1.0; dry.connect(comp);

    // outdoor slap-back impulse
    verb = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 1.5);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = 0; i < len; i++) {
            const t = i / ctx.sampleRate;
            const env = Math.pow(1 - i / len, 3.2) * (t < 0.012 ? t / 0.012 : 1);
            d[i] = (Math.random() * 2 - 1) * env * 0.55;
        }
        // a couple of discrete early reflections (houses across the street)
        for (const [ms, amp] of [[38, 0.5], [71, 0.34], [118, 0.2]]) {
            const idx = Math.floor(ctx.sampleRate * ms / 1000);
            if (idx < len) d[idx] += amp * (ch ? -1 : 1);
        }
    }
    verb.buffer = buf;
    wet = ctx.createGain(); wet.gain.value = 0.32;
    verb.connect(wet); wet.connect(comp);
    return ctx;
}

export function unlockAudio() { init(); }
export function toggleMute() {
    init();
    muted = !muted;
    master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.02);
    return muted;
}
export function isMuted() { return muted; }

/** Temporarily pull everything else down (used by the nuke). */
export function duckAudio(level, seconds) {
    init();
    duckLevel = level; duckUntil = ctx.currentTime + seconds;
    master.gain.setTargetAtTime(muted ? 0 : 0.9 * level, ctx.currentTime, 0.15);
    setTimeout(() => {
        if (!ctx) return;
        master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.8);
    }, seconds * 1000);
}

// ── primitives ──────────────────────────────────────────────────────────────
function out(node, sendVerb = 0.25) {
    node.connect(dry);
    if (sendVerb > 0) {
        const s = ctx.createGain();
        s.gain.value = sendVerb;
        node.connect(s); s.connect(verb);
    }
}

function noiseBuf(seconds) {
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const b = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return b;
}

/**
 * WebAudio rejects a non-finite value with a throw, and these calls happen inside
 * the per-frame event loop — one bad number used to abandon the rest of that
 * bot's events, including the hit it had just landed. So every parameter is
 * clamped here rather than trusted at the call site: a silent sound is a much
 * cheaper failure than a dropped shot.
 */
const sane = (v, min, max, dflt) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt);

function noise(dur, vol, lp = 6000, hp = 120, sendVerb = 0.25, curve = 3) {
    dur = sane(dur, 0.01, 4, 0.1);
    vol = sane(vol, 0.0002, 1, 0.15);
    lp = sane(lp, 20, 20000, 6000);
    hp = sane(hp, 10, 18000, 120);
    curve = sane(curve, 0.2, 8, 3);
    init();
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf(dur);
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur * curve * 0.4 + 0.01);
    const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass'; lpf.frequency.value = lp;
    const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass'; hpf.frequency.value = hp;
    src.connect(hpf); hpf.connect(lpf); lpf.connect(g);
    out(g, sendVerb);
    src.start(t);
    src.stop(t + dur + 0.05);
    return { src, g, lpf };
}

function tone(freq, dur, vol, type = 'sine', slideTo = null, sendVerb = 0.1, delay = 0) {
    freq = sane(freq, 10, 20000, 440);
    dur = sane(dur, 0.01, 4, 0.1);
    vol = sane(vol, 0.0002, 1, 0.1);
    if (slideTo !== null) slideTo = sane(slideTo, 10, 20000, null);
    init();
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g);
    out(g, sendVerb);
    o.start(t); o.stop(t + dur + 0.02);
    return o;
}

function click(freq, dur, vol, delay = 0) {
    freq = sane(freq, 20, 20000, 1200);
    dur = sane(dur, 0.01, 2, 0.05);
    vol = sane(vol, 0.0002, 1, 0.1);
    init();
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf(dur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);
    src.connect(bp); bp.connect(g);
    out(g, 0.12);
    src.start(t); src.stop(t + dur + 0.02);
}

// ── weapons ─────────────────────────────────────────────────────────────────
export function playGunshot(type = 'rifle') {
    init();
    if (type === 'shotgun') {
        noise(0.06, 0.55, 9000, 300, 0.3, 1.2);
        noise(0.34, 0.42, 1600, 60, 0.65, 2.4);
        tone(72, 0.20, 0.42, 'sine', 32, 0.3);
        tone(120, 0.06, 0.18, 'square', 60, 0.1);
    } else if (type === 'sniper') {
        noise(0.05, 0.62, 12000, 800, 0.25, 1.0);
        noise(0.55, 0.40, 1100, 45, 0.85, 2.6);
        tone(58, 0.32, 0.45, 'sine', 24, 0.5);
        tone(180, 0.05, 0.16, 'sawtooth', 70, 0.1);
    } else if (type === 'smg') {
        noise(0.028, 0.34, 11000, 700, 0.18, 1.0);
        noise(0.10, 0.20, 3200, 180, 0.35, 2.0);
        tone(148, 0.035, 0.16, 'square', 70, 0.06);
    } else {
        noise(0.032, 0.40, 10000, 520, 0.20, 1.0);
        noise(0.15, 0.26, 2600, 130, 0.45, 2.2);
        tone(96, 0.09, 0.24, 'sine', 44, 0.14);
        tone(210, 0.03, 0.12, 'square', 90, 0.06);
    }
}

/** Distant/enemy gunfire — thinner, more tail. */
export function playGunshotDistant(type = 'rifle', distance = 20) {
    init();
    const att = Math.max(0.06, 1 - sane(distance, 0, 400, 20) / 55);
    noise(0.05, 0.16 * att, 2600 - distance * 22, 90, 0.7, 1.6);
    tone(70, 0.14, 0.10 * att, 'sine', 34, 0.5);
    void type;
}

export function playDryFire() { click(2400, 0.05, 0.20); click(900, 0.04, 0.12, 0.02); }

export function playReload(type = 'rifle') {
    init();
    if (type === 'sniper') {
        click(1800, 0.07, 0.22, 0.05); tone(320, 0.06, 0.10, 'square', 180, 0.05, 0.12);
        click(1200, 0.09, 0.24, 0.9); click(2600, 0.05, 0.20, 1.6);
    } else if (type === 'shotgun') {
        for (let i = 0; i < 4; i++) { click(1500, 0.05, 0.18, 0.12 + i * 0.28); click(700, 0.05, 0.12, 0.18 + i * 0.28); }
    } else {
        click(1100, 0.06, 0.22, 0.10);                        // mag release
        noise(0.10, 0.10, 3000, 400, 0.15, 1.4);              // mag out
        click(820, 0.09, 0.26, 0.85);                         // mag seat
        tone(240, 0.07, 0.12, 'square', 140, 0.05, 0.86);
        click(2200, 0.06, 0.22, 1.55);                        // bolt release
        click(1400, 0.05, 0.18, 1.62);
    }
}

export function playWeaponSwap() { click(900, 0.06, 0.14); click(1600, 0.05, 0.10, 0.14); }

// ── feedback ────────────────────────────────────────────────────────────────
export function playHitmarker() { tone(1850, 0.035, 0.16, 'sine', null, 0.02); tone(2500, 0.03, 0.10, 'sine', null, 0.02, 0.02); }
export function playHeadshot() { tone(2600, 0.05, 0.20, 'sine', 3400, 0.05); tone(1600, 0.09, 0.12, 'triangle', null, 0.05, 0.03); }
export function playKillConfirm() {
    tone(760, 0.09, 0.16, 'sine', null, 0.06);
    tone(1140, 0.13, 0.14, 'sine', null, 0.06, 0.07);
}
export function playHurt() { noise(0.10, 0.16, 900, 60, 0.1, 1.6); tone(140, 0.10, 0.10, 'sine', 70, 0.05); }
export function playLowHealth() { tone(120, 0.5, 0.05, 'sine', 100, 0.1); }
export function playDeath() { noise(0.5, 0.20, 700, 40, 0.5, 2.4); tone(90, 0.7, 0.14, 'sine', 34, 0.4); }

export function playFootstep(surface = 'concrete', vol = 0.8) {
    init();
    const v = 0.055 * vol;
    if (surface === 'dirt') { noise(0.055, v * 1.1, 1500, 140, 0.1, 1.6); }
    else if (surface === 'wood') { noise(0.04, v, 2600, 260, 0.14, 1.4); tone(190, 0.05, v * 0.7, 'triangle', 120, 0.05); }
    else if (surface === 'asphalt') { noise(0.045, v, 3400, 320, 0.12, 1.4); }
    else { noise(0.042, v, 3000, 300, 0.12, 1.4); }
}
export function playJump() { noise(0.05, 0.05, 2400, 300, 0.08, 1.4); }
export function playLand() { noise(0.10, 0.13, 1400, 100, 0.15, 1.8); tone(110, 0.10, 0.08, 'sine', 60, 0.06); }

// ── killstreaks ─────────────────────────────────────────────────────────────
export function playUAV() {
    init();
    const t = ctx.currentTime;
    // radio blip then a distant prop drone
    tone(1200, 0.05, 0.12, 'square', 1600, 0.1);
    tone(900, 0.07, 0.10, 'square', 700, 0.1, 0.08);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf(6); src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 260; bp.Q.value = 3;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 18;
    const lfoG = ctx.createGain(); lfoG.gain.value = 90;
    lfo.connect(lfoG); lfoG.connect(bp.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.055, t + 1.2);
    g.gain.setValueAtTime(0.055, t + 26);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 31);
    src.connect(bp); bp.connect(g); out(g, 0.3);
    src.start(t); lfo.start(t);
    src.stop(t + 32); lfo.stop(t + 32);
}

export function playJetPass() {
    init();
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf(4);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.9;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(2400, t + 1.6);
    bp.frequency.exponentialRampToValueAtTime(220, t + 3.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.30, t + 1.5);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 3.6);
    src.connect(bp); bp.connect(g); out(g, 0.6);
    src.start(t); src.stop(t + 3.8);
}

export function playExplosion() {
    noise(0.09, 0.6, 9000, 400, 0.4, 1.2);
    noise(0.9, 0.5, 900, 30, 0.9, 2.8);
    tone(48, 0.55, 0.5, 'sine', 20, 0.5);
    tone(90, 0.25, 0.22, 'triangle', 34, 0.3);
}

export function playNukeSiren() {
    init();
    const t = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sawtooth';
        const s = t + i * 1.55;
        o.frequency.setValueAtTime(300, s);
        o.frequency.linearRampToValueAtTime(660, s + 0.75);
        o.frequency.linearRampToValueAtTime(300, s + 1.5);
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(0.16, s + 0.25);
        g.gain.exponentialRampToValueAtTime(0.0004, s + 1.5);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
        o.connect(lp); lp.connect(g); out(g, 0.7);
        o.start(s); o.stop(s + 1.55);
    }
}

export function playNukeBlast() {
    init();
    const t = ctx.currentTime;
    // sharp crack, then a very long rolling low end
    noise(0.16, 0.9, 14000, 600, 0.5, 1.0);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf(6);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3000, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 5.5);
    src.connect(lp); lp.connect(g); out(g, 1.0);
    src.start(t); src.stop(t + 6);
    tone(34, 4.0, 0.8, 'sine', 14, 0.6);
    tone(52, 2.2, 0.4, 'triangle', 20, 0.5);
}

// ── ambience ────────────────────────────────────────────────────────────────
let ambientNode = null;
export function playAmbient() {
    init();
    if (ambientNode) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf(8); src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 60;
    const g = ctx.createGain(); g.gain.value = 0.030;
    // slow gusting
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lg = ctx.createGain(); lg.gain.value = 0.016;
    lfo.connect(lg); lg.connect(g.gain);
    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(dry);
    src.start(t); lfo.start(t);
    ambientNode = { src, lfo, g };
}
export function stopAmbient() {
    if (!ambientNode) return;
    try { ambientNode.src.stop(); ambientNode.lfo.stop(); } catch { /* already stopped */ }
    ambientNode = null;
}

export function playMatchStart() {
    tone(220, 0.5, 0.14, 'sine', 330, 0.3);
    tone(330, 0.7, 0.10, 'sine', 440, 0.3, 0.18);
}
export function playVictory() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.55, 0.14, 'triangle', null, 0.3, i * 0.14));
}
export function playDefeat() {
    [392, 349, 294, 233].forEach((f, i) => tone(f, 0.7, 0.14, 'sine', null, 0.3, i * 0.18));
}
export function playCountdown() { tone(880, 0.10, 0.12, 'square', null, 0.05); }

void duckUntil; void duckLevel;
