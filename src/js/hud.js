// ============================================================================
// hud.js — all 2D interface: circular minimap with a rotating compass ring,
// match block, ammo/equipment, killstreak column, feeds and overlays.
// Also owns the main-menu mode picker, since that is pure DOM work.
// ============================================================================
import { MINIMAP, MAP_BOUNDS } from './map.js';
import { STREAKS } from './killstreaks.js';
import { WEAPON_DEFS } from './weapons.js';

const $ = id => document.getElementById(id);
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const EMPTY = [];

const _nukeDef = STREAKS.find(s => s.id === 'nuke');
const NUKE_NEED = _nukeDef ? _nukeDef.need : 15;

// Writing textContent with an identical value still dirties layout in some
// engines, so every per-frame text write goes through here.
function txt(el, v) {
    if (!el) return;
    const s = v === null || v === undefined ? '' : String(v);
    if (el.textContent !== s) el.textContent = s;
}

// ── mode picker (main menu) ─────────────────────────────────────────────────
// modes.js may not exist yet in a partial build, so it is pulled in
// dynamically and the catalogue falls back to the spec list.
const FALLBACK_MODES = [
    { id: 'tdm', name: 'Team Deathmatch', desc: '5v5 · first to 75 kills · respawns on.' },
    { id: 'ctl', name: 'Round Control', desc: '3v3 · one life per round · first to 3 rounds.' },
    { id: 'ffa', name: 'Free For All', desc: '8 solos · no teams · first to 200 kills, anyone can win.' },
    { id: 'gun', name: 'Gun Game', desc: '4 guns · every kill moves you up a gun · finish the ladder first.' }
];
let modeList = FALLBACK_MODES;
let modeId = FALLBACK_MODES[0].id;
const modeListeners = [];

try {
    const stored = localStorage.getItem('nuketown.mode');
    if (stored) modeId = stored;
} catch { /* private mode */ }

function buildModePicker() {
    const host = $('modePick');
    if (!host) return;
    if (!modeList.some(m => m.id === modeId)) modeId = modeList[0].id;
    host.innerHTML = '';
    for (const m of modeList) {
        const d = document.createElement('div');
        d.className = 'mode' + (m.id === modeId ? ' on' : '');
        d.dataset.id = m.id;
        const nm = document.createElement('span');
        nm.className = 'nm'; nm.textContent = m.name || m.id;
        const ds = document.createElement('span');
        ds.className = 'ds'; ds.textContent = m.desc || '';
        d.appendChild(nm); d.appendChild(ds);
        d.addEventListener('click', () => setSelectedMode(m.id));
        host.appendChild(d);
    }
    txt($('menuModeTag'), (selectedModeInfo() || {}).name || '');
}

/** The id of the mode the player picked in the menu. */
export function selectedMode() { return modeId; }
/** The full catalogue entry for the picked mode ({id,name,desc}). */
export function selectedModeInfo() { return modeList.find(m => m.id === modeId) || modeList[0]; }
export function modeCatalogue() { return modeList; }

export function setSelectedMode(id) {
    if (!modeList.some(m => m.id === id)) return;
    modeId = id;
    try { localStorage.setItem('nuketown.mode', id); } catch { /* private mode */ }
    buildModePicker();
    for (const cb of modeListeners) { try { cb(id); } catch (e) { console.warn('[hud] mode listener', e); } }
}

export function onModeChange(cb) { if (typeof cb === 'function') modeListeners.push(cb); }

if ($('modePick')) buildModePicker();
else document.addEventListener('DOMContentLoaded', buildModePicker, { once: true });

import('./modes.js').then(m => {
    if (Array.isArray(m.MODES) && m.MODES.length) { modeList = m.MODES; buildModePicker(); }
}).catch(() => { /* modes.js absent — the fallback list still plays TDM */ });

// ── minimap geometry (canvas backing pixels; CSS size is half this) ─────────
const MINI = 400;
const MINI_HALF = MINI / 2;
const RING_W = 30;                       // compass ring band
const RING_R = MINI_HALF - 3;            // outer edge of the ring
const MAP_R = RING_R - RING_W;           // radius of the map disc
const MINI_SCALE = 4.3;                  // pixels per metre → ~39 m of view
const CARDINALS = ['N', 'E', 'S', 'W'];
const RING_FONT = "600 22px 'Barlow Condensed','Arial Narrow',sans-serif";

// ── weapon type icons (inline, so no network fetch and no image decode) ─────
const WPN_ICONS = {
    rifle: '<rect x="1" y="4" width="25" height="3"/><rect x="26" y="3" width="9" height="2"/>' +
        '<rect x="9" y="7" width="4" height="5"/><rect x="15" y="7" width="3" height="3"/>',
    smg: '<rect x="4" y="4" width="18" height="3"/><rect x="22" y="3.5" width="9" height="2"/>' +
        '<rect x="9" y="7" width="4" height="5"/>',
    sniper: '<rect x="0" y="5" width="33" height="2"/><rect x="12" y="2" width="13" height="2"/>' +
        '<rect x="10" y="7" width="3" height="4"/><rect x="30" y="4" width="6" height="4"/>',
    shotgun: '<rect x="1" y="4" width="27" height="2.6"/><rect x="6" y="7" width="16" height="1.8"/>' +
        '<rect x="28" y="3.4" width="8" height="2"/>',
    pistol: '<rect x="11" y="3" width="15" height="3"/><rect x="13" y="6" width="5" height="6"/>' +
        '<rect x="26" y="3.4" width="4" height="2"/>'
};
const FIRE_SEGS = { SEMI: 1, BOLT: 1, PUMP: 1, BURST: 2, AUTO: 3 };

function wpnIconSVG(type) {
    const body = WPN_ICONS[type] || WPN_ICONS.rifle;
    return `<svg width="30" height="10" viewBox="0 0 36 12" fill="currentColor" aria-hidden="true">${body}</svg>`;
}

export class HUD {
    constructor() {
        this.el = {
            hud: $('hud'),
            chT: $('chT'), chB: $('chB'), chL: $('chL'), chR: $('chR'), chDot: $('chDot'),
            crosshair: $('crosshair'), hitmarker: $('hitmarker'),
            scoreA: $('scoreA'), scoreB: $('scoreB'), barA: $('barA'), barB: $('barB'),
            timer: $('timer'), modeLine: $('modeLine'),
            modeState: $('modeState'), modePrimary: $('modePrimary'), modeSecondary: $('modeSecondary'),
            roundPips: $('roundPips'), pipsA: $('pipsA'), pipsB: $('pipsB'), livesTag: $('livesTag'),
            teamBars: $('teamBars'),
            ntBar: $('ntBar'), ntCount: $('ntCount'), ntTrack: $('nukeTrack'),
            mini: $('miniCanvas'), miniMark: $('miniMark'), uavTag: $('uavTag'),
            hpNum: $('hpNum'), hpFill: $('hpFill'),
            streakCol: $('streakCol'),
            medals: $('medals'),
            streakRun: $('streakRun'),
            wpnName: $('wpnName'), wpnIcon: $('wpnIcon'),
            ammoCur: $('ammoCur'), ammoRes: $('ammoRes'),
            fireMode: $('fireMode'), fireStrip: $('fireStrip'), reloadHint: $('reloadHint'),
            slotRow: $('slots'), slots: document.querySelectorAll('.slot'),
            eqLethal: $('eqLethal'), eqTactical: $('eqTactical'),
            killfeed: $('killfeed'), eventFeed: $('eventFeed'),
            damageVig: $('damageVig'), lowHp: $('lowHp'), dmgDirs: $('dmgDirs'),
            flash: $('screenFlash'), scope: $('scope'),
            death: $('death'), deathBy: $('deathBy'), deathWpn: $('deathWpn'),
            respawn: $('respawn'), respawnNum: $('respawnNum'), respawnBar: $('respawnBar'),
            end: $('end'), endTitle: $('endTitle'), endSub: $('endSub'),
            board: $('board'), rowsA: $('rowsA'), rowsB: $('rowsB'), btA: $('btA'), btB: $('btB'),
            nukeSeq: $('nukeSeq'), nukeCount: $('nukeCount')
        };
        this.mctx = this.el.mini ? this.el.mini.getContext('2d') : null;

        // nuke tracker segments
        this.segs = [];
        if (this.el.ntBar) {
            this.el.ntBar.innerHTML = '';
            for (let i = 0; i < NUKE_NEED; i++) {
                const s = document.createElement('i');
                this.el.ntBar.appendChild(s);
                this.segs.push(s);
            }
        }

        // killstreak tiles — vertical column on the right edge
        this.streakEls = {};
        if (this.el.streakCol) {
            this.el.streakCol.innerHTML = '';
            for (const s of STREAKS) {
                const d = document.createElement('div');
                d.className = 'stk';
                d.innerHTML = `<span class="ky">${s.key ? s.key.replace('Key', '') : ''}</span>` +
                    `<span class="ic">${s.icon}</span>` +
                    `<span class="nm">${s.label.split(' ')[0]}</span>` +
                    `<span class="pg">0/${s.need}</span>`;
                d.title = `${s.label} — ${s.need} kills`;
                d.dataset.id = s.id;
                this.el.streakCol.appendChild(d);
                this.streakEls[s.id] = d;
            }
        }

        this.hmTimer = 0;
        this.dmgTimer = 0;
        this.dirs = [];
        this.lastFireFlash = new Map();
        this.boardOpen = false;

        this.mode = null;
        this.scoreLimit = 75;
        this.streaksOn = true;
        this.equip = {
            lethal: { label: 'Frag', icon: '✸', count: 1 },
            tactical: { label: 'Stun', icon: '◎', count: 2 }
        };
        this._resetCaches();
        this.setEquipment(this.equip.lethal, this.equip.tactical);
    }

    _resetCaches() {
        this._lastWpn = -1;
        this._lastAmmo = -1;
        this._lastRes = -1;
        this._ammoCol = '';
        this._lastSec = -1;
        this._lastHp = -1;
        this._gap = -1;
        this._lastLives = null;
        this._lastA = -1;
        this._lastB = -1;
        this._lastSlot = -1;
    }

    // ── lifecycle ───────────────────────────────────────────────────────────
    show(on) {
        if (this.el.hud) this.el.hud.classList.toggle('on', on);
        if (on) this.reset();
    }

    /** Drop anything that accumulated during the last match. */
    reset() {
        if (this.el.killfeed) this.el.killfeed.innerHTML = '';
        if (this.el.eventFeed) this.el.eventFeed.innerHTML = '';
        for (const d of this.dirs) d.el.remove();
        this.dirs.length = 0;
        this.lastFireFlash.clear();
        this.hmTimer = 0;
        this.dmgTimer = 0;
        if (this.el.hitmarker) this.el.hitmarker.style.opacity = 0;
        if (this.el.damageVig) this.el.damageVig.style.opacity = 0;
        this._resetCaches();
    }

    onStreakClick(cb) {
        for (const id in this.streakEls) {
            this.streakEls[id].addEventListener('click', () => cb(id));
        }
    }

    /** Tell the HUD which Mode object is running so it can label and query it. */
    setMode(mode) {
        this.mode = mode || null;
        const info = selectedModeInfo();
        txt(this.el.modeLine, (mode && mode.name) || (info && info.name) || 'Team Deathmatch');
        if (mode && Number.isFinite(mode.scoreLimit) && mode.scoreLimit > 0) this.scoreLimit = mode.scoreLimit;
        if (mode) this.setKillstreaksEnabled(mode.usesKillstreaks !== false);
        // Which panels belong to this mode, applied now rather than on the next HUD
        // frame: a teamless match should not open with two blue-vs-red bars, and a
        // page whose loop is throttled (background tab, headless run) would sit on
        // whatever the previous mode left behind.
        this._modePanels(mode, this._modeRounds(mode));
    }

    /** A mode's `rounds` block, if it publishes one. Cheap, and only at match start. */
    _modeRounds(mode) {
        if (!mode || typeof mode.hudState !== 'function') return null;
        try { const ms = mode.hudState(); return ms && ms.rounds ? ms : null; } catch { return null; }
    }

    /** Team bars vs round pips — the two panels a mode owns or does not. */
    _modePanels(mode, ms) {
        const rounds = ms && ms.rounds;
        const soloMode = !!(mode && mode.noTeams);
        this.el.roundPips.classList.toggle('on', !!rounds);
        // Two blue-vs-red bars would be a lie in a mode with no teams; the mode
        // line already carries "ME 12 / 200" and the rival count.
        this.el.teamBars.classList.toggle('hidden', !!rounds || soloMode);
    }

    setScoreLimit(n) { if (Number.isFinite(n) && n > 0) this.scoreLimit = n; }

    setKillstreaksEnabled(on) {
        this.streaksOn = !!on;
        if (this.el.streakCol) this.el.streakCol.classList.toggle('hidden', !on);
        if (this.el.ntTrack) this.el.ntTrack.classList.toggle('hidden', !on);
    }

    /** Each argument is {label, icon, count}; anything missing keeps its value. */
    setEquipment(lethal, tactical) {
        this._equipSlot(this.el.eqLethal, this.equip.lethal, lethal);
        this._equipSlot(this.el.eqTactical, this.equip.tactical, tactical);
    }

    _equipSlot(host, store, next) {
        if (next) {
            if (next.label !== undefined) store.label = next.label;
            if (next.icon !== undefined) store.icon = next.icon;
            if (next.count !== undefined) store.count = next.count;
        }
        if (!host) return;
        txt(host.querySelector('.ic'), store.icon);
        txt(host.querySelector('.lb'), store.label);
        txt(host.querySelector('.ct'), store.count);
        host.classList.toggle('empty', !store.count);
    }

    // ── per frame ───────────────────────────────────────────────────────────
    update(dt, s) {
        if (!s || !s.player) return;
        const player = s.player;
        const bots = s.bots || EMPTY;
        const killstreaks = s.killstreaks;
        const teamA = s.teamA | 0, teamB = s.teamB | 0;

        // health
        const hp = Math.max(0, Math.ceil(player.health));
        if (hp !== this._lastHp) {
            this._lastHp = hp;
            this.el.hpNum.innerHTML = `${hp}<small>HP</small>`;
            const frac = player.maxHealth ? player.health / player.maxHealth : 0;
            this.el.hpFill.style.width = (frac * 100).toFixed(1) + '%';
            const col = player.health > 65 ? '#ffffff' : player.health > 30 ? '#FFB833' : '#FF4040';
            this.el.hpFill.style.background = col;
            this.el.hpNum.style.color = col;
        }
        this.el.lowHp.style.opacity = player.health < 38 && player.alive
            ? (0.35 + Math.sin(performance.now() * 0.006) * 0.22) * (1 - player.health / 38) : 0;

        // ammo — name, icon and firemode only change when the weapon changes
        const def = WEAPON_DEFS[player.current] || WEAPON_DEFS[0];
        const mag = player.weapons ? player.weapons[player.current] : null;
        if (def && player.current !== this._lastWpn) {
            this._lastWpn = player.current;
            txt(this.el.wpnName, def.name);
            if (this.el.wpnIcon) this.el.wpnIcon.innerHTML = wpnIconSVG(def.type);
            txt(this.el.fireMode, def.fireMode);
            const lit = FIRE_SEGS[def.fireMode] || 1;
            if (this.el.fireStrip) {
                const segs = this.el.fireStrip.querySelectorAll('i');
                for (let i = 0; i < segs.length; i++) segs[i].classList.toggle('f', i < lit);
            }
        }
        if (mag) {
            if (mag.ammo !== this._lastAmmo) { this._lastAmmo = mag.ammo; this.el.ammoCur.textContent = mag.ammo; }
            if (mag.reserve !== this._lastRes) { this._lastRes = mag.reserve; this.el.ammoRes.textContent = mag.reserve; }
            const col = mag.reloading ? '#FFB833' : mag.ammo === 0 ? '#FF4040'
                : (def && mag.ammo <= def.magSize * 0.25) ? '#FFB833' : '#fff';
            if (col !== this._ammoCol) { this._ammoCol = col; this.el.ammoCur.style.color = col; }
            this.el.reloadHint.classList.toggle('on', mag.ammo === 0 && !mag.reloading && mag.reserve > 0);
        }
        if (player.current !== this._lastSlot) {
            this._lastSlot = player.current;
            this.el.slots.forEach((el, i) => el.classList.toggle('on', i === player.current));
            if (this.el.slotRow) {
                // Only meaningful for the four-weapon loadout — Gun Game hands
                // out one gun at a time off a 15-long ladder.
                const n = player.weapons ? player.weapons.length : 4;
                this.el.slotRow.classList.toggle('hidden', n < 2 || n > this.el.slots.length);
            }
        }
        if (player.equipment) this.setEquipment(player.equipment.lethal, player.equipment.tactical);

        // mode-driven state, falling back to the team score bars
        this._modeHud(s, teamA, teamB);

        // timer
        const secs = Number.isFinite(s.timeLeft) ? Math.max(0, Math.floor(s.timeLeft)) : -1;
        if (secs !== this._lastSec) {
            this._lastSec = secs;
            if (secs < 0) txt(this.el.timer, '∞');
            else txt(this.el.timer, `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')}`);
            this.el.timer.classList.toggle('low', secs >= 0 && secs <= 30);
        }

        // crosshair
        const gap = 7 + player.spread * 26 + (player.isADS ? -4 : 0);
        if (Math.abs(gap - this._gap) > 0.2) {
            this._gap = gap;
            this.el.chT.style.transform = `translateY(${-gap - 9}px)`;
            this.el.chB.style.transform = `translateY(${gap}px)`;
            this.el.chL.style.transform = `translateX(${-gap - 9}px)`;
            this.el.chR.style.transform = `translateX(${gap}px)`;
        }
        const showCH = player.alive && !(def && def.scope && player.isADS && s.scopeAmount > 0.9);
        this.el.crosshair.style.opacity = showCH ? 1 : 0;

        // killstreaks
        if (this.streaksOn && killstreaks && killstreaks.progress) {
            const nk = Math.min(player.matchKills, NUKE_NEED);
            if (this.el.ntCount) this.el.ntCount.innerHTML = `<b>${nk}</b> / ${NUKE_NEED} KILLS`;
            for (let i = 0; i < this.segs.length; i++) this.segs[i].classList.toggle('f', i < nk);
            if (this.el.ntTrack) this.el.ntTrack.classList.toggle('ready', killstreaks.progress('nuke').ready);

            for (const st of STREAKS) {
                const el = this.streakEls[st.id];
                if (!el) continue;
                const p = killstreaks.progress(st.id);
                // a mode may switch a reward off entirely — hide it rather than
                // show a tile that can never fill
                if (p.enabled === false) { el.style.display = 'none'; continue; }
                el.style.display = '';
                const used = killstreaks.used ? killstreaks.used[st.id] : false;
                el.classList.toggle('ready', p.ready);
                el.classList.toggle('used', !!used);
                txt(el.querySelector('.pg'), used ? 'USED' : `${p.have}/${p.need}`);
            }
            // the nuke progress bar goes with it
            if (this.el.ntTrack) {
                const nukeOn = killstreaks.isEnabled ? killstreaks.isEnabled('nuke') : true;
                this.el.ntTrack.style.display = nukeOn ? '' : 'none';
            }
        }

        this.el.uavTag.style.display = s.uav ? 'block' : 'none';

        this._minimap(player, bots, s.uav);

        // timers
        if (this.hmTimer > 0) {
            this.hmTimer -= dt;
            if (this.hmTimer <= 0) this.el.hitmarker.style.opacity = 0;
        }
        if (this.dmgTimer > 0) {
            this.dmgTimer -= dt;
            this.el.damageVig.style.opacity = Math.min(0.85, this.dmgTimer * 2.2);
            if (this.dmgTimer <= 0) this.el.damageVig.style.opacity = 0;
        }
        for (let i = this.dirs.length - 1; i >= 0; i--) {
            const d = this.dirs[i];
            d.life -= dt;
            if (d.life <= 0) { d.el.remove(); this.dirs.splice(i, 1); }
            else d.el.style.opacity = Math.min(1, d.life * 1.6);
        }
    }

    // ── mode state: pips + lives, or the score bars ──────────────────────────
    _modeHud(s, teamA, teamB) {
        let ms = s.modeState;
        if (!ms) {
            const m = s.mode || this.mode;
            if (m && typeof m.hudState === 'function') {
                try { ms = m.hudState(); } catch (e) { ms = null; void e; }
            }
        }

        if (ms) {
            txt(this.el.modePrimary, ms.primary || '');
            txt(this.el.modeSecondary, ms.secondary || '');
            this.el.modeState.classList.toggle('on', !!(ms.primary || ms.secondary));
        } else {
            this.el.modeState.classList.remove('on');
        }

        const rounds = ms && ms.rounds;
        this._modePanels(s.mode || this.mode, ms);

        if (rounds) {
            const a = rounds.a | 0, b = rounds.b | 0;
            const need = Math.max(3, a, b);
            this._pips(this.el.pipsA, need, a);
            this._pips(this.el.pipsB, need, b);
            const lives = ms.lives;
            if (lives !== this._lastLives) {
                this._lastLives = lives;
                txt(this.el.livesTag, lives === undefined || lives === null ? '' : `${lives} alive`);
            }
            return;
        }

        // score bars
        const limit = Number.isFinite(this.scoreLimit) && this.scoreLimit > 0
            ? this.scoreLimit : Math.max(20, teamA, teamB);
        if (teamA !== this._lastA) {
            this._lastA = teamA;
            this.el.scoreA.textContent = teamA;
            this.el.barA.style.width = Math.min(100, teamA / limit * 100).toFixed(1) + '%';
        }
        if (teamB !== this._lastB) {
            this._lastB = teamB;
            this.el.scoreB.textContent = teamB;
            this.el.barB.style.width = Math.min(100, teamB / limit * 100).toFixed(1) + '%';
        }
        if (this._lastLives !== null) { this._lastLives = null; txt(this.el.livesTag, ''); }
    }

    _pips(host, n, filled) {
        if (!host) return;
        while (host.childElementCount > n) host.lastChild.remove();
        while (host.childElementCount < n) host.appendChild(document.createElement('i'));
        const kids = host.children;
        for (let i = 0; i < n; i++) kids[i].classList.toggle('f', i < filled);
    }

    /** Flag a bot as having just fired so it blips on the minimap. */
    noteEnemyFire(bot) {
        const now = performance.now();
        this.lastFireFlash.set(bot, now);
        // Bots are replaced every match, so the map must be pruned or it pins
        // dead soldiers in memory for the whole session.
        if (this.lastFireFlash.size > 24) {
            for (const [k, t] of this.lastFireFlash) if (now - t > 2500) this.lastFireFlash.delete(k);
        }
    }

    // ── minimap ─────────────────────────────────────────────────────────────
    _minimap(player, bots, uav) {
        const c = this.mctx;
        if (!c) return;
        const half = MINI_HALF;
        const px = player.position.x, pz = player.position.z;
        const rot = player.yaw;                 // rotate the world so the player faces up
        const cs = Math.cos(rot), sn = Math.sin(rot);

        c.clearRect(0, 0, MINI, MINI);
        this._ring(c, rot);

        // ── map disc ──
        c.save();
        c.beginPath(); c.arc(half, half, MAP_R, 0, TAU); c.clip();

        c.fillStyle = 'rgba(13,18,16,0.88)';
        c.fillRect(0, 0, MINI, MINI);

        c.translate(half, half);
        c.rotate(rot);                          // yaw 0 (facing -Z) points up
        c.translate(-px * MINI_SCALE, -pz * MINI_SCALE);
        c.scale(MINI_SCALE, MINI_SCALE);

        // cul-de-sac, if the map data describes one
        const circ = MINIMAP.circle;
        if (circ) {
            c.fillStyle = 'rgba(80,84,88,0.55)';
            c.beginPath(); c.arc(circ.x || 0, circ.z || 0, circ.r || 12.5, 0, TAU); c.fill();
        }

        const r = MINIMAP.road;
        if (r) {
            c.fillStyle = 'rgba(80,84,88,0.55)';
            c.fillRect(r.x0, r.z0, r.x1 - r.x0, r.z1 - r.z0);
            c.strokeStyle = 'rgba(220,200,90,0.26)';
            c.lineWidth = 0.16; c.setLineDash([2, 2]);
            c.beginPath();
            // centre line down the long axis of the road
            if (Math.abs(r.x1 - r.x0) >= Math.abs(r.z1 - r.z0)) {
                const mz = (r.z0 + r.z1) / 2;
                c.moveTo(r.x0, mz); c.lineTo(r.x1, mz);
            } else {
                const mx = (r.x0 + r.x1) / 2;
                c.moveTo(mx, r.z0); c.lineTo(mx, r.z1);
            }
            c.stroke();
            c.setLineDash([]);
        }

        for (const q of (MINIMAP.rects || EMPTY)) {
            const x = Math.min(q.x0, q.x1), z = Math.min(q.z0, q.z1);
            const w = Math.abs(q.x1 - q.x0), h = Math.abs(q.z1 - q.z0);
            if (q.k === 'house') { c.fillStyle = 'rgba(140,132,110,0.5)'; c.strokeStyle = 'rgba(255,255,255,0.4)'; }
            else if (q.k === 'garage') { c.fillStyle = 'rgba(110,106,96,0.45)'; c.strokeStyle = 'rgba(255,255,255,0.26)'; }
            else if (q.k === 'vehicle') { c.fillStyle = 'rgba(190,160,60,0.5)'; c.strokeStyle = 'rgba(255,255,255,0.24)'; }
            else { c.fillStyle = 'rgba(120,116,104,0.3)'; c.strokeStyle = 'rgba(255,255,255,0.18)'; }
            c.fillRect(x, z, w, h);
            c.lineWidth = 0.18;
            c.strokeRect(x, z, w, h);
        }

        const fences = MINIMAP.fences || EMPTY;
        if (fences.length) {
            c.strokeStyle = 'rgba(255,255,255,0.16)'; c.lineWidth = 0.16;
            c.beginPath();
            for (const f of fences) { c.moveTo(f[0], f[1]); c.lineTo(f[2], f[3]); }
            c.stroke();
        }

        if (MAP_BOUNDS) {
            c.strokeStyle = 'rgba(255,255,255,0.10)'; c.lineWidth = 0.3;
            c.strokeRect(MAP_BOUNDS.minX, MAP_BOUNDS.minZ,
                MAP_BOUNDS.maxX - MAP_BOUNDS.minX, MAP_BOUNDS.maxZ - MAP_BOUNDS.minZ);
        }

        c.restore();

        // ── entities (screen space so icons stay upright-ish) ──
        const now = performance.now();
        const edge = MAP_R - 8;
        // A teamless mode has no friendlies to draw blue, and no UAV will ever
        // light the lobby up — killstreaks are off there — so without this the
        // radar would show nothing but gunfire for the whole match.
        const solo = !!player.allHostile;
        for (const b of bots) {
            if (!b.alive) continue;
            const friendly = !solo && b.team === player.team;
            const flashed = now - (this.lastFireFlash.get(b) || -1e9) < 1800;
            if (!friendly && !uav && !flashed && !solo) continue;
            const dx = (b.position.x - px) * MINI_SCALE, dz = (b.position.z - pz) * MINI_SCALE;
            const sx = half + dx * cs - dz * sn, sy = half + dx * sn + dz * cs;
            if (Math.hypot(sx - half, sy - half) > edge) continue;
            c.save();
            c.translate(sx, sy);
            c.rotate(b.yaw - player.yaw + Math.PI);
            c.fillStyle = friendly ? '#4FA8FF' : (flashed && !uav ? 'rgba(255,77,77,0.75)' : '#FF4D4D');
            c.beginPath();
            c.moveTo(0, -6); c.lineTo(4.6, 5); c.lineTo(0, 2.4); c.lineTo(-4.6, 5);
            c.closePath(); c.fill();
            if (b.position.y > 2.5) { c.fillStyle = '#fff'; c.fillRect(-1, -9.5, 2, 2); }
            c.restore();
        }

        // player + view cone
        c.save();
        c.translate(half, half);
        const g = c.createRadialGradient(0, 0, 2, 0, 0, 52);
        g.addColorStop(0, 'rgba(255,255,255,0.20)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, 52, -Math.PI / 2 - 0.62, -Math.PI / 2 + 0.62); c.closePath(); c.fill();
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.moveTo(0, -8); c.lineTo(5.5, 6); c.lineTo(0, 3); c.lineTo(-5.5, 6);
        c.closePath(); c.fill();
        c.restore();
    }

    /**
     * Compass ring. A bearing b sits at clockwise screen angle (yaw + b), which
     * puts the player's own heading under the fixed marker at the top.
     */
    _ring(c, rot) {
        const cx = MINI_HALF, cy = MINI_HALF;
        const mid = RING_R - RING_W / 2;

        c.beginPath(); c.arc(cx, cy, mid, 0, TAU);
        c.lineWidth = RING_W; c.strokeStyle = 'rgba(6,10,9,0.88)'; c.stroke();

        c.lineWidth = 2; c.strokeStyle = 'rgba(255,255,255,0.24)';
        c.beginPath(); c.arc(cx, cy, RING_R, 0, TAU); c.stroke();
        c.lineWidth = 1.5; c.strokeStyle = 'rgba(255,255,255,0.13)';
        c.beginPath(); c.arc(cx, cy, MAP_R, 0, TAU); c.stroke();

        // minor ticks every 15°
        c.beginPath();
        for (let b = 0; b < 360; b += 15) {
            if (b % 45 === 0) continue;
            const a = rot + b * DEG, sa = Math.sin(a), ca = Math.cos(a);
            c.moveTo(cx + sa * (RING_R - 4), cy - ca * (RING_R - 4));
            c.lineTo(cx + sa * (RING_R - 10), cy - ca * (RING_R - 10));
        }
        c.lineWidth = 1.6; c.strokeStyle = 'rgba(255,255,255,0.32)'; c.stroke();

        // intercardinal ticks
        c.beginPath();
        for (let b = 45; b < 360; b += 90) {
            const a = rot + b * DEG, sa = Math.sin(a), ca = Math.cos(a);
            c.moveTo(cx + sa * (RING_R - 3), cy - ca * (RING_R - 3));
            c.lineTo(cx + sa * (RING_R - 15), cy - ca * (RING_R - 15));
        }
        c.lineWidth = 2; c.strokeStyle = 'rgba(255,255,255,0.5)'; c.stroke();

        // N / E / S / W, glyph up pointing outward
        c.font = RING_FONT;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        for (let i = 0; i < 4; i++) {
            const a = rot + i * 90 * DEG;
            c.save();
            c.translate(cx + Math.sin(a) * mid, cy - Math.cos(a) * mid);
            c.rotate(a);
            c.fillStyle = i === 0 ? 'rgba(255,138,52,0.98)' : 'rgba(255,255,255,0.88)';
            c.fillText(CARDINALS[i], 0, 1);
            c.restore();
        }
    }

    // ── feedback ────────────────────────────────────────────────────────────
    hitmarker(kill, head) {
        const h = this.el.hitmarker;
        h.style.opacity = 1;
        const col = kill ? '#FF3A2A' : head ? '#FFC24A' : '#fff';
        h.querySelectorAll('i').forEach(i => {
            i.style.background = col;
            i.style.height = (kill ? 13 : head ? 12 : 10) + 'px';
        });
        this.hmTimer = kill ? 0.32 : 0.16;
    }

    hurt() {
        this.dmgTimer = 0.38;
        this.el.damageVig.style.opacity = 0.8;
    }

    damageDirection(rel) {
        // hard cap: a burst of hits must not pile up DOM nodes
        while (this.dirs.length >= 6) {
            const old = this.dirs.shift();
            old.el.remove();
        }
        const d = document.createElement('div');
        d.className = 'dmgDir';
        d.style.transform = `rotate(${rel}rad)`;
        d.innerHTML = '<i></i>';
        this.el.dmgDirs.appendChild(d);
        this.dirs.push({ el: d, life: 1.5 });
    }

    killfeed(killer, victim, weapon, mine, head) {
        const e = document.createElement('div');
        e.className = 'kf' + (mine ? ' mine' : '');
        const kc = mine ? '#FF9A3C' : (killer === '—' ? '#aaa' : '#FF7A7A');
        e.innerHTML = `<span class="n" style="color:${kc}">${killer}</span>` +
            `<span class="w">${weapon}</span>` +
            (head ? '<span class="hs">◉</span>' : '') +
            `<span class="n" style="color:rgba(255,255,255,.75)">${victim}</span>`;
        this.el.killfeed.appendChild(e);
        setTimeout(() => e.remove(), 5000);
        while (this.el.killfeed.children.length > 6) this.el.killfeed.firstChild.remove();
    }

    /**
     * The kill confirmation stack — KILL / HEADSHOT / DOUBLE KILL / TRIPLE KILL /
     * MULTI KILL — centred just above the crosshair and revealed one at a time,
     * ~110 ms apart, so a triple lands as a beat rather than a wall of text.
     *
     * Each entry removes itself, so there is nothing to tick per frame and no
     * queue to keep in sync with the game.
     */
    medals(list) {
        const host = this.el.medals;
        if (!host || !list || !list.length) return;
        for (let i = 0; i < list.length; i++) {
            const m = list[i];
            const d = document.createElement('div');
            d.className = 'medal' + (m.id === 'kill' ? ' base' : '');
            d.style.color = m.tone || '#fff';
            d.style.animationDelay = `${(i * 0.11).toFixed(2)}s, ${(1.05 + i * 0.11).toFixed(2)}s`;
            d.innerHTML = m.label + (m.sub ? `<small>${m.sub}</small>` : '');
            host.appendChild(d);
            setTimeout(() => d.remove(), 1600 + i * 110);
            while (host.children.length > 5) host.firstChild.remove();
        }
    }

    clearMedals() {
        const host = this.el.medals;
        if (host) host.innerHTML = '';
    }

    /**
     * The streak strip: how many in a row, what that is called, and how far to
     * the next name. Called on kills and on death — never from the frame loop.
     */
    streakRun(streak, label, progress) {
        const host = this.el.streakRun;
        if (!host) return;
        if (!streak || streak < 2) { this._streakShown = -1; host.classList.remove('on'); return; }
        if (this._streakShown === streak) return;
        this._streakShown = streak;
        const p = Math.max(0, Math.min(1, progress || 0));
        host.innerHTML = `<b>&times;${streak}</b><span>${label || 'KILL STREAK'}</span>` +
            `<i style="transform:scaleX(${p.toFixed(3)})"></i>`;
        host.classList.add('on');
    }

    banner(title, color, sub) {
        const e = document.createElement('div');
        e.className = 'evt';
        e.style.color = color || '#fff';
        e.innerHTML = title + (sub ? `<small>${sub}</small>` : '');
        this.el.eventFeed.appendChild(e);
        setTimeout(() => e.remove(), 1700);
        while (this.el.eventFeed.children.length > 3) this.el.eventFeed.firstChild.remove();
    }

    scope(amount) {
        this.el.scope.style.display = amount > 0.02 ? 'block' : 'none';
        this.el.scope.style.opacity = amount;
    }

    flash(alpha, ms) {
        this.el.flash.style.transition = 'none';
        this.el.flash.style.opacity = alpha;
        requestAnimationFrame(() => {
            this.el.flash.style.transition = `opacity ${ms}ms ease-out`;
            this.el.flash.style.opacity = 0;
        });
    }

    // ── nuke ────────────────────────────────────────────────────────────────
    nukeSequence() {
        this.el.nukeSeq.classList.add('on');
        this.el.nukeCount.textContent = '5';
        this.banner('TACTICAL NUKE', '#FF3B15', 'Warhead armed');
    }

    /** Driven from the killstreak timer, not wall-clock, so it cannot desync. */
    nukeCountdown(secondsLeft) {
        const n = Math.ceil(secondsLeft);
        txt(this.el.nukeCount, n > 0 ? n : '');
    }

    nukeFlash() {
        this.el.nukeSeq.classList.remove('on');
        this.flash(1, 2600);
    }

    // ── overlays ────────────────────────────────────────────────────────────
    showDeath(by, weapon) {
        // re-trigger the entry animation on every death
        this.el.death.classList.remove('on');
        void this.el.death.offsetWidth;
        this.el.deathBy.innerHTML = by && by !== '—'
            ? `Killed by <b>${by}</b>` : 'You were eliminated';
        txt(this.el.deathWpn, weapon || '');
        this.el.death.classList.add('on');
        this._respawnTotal = 0;
    }

    respawnCountdown(t, total) {
        if (total && !this._respawnTotal) this._respawnTotal = total;
        const tot = this._respawnTotal || 4;
        txt(this.el.respawnNum, Math.max(0, Math.ceil(t)));
        this.el.respawnBar.style.width = (100 * (1 - Math.max(0, t) / tot)).toFixed(1) + '%';
        txt(this.el.respawn, t > 0 ? 'Respawning' : 'Deploying');
    }

    /** Round modes spectate instead of respawning — hide the countdown block. */
    setRespawnVisible(on) {
        const w = $('respawnWrap');
        if (w) w.classList.toggle('hidden', !on);
    }

    hideDeath() { this.el.death.classList.remove('on'); }

    /**
     * Spectator banner. Pass null to clear it.
     * Also drives the skip-round button, which is only meaningful while dead.
     */
    spectate(name, count) {
        const box = $('spectate'), skip = $('skipRound');
        if (!name) {
            if (box) box.classList.remove('on');
            if (skip) skip.classList.remove('on');
            return;
        }
        if (box) {
            box.classList.add('on');
            const n = $('specName');
            if (n && n.dataset.who !== name) {
                n.dataset.who = name;
                n.innerHTML = `Spectating <b>${name}</b>`;
            }
            const h = $('specHint');
            if (h) h.textContent = count > 1 ? 'Click to switch operator' : 'Last operator standing';
        }
        if (skip) skip.classList.add('on');
    }

    /** `result` is the mode's result() object: {title, subtitle}. Optional. */
    showEnd(won, player, result) {
        txt(this.el.endTitle, (result && result.title) || (won ? 'Victory' : 'Defeat'));
        this.el.endTitle.style.color = won ? '#5AD469' : '#FF4D4D';
        if (result && result.subtitle) txt(this.el.endSub, result.subtitle);
        else {
            const info = this.mode || selectedModeInfo();
            txt(this.el.endSub, `${(info && info.name) || 'Team Deathmatch'} — Nuketown`);
        }
        $('esK').textContent = player.kills;
        $('esD').textContent = player.deaths;
        $('esR').textContent = (player.kills / Math.max(1, player.deaths)).toFixed(2);
        $('esH').textContent = player.headshots;
        $('esS').textContent = Math.max(player.longestStreak, player.killStreak);
        this.el.end.classList.add('on');
    }

    hideEnd() { this.el.end.classList.remove('on'); }

    /**
     * Team modes get two squads side by side. Free For All and Gun Game pass a
     * `mode` with no teams, and get one sorted table instead — with the tag the
     * mode supplies (kills to the target, or the rung of the ladder).
     */
    scoreboard(open, player, bots, teamA, teamB, mode) {
        this.el.board.classList.toggle('on', open);
        if (!open) return;

        const solo = mode && mode.standings && mode.noTeams ? mode.standings() : null;
        if (solo) {
            this.el.board.classList.toggle('solo', true);
            this.el.btA.textContent = solo.title;
            this.el.btB.textContent = '';
            let html = `<div class="brow hd"><span>${solo.columns[0]}</span><span>${solo.columns[1]}</span>` +
                `<span>${solo.columns[2]}</span><span>${solo.columns[3]}</span><span></span></div>`;
            for (const r of solo.rows) {
                html += `<div class="brow${r.me ? ' me' : ''}"><span>${r.name}</span><span>${r.k}</span>` +
                    `<span>${r.d}</span><span>${r.s}</span><span class="tg">${r.tag || ''}</span></div>`;
            }
            this.el.rowsA.innerHTML = html;
            this.el.rowsB.innerHTML = '';
            return;
        }
        this.el.board.classList.toggle('solo', false);
        this.el.btA.textContent = `Team Blue — ${teamA}`;
        this.el.btB.textContent = `Team Red — ${teamB}`;
        const build = (list, host) => {
            let html = '<div class="brow hd"><span>Operator</span><span>K</span><span>D</span><span>A</span><span>Score</span></div>';
            for (const e of list) {
                html += `<div class="brow${e.me ? ' me' : ''}"><span>${e.name}</span><span>${e.k}</span>` +
                    `<span>${e.d}</span><span>${e.a}</span><span>${e.s}</span></div>`;
            }
            host.innerHTML = html;
        };
        const a = [{ name: 'You', k: player.kills, d: player.deaths, a: player.assists, s: player.score, me: true }];
        const b = [];
        for (const bot of bots) {
            const e = { name: bot.name, k: bot.kills, d: bot.deaths, a: bot.assists, s: bot.score };
            (bot.team === player.team ? a : b).push(e);
        }
        a.sort((x, y) => y.s - x.s); b.sort((x, y) => y.s - x.s);
        build(a, this.el.rowsA);
        build(b, this.el.rowsB);
    }

    /** The menu selection, exposed on the instance for convenience. */
    selectedMode() { return selectedMode(); }
}
