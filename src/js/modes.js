// ============================================================================
// modes.js — the three match rulesets.
//
// main.js drives a Mode object instead of hard-coding Team Deathmatch: it asks
// how many bots to spawn, reports kills and deaths, and asks whether an entity
// is allowed to respawn.  Everything a mode reaches into (player, bots, hud,
// effects, scene, audio) arrives through `ctx`, so no mode imports main.
//
// Every Mode also exposes the old TeamDeathmatch surface — teamAScore,
// teamBScore, timeRemaining, matchOver, winner, addKill(), nukeWin(), reset() —
// because killstreaks.js and the HUD still read a game mode that way.
//
// A kill arrives through onKill(killer, victim, weapon, head) and nowhere else:
// main reports it once, and the mode decides what it is worth — a team tally, a
// round, a rung, a match won at 200 kills, or nothing at all.
// ============================================================================
import { TeamDeathmatch, countAlive } from './gamemode.js';
import * as W from './weapons.js';
import { SPAWN_A, SPAWN_B } from './map.js';
import { TEAM_A, TEAM_B } from './utils.js';

export const MODES = [
    { id: 'tdm', name: 'Team Deathmatch', desc: '5v5 · first to 75 kills · respawns on.' },
    { id: 'ctl', name: 'Round Control',   desc: '3v3 · one life per round · first to 3 rounds.' },
    { id: 'ffa', name: 'Free For All',    desc: '8 solos · no teams · first to 200 kills, anyone can win.' },
    { id: 'gun', name: 'Gun Game',        desc: '4 guns · every kill moves you up a gun · finish the ladder first.' }
];

// ── tables ──────────────────────────────────────────────────────────────────
// Namespaced import on purpose: a mode must still load if weapons.js ever drops
// one of these lists, so every table below has a fallback.
const DEFS = W.WEAPON_DEFS || [];
const inRange = i => Number.isInteger(i) && i >= 0 && i < DEFS.length;

const _ladder = (Array.isArray(W.GUN_GAME_LADDER) ? W.GUN_GAME_LADDER : []).filter(inRange);
const LADDER = _ladder.length ? _ladder : DEFS.map((_, i) => i);

const _pool = (Array.isArray(W.BOT_WEAPON_POOL) ? W.BOT_WEAPON_POOL : [0, 1, 2, 3]).filter(inRange);
const BOT_POOL = _pool.length ? _pool : [0];

// Used only if map.js hands back empty spawn lists — never in a healthy build.
const FALLBACK_A = [{ x: -37, z: 0 }];
const FALLBACK_B = [{ x: 37, z: 0 }];
const EMPTY = [];

const FREEZE_TIME = 5.0;       // spec 2.2 — frozen setup at the head of a round
const ROUND_TIME = 90.0;
const ROUND_HOLD = 3.5;        // beat between the last kill and the next round
const ROUNDS_TO_WIN = 3;       // best of five

function spawnPoint(team, i) {
    const list = team === TEAM_B
        ? (SPAWN_B && SPAWN_B.length ? SPAWN_B : FALLBACK_B)
        : (SPAWN_A && SPAWN_A.length ? SPAWN_A : FALLBACK_A);
    return list[i % list.length];
}

function mmss(t) {
    if (!isFinite(t)) return '--:--';
    const s = Math.max(0, Math.ceil(t));
    return `${(s / 60) | 0}:${String(s % 60).padStart(2, '0')}`;
}

// ── base ────────────────────────────────────────────────────────────────────
class BaseMode {
    constructor(meta, ctx, opts) {
        this.id = meta.id;
        this.name = meta.name;
        this.desc = meta.desc;
        this.ctx = ctx || {};

        this.teamSize = opts.teamSize;          // soldiers per team, human included
        this.botsA = Math.max(0, opts.teamSize - 1);   // the player fills A's last slot
        this.botsB = opts.teamSize;
        this.scoreLimit = opts.scoreLimit;
        this.timeLimit = opts.timeLimit;
        this.usesKillstreaks = opts.usesKillstreaks;

        this.scoring = new TeamDeathmatch(this.scoreLimit, this.timeLimit);

        // Returned by reference every frame — never rebuild these objects, and
        // only rebuild the strings inside them when what they say changes.
        this._hud = {
            primary: '',
            secondary: isFinite(this.scoreLimit) ? `FIRST TO ${this.scoreLimit}` : '',
            rounds: null,
            lives: 0
        };
        this._result = { won: false, title: '', subtitle: '' };
        this._alive = { a: 0, b: 0 };
        this._sec = -1;
    }

    // ── legacy TeamDeathmatch surface ───────────────────────────────────────
    get teamAScore() { return this.scoring.teamAScore; }
    get teamBScore() { return this.scoring.teamBScore; }
    get timeRemaining() { return this.scoring.timeRemaining; }
    get matchOver() { return this.scoring.matchOver; }
    get winner() { return this.scoring.winner; }
    get endReason() { return this.scoring.endReason; }
    addKill(team, n = 1) { this.scoring.addKill(team, n); }
    nukeWin(team) { this.scoring.nukeWin(team); }

    // ── context helpers ─────────────────────────────────────────────────────
    get player() { return this.ctx.player || null; }
    get hud() { return this.ctx.hud || null; }
    bots() {
        const b = this.ctx.getBots && this.ctx.getBots();
        return b && b.length ? b : EMPTY;
    }
    /** The player arrives as either the Player or main's lightweight proxy. */
    isPlayer(e) {
        if (!e) return false;
        const p = this.player;
        return e === p || (p && e.name === p.name) || e.name === 'You';
    }
    banner(title, colour, sub) {
        const h = this.hud;
        if (h && h.banner) h.banner(title, colour, sub);
    }

    // ── lifecycle ───────────────────────────────────────────────────────────
    reset() {
        this.scoring.reset();
        this._sec = -1;
        this._alive.a = this._alive.b = 0;
    }

    onMatchStart() {
        this.reset();
        this.banner(this.name.toUpperCase(), '#FF7A18', this.desc);
    }

    onKill(killer, victim, weapon, isHeadshot) {
        void victim; void weapon; void isHeadshot;
        if (!killer || this.isOver()) return;
        this.scoring.addKill(killer.team === TEAM_B ? TEAM_B : TEAM_A);
    }

    onPlayerDeath() { }

    /**
     * Idempotent: main reports the kill and the per-frame reconcile also spots
     * the corpse, and neither knows about the other.
     */
    onBotDeath(bot) {
        if (!bot || bot._modeAlive === false) return;
        bot._modeAlive = false;
        this._onDeath(bot);
    }

    canRespawn(entity) { void entity; return true; }

    isFrozen() { return false; }

    /**
     * Team modes leave these alone: the scoreboard is two squads and the HUD
     * clock. A mode with no teams sets both, and the HUD/board read them instead
     * of inventing a fake Team Blue / Team Red split for eight solos.
     */
    get noTeams() { return false; }

    /** @returns {{title: string, columns: string[], rows: Array<object>}|null} */
    standings() { return null; }

    /** Everyone in the roster, player first, for modes that tally per person. */
    *entities() {
        const p = this.player;
        if (p) yield p;
        const bots = this.bots();
        for (let i = 0; i < bots.length; i++) if (bots[i]) yield bots[i];
    }

    update(dt) {
        this.scoring.update(dt);
        this._reconcile();
    }

    isOver() { return this.scoring.matchOver; }

    result() {
        const r = this._result;
        r.won = this.scoring.winner === TEAM_A;
        r.title = r.won ? 'VICTORY' : 'DEFEAT';
        r.subtitle = `${this.teamAScore} – ${this.teamBScore} · ${this.scoring.endReason || 'Match over'}`;
        return r;
    }

    hudState() {
        const h = this._hud;
        h.primary = this._clock(this.timeRemaining);
        return h;
    }

    /** mm:ss, rebuilt only when the displayed second actually changes. */
    _clock(t) {
        const s = isFinite(t) ? Math.max(0, Math.ceil(t)) : -1;
        if (s !== this._sec) { this._sec = s; this._clockStr = mmss(t); }
        return this._clockStr;
    }

    // ── bot bookkeeping ─────────────────────────────────────────────────────
    /**
     * ai.js respawns bots on its own schedule and re-rolls a random weapon out
     * of all fifteen when it does. Watching the alive flag lets a mode correct
     * both without reaching into ai.js.
     */
    _reconcile() {
        const bots = this.bots();
        for (let i = 0; i < bots.length; i++) {
            const b = bots[i];
            if (!b) continue;
            if (b.alive) {
                if (b._modeAlive !== true) { b._modeAlive = true; this._onSpawn(b); }
            } else {
                this.onBotDeath(b);
            }
        }
    }

    _onSpawn(bot) { this._giveWeapon(bot); }
    _onDeath(bot) { void bot; }

    _giveWeapon(bot) {
        const idx = BOT_POOL[(Math.random() * BOT_POOL.length) | 0];
        if (bot.setWeapon && bot.weaponIndex !== idx) bot.setWeapon(idx);
    }
}

// ── 2.1 Team Deathmatch ─────────────────────────────────────────────────────
class TeamDeathmatchMode extends BaseMode {
    constructor(meta, ctx) {
        super(meta, ctx, { teamSize: 5, scoreLimit: 75, timeLimit: 600, usesKillstreaks: true });
    }
}

// ── 2.2 Round Control ───────────────────────────────────────────────────────
/**
 * 3v3, one life, best of five. The mode owns the respawn cycle outright:
 * canRespawn() is false for the whole match and everyone is revived and
 * repositioned when the round flips, so main must never respawn anyone here.
 */
class RoundControl extends BaseMode {
    constructor(meta, ctx) {
        super(meta, ctx, { teamSize: 3, scoreLimit: ROUNDS_TO_WIN, timeLimit: Infinity, usesKillstreaks: true });
        // No nuke here. It needs 15 match kills, which in a best-of-five with
        // one life each is most of the players in the entire match — and it
        // would take the round outright the moment it landed.
        this.disabledStreaks = new Set(['nuke']);
        this._playerAnchor = { x: 0, z: 0 };
        this.reset();
    }

    reset() {
        super.reset();
        this.round = 0;
        this.phase = 'freeze';        // freeze | live | over | ended
        this.phaseT = FREEZE_TIME;
        this.roundT = ROUND_TIME;
        this.roundWinner = -1;
        this._armed = false;          // both teams have fielded someone this round
        this._deployed = -1;          // bot count at the last deploy
        this._capKey = null;
        if (!this._hud.rounds) this._hud.rounds = { a: 0, b: 0 };
    }

    // The HUD clock should read the round, not the (infinite) match.
    get timeRemaining() { return this.phase === 'freeze' ? this.phaseT : Math.max(0, this.roundT); }

    onMatchStart() {
        this.reset();
        this.banner('ROUND CONTROL', '#67c6ff', 'One life · first to 3 rounds');
        this._startRound();
    }

    /** Retained for safety: the nuke is disabled in this mode, but if one ever
     *  did land it takes the round, not the match. */
    nukeWin(team) { if (this.phase === 'live') this._endRound(team, 'Tactical nuke'); }

    /**
     * Concede the current round and move straight on. Offered while you are
     * dead and spectating, so a round nobody can still win does not have to be
     * watched out to the 90 second timer.
     */
    skipRound() {
        if (this.phase !== 'live') return false;
        const alive = t => this.bots().filter(b => b.team === t && b.alive).length
            + (t === TEAM_A && this.ctx.player && this.ctx.player.alive ? 1 : 0);
        const a = alive(TEAM_A), b = alive(TEAM_B);
        // whoever still has bodies takes it; a tie goes to the enemy, since it
        // is the player who asked to cut the round short
        this._endRound(a > b ? TEAM_A : TEAM_B, 'Round skipped');
        return true;
    }

    canRespawn() { return false; }

    isFrozen() { return this.phase === 'freeze'; }

    /** Corpses stay put until the round flips. */
    _onDeath(bot) { bot.respawnTimer = Infinity; }

    onPlayerDeath() {
        if (this.phase === 'live') this.banner('ELIMINATED', '#FF4D4D', 'Wait for the next round');
    }

    onKill(killer, victim, weapon, isHeadshot) {
        // Kills do not score in Round Control; rounds do.
        void killer; void victim; void weapon; void isHeadshot;
    }

    update(dt) {
        this._reconcile();
        countAlive(this.player, this.bots(), this._alive);

        if (this.phase === 'freeze') {
            // Bots may be created after onMatchStart; catch them up.
            if (this.bots().length !== this._deployed) this._deploy();
            this.phaseT -= dt;
            this._hold();
            if (this.phaseT <= 0) {
                this.phase = 'live';
                this.banner('FIGHT', '#FFC24A', `Round ${this.round}`);
            }
            return;
        }

        if (this.phase === 'live') {
            this.roundT -= dt;
            if (this._alive.a > 0 && this._alive.b > 0) this._armed = true;
            if (this._armed && this._alive.b <= 0) this._endRound(TEAM_A, 'Enemy team eliminated');
            else if (this._armed && this._alive.a <= 0) this._endRound(TEAM_B, 'Team eliminated');
            else if (this.roundT <= 0) {
                this.roundT = 0;
                // Attackers lose on time; a straight tie goes to the defenders.
                this._endRound(this._alive.b > this._alive.a ? TEAM_B : TEAM_A, 'Time expired');
            }
            return;
        }

        if (this.phase === 'over') {
            this.phaseT -= dt;
            if (this.phaseT <= 0) {
                if (this.scoring.matchOver) this.phase = 'ended';
                else this._startRound();
            }
        }
    }

    // The end screen waits for the round-win banner to land.
    isOver() { return this.scoring.matchOver && this.phase === 'ended'; }

    result() {
        const r = this._result;
        r.won = this.scoring.winner === TEAM_A;
        r.title = r.won ? 'VICTORY' : 'DEFEAT';
        r.subtitle = `Rounds ${this.teamAScore} – ${this.teamBScore}`;
        return r;
    }

    hudState() {
        const h = this._hud;
        h.rounds.a = this.teamAScore;
        h.rounds.b = this.teamBScore;
        h.lives = this._alive.a;
        h.livesA = this._alive.a;
        h.livesB = this._alive.b;
        h.primary = this._clock(this.timeRemaining);

        // Rebuild the caption only when something in it moved.
        const key = this.phase === 'live' ? this.round * 100 + this._alive.a * 10 + this._alive.b
            : this.phase === 'freeze' ? -this.round
            : this.roundWinner - 900;
        if (key !== this._capKey) {
            this._capKey = key;
            h.secondary =
                this.phase === 'freeze' ? `ROUND ${this.round} · GET READY` :
                this.phase === 'live' ? `ROUND ${this.round} · ${this._alive.a}v${this._alive.b}` :
                this.roundWinner === TEAM_A ? 'ROUND WON' : 'ROUND LOST';
        }
        return h;
    }

    // ── round flow ──────────────────────────────────────────────────────────
    _startRound() {
        this.round++;
        this.phase = 'freeze';
        this.phaseT = FREEZE_TIME;
        this.roundT = ROUND_TIME;
        this.roundWinner = -1;
        this._armed = false;
        this._capKey = null;
        this._deploy();
        this.banner(`ROUND ${this.round}`, '#67c6ff', `${this.teamAScore} – ${this.teamBScore}`);
    }

    _endRound(team, reason) {
        this.phase = 'over';
        this.phaseT = ROUND_HOLD;
        this.roundWinner = team;
        this._capKey = null;
        this.scoring.addKill(team);          // scoreLimit is 3, so this can end the match
        const won = team === TEAM_A;
        this.banner(won ? 'ROUND WON' : 'ROUND LOST', won ? '#5AD469' : '#FF4D4D',
            `${reason} · ${this.teamAScore} – ${this.teamBScore}`);
    }

    /** Revive and reposition every entity for a fresh round. */
    _deploy() {
        const p = this.player;
        if (p) {
            const sp = spawnPoint(TEAM_A, 0);
            if (p.respawn) p.respawn(sp);
            this._playerAnchor.x = p.position.x;
            this._playerAnchor.z = p.position.z;
            p.killStreak = 0;
            const h = this.hud;
            if (h && h.hideDeath) h.hideDeath();
        }

        const bots = this.bots();
        let ia = 1, ib = 0;                  // slot 0 on A belongs to the player
        for (let i = 0; i < bots.length; i++) {
            const b = bots[i];
            if (!b) continue;
            const sp = spawnPoint(b.team, b.team === TEAM_B ? ib++ : ia++);
            b.respawnTimer = 0;
            if (b.spawn) b.spawn(sp);
            this._giveWeapon(b);
            b._modeAlive = true;
            b.killStreak = 0;
            if (!b._ctlAnchor) b._ctlAnchor = { x: 0, z: 0 };
            b._ctlAnchor.x = b.position.x;
            b._ctlAnchor.z = b.position.z;
        }
        this._deployed = bots.length;
    }

    /**
     * The 5 s setup. Nobody can move or shoot, but the camera stays live so the
     * player can look around. Held from here — and re-held every frame — so the
     * freeze works even if the loop still ticks players and bots; main can skip
     * those updates outright while isFrozen() is true for a perfect hold.
     */
    _hold() {
        const guard = this.phaseT + 1;
        const p = this.player;
        if (p) {
            for (const k in p.keys) p.keys[k] = false;
            p.mouseDown = false;
            p.isSprinting = false;
            if (p.velocity) p.velocity.set(0, 0, 0);
            // x/z only: gravity still needs to settle them onto the ground.
            p.position.x = this._playerAnchor.x;
            p.position.z = this._playerAnchor.z;
            if (p.spawnProtect < guard) p.spawnProtect = guard;
        }

        const now = performance.now();
        const bots = this.bots();
        for (let i = 0; i < bots.length; i++) {
            const b = bots[i];
            if (!b || !b.alive) continue;
            if (b.velocity) b.velocity.set(0, 0, 0);
            const a = b._ctlAnchor;
            if (a) { b.position.x = a.x; b.position.z = a.z; }
            if (b.spawnProtect < guard) b.spawnProtect = guard;
            // Both gates ai.js checks before it fires; reaction decays into a
            // half-second of hesitation once the round goes live.
            if (b.reaction < guard) b.reaction = guard;
            b.nextShot = now + this.phaseT * 1000 + 500;
            b.stuck = 0;
        }
    }
}

// ── 2.3 Free For All ────────────────────────────────────────────────────────
/**
 * Eight soldiers, no teams, first to `KILL_TARGET` kills.
 *
 * There are only two team ids in this engine, so "no teams" is not expressed by
 * inventing eight of them — the bots keep their blue/red coat for the sake of the
 * rigs and the minimap, and `allHostile` on ai.js does the actual work: every
 * live entity is fair game, including whoever used to be on your side. That is
 * what makes the mode read right: the bots grind each other just as hard as they
 * grind you, so the leaderboard is a race, not a execution queue.
 *
 * No killstreaks, deliberately. The nuke ends a match on the spot, and a streak
 * that can be banked from other people's kills would hand a 15-kill win to
 * whoever hid longest — the 200 the score is asking for would never be reached.
 */
const KILL_TARGET = 200;

class FreeForAll extends BaseMode {
    constructor(meta, ctx) {
        super(meta, ctx, { teamSize: 4, scoreLimit: Infinity, timeLimit: Infinity, usesKillstreaks: false });
        // Every reward off, not just hidden — see the note above.
        this.disabledStreaks = new Set(['uav', 'air', 'nuke']);
        this.target = KILL_TARGET;
        this.champion = '';
        this._capKey = null;
        this.reset();
    }

    reset() {
        super.reset();
        this.champion = '';
        this._capKey = null;
        for (const e of this.entities()) e._ffaPush = undefined;
    }

    get noTeams() { return true; }

    onMatchStart() {
        this.reset();
        this.banner('FREE FOR ALL', '#FF7A18', `First to ${this.target} kills · everybody is the enemy`);
    }

    /** Nothing short of reaching the target ends this match. */
    nukeWin() { }

    onKill(killer, victim) {
        void victim;
        if (!killer || this.isOver()) return;
        const mine = this.isPlayer(killer);
        const killed = mine ? (this.player.kills | 0) : (killer.kills | 0);
        if (killed >= this.target) {
            this.champion = killer.name || 'Operator';
            // The end screen reads a team, so map the winner onto the player's
            // side rather than teach hud.showEnd about a mode with no teams.
            this.scoring.forceEnd(mine ? TEAM_A : TEAM_B, `${this.champion} reached ${this.target}`);
            this.banner(mine ? 'MATCH WON' : 'MATCH LOST',
                mine ? '#5AD469' : '#FF4D4D', `${this.champion} · ${this.target} kills`);
        }
    }

    /**
     * Kill counts arrive from main's own bookkeeping, so the round-by-round
     * reconcile only has to make sure each soldier plays without a team.
     */
    _onSpawn(bot) {
        this._solofy(bot);
        super._onSpawn(bot);
    }

    _solofy(bot) {
        if (!bot || bot.allHostile) return;
        bot.allHostile = true;
        // Half of them push one way, half the other, so eight solos spread down
        // the street instead of all converging on the same corner house.
        if (!bot._ffaPush) {
            bot._ffaPush = this._pushFlip = -(this._pushFlip || 1);
            bot.pushDir = bot._ffaPush;
        }
        // Both spawn clusters, or they would all spawn on one side of the map.
        const both = [...(SPAWN_A && SPAWN_A.length ? SPAWN_A : FALLBACK_A),
            ...(SPAWN_B && SPAWN_B.length ? SPAWN_B : FALLBACK_B)];
        bot.spawnPoints = both;
    }

    update(dt) {
        this.scoring.update(dt);
        this._reconcile();
        // Bots exist before the first reconcile can see them, so coat them at
        // least once per frame until they are all marked. Cheap: a length check.
        if (this._marked !== this.bots().length) this._markAll();
    }

    _markAll() {
        const bots = this.bots();
        for (let i = 0; i < bots.length; i++) this._solofy(bots[i]);
        this._marked = bots.length;
    }

    standings() {
        const rows = [];
        for (const e of this.entities()) {
            rows.push({
                name: this.isPlayer(e) ? 'You' : e.name,
                k: e.kills | 0, d: e.deaths | 0, s: e.score | 0,
                me: this.isPlayer(e),
                tag: `${Math.min(e.kills | 0, this.target)}/${this.target}`
            });
        }
        rows.sort((a, b) => b.k - a.k || a.d - b.d);
        return { title: `FREE FOR ALL · first to ${this.target}`, columns: ['Operator', 'Kills', 'Dead', 'Score'], rows };
    }

    hudState() {
        const h = this._hud;
        const me = this.player ? (this.player.kills | 0) : 0;
        let lead = 0;
        for (const e of this.bots()) if (e && (e.kills | 0) > lead) lead = e.kills | 0;
        const key = me * 1024 + lead;
        if (key !== this._capKey) {
            this._capKey = key;
            h.primary = `ME ${me} / ${this.target}`;
            h.secondary = lead >= me ? `LEADER ${lead} · THEY ARE AHEAD` : `BEST RIVAL ${lead} · ${this.target - me} TO GO`;
        }
        return h;
    }

    result() {
        const r = this._result;
        const me = this.player ? this.player.kills | 0 : 0;
        const best = Math.max(me, ...[...this.bots()].filter(Boolean).map(b => b.kills | 0));
        r.won = me > 0 && me >= best && this.scoring.winner === TEAM_A;
        r.title = r.won ? 'VICTORY' : 'DEFEAT';
        r.subtitle = this.champion
            ? `${this.champion} · ${this.target} kills`
            : `You ${me} · best rival ${best} · first to ${this.target}`;
        return r;
    }
}

// ── 2.4 Gun Game ────────────────────────────────────────────────────────────
/**
 * One kill advances the killer one rung. The ladder index lives on the entity
 * itself rather than in a Map keyed by entities, which would outlive them.
 */
class GunGame extends BaseMode {
    constructor(meta, ctx) {
        super(meta, ctx, { teamSize: 5, scoreLimit: Infinity, timeLimit: Infinity, usesKillstreaks: false });
        // Rewards are off in both senses — hidden, and unusable by key. A nuke
        // would clear the whole enemy team at once, which in this mode is five
        // free rungs, and the match ends on a ladder, not on a streak.
        this.disabledStreaks = new Set(['uav', 'air', 'nuke']);
        this.rungs = LADDER.length;
        this.reset();
    }

    reset() {
        super.reset();
        this._want = -1;              // ladder weapon the player should be holding
        this._elapsed = 0;
        this.champion = '';
        this._capKey = null;
        const p = this.player;
        if (p) p._ggRung = 0;
        const bots = this.bots();
        for (let i = 0; i < bots.length; i++) if (bots[i]) bots[i]._ggRung = 0;
    }

    // No time limit, so the HUD clock counts the match up instead of down.
    get timeRemaining() { return this._elapsed; }

    onMatchStart() {
        this.reset();
        this.banner('GUN GAME', '#FFC24A', `Run all ${this.rungs} weapons · every kill moves you up one`);
        this._equipPlayer(LADDER[0]);
    }

    /**
     * Ten players on two teams would mean the four blues could not shoot each
     * other, so half the ladder would be parked in a corner. Everyone is hostile,
     * which is also what makes "the enemy should do that too" readable: the bots
     * farm each other to climb, exactly like you do.
     */
    _onSpawn(bot) {
        if (bot && !bot.allHostile) {
            bot.allHostile = true;
            const both = [...(SPAWN_A && SPAWN_A.length ? SPAWN_A : FALLBACK_A),
                ...(SPAWN_B && SPAWN_B.length ? SPAWN_B : FALLBACK_B)];
            bot.spawnPoints = both;
        }
        super._onSpawn(bot);
    }

    /** Killstreaks are off, so a nuke can never be called. */
    nukeWin() { }

    get rung() {
        const p = this.player;
        return p ? (p._ggRung | 0) : 0;
    }

    onKill(killer, victim, weapon, isHeadshot) {
        void weapon; void isHeadshot;
        if (!killer || this.isOver()) return;
        // In a team mode a friendly kill must not advance the ladder. There are no
        // teams here, so everyone is a fair rung — that is the whole mode.
        if (!this.noTeams && victim && victim.team === killer.team && victim !== killer) return;
        this.scoring.addKill(killer.team === TEAM_B ? TEAM_B : TEAM_A);

        const mine = this.isPlayer(killer);
        const e = mine ? this.player : killer;
        if (!e) return;

        const next = (e._ggRung | 0) + 1;
        if (next >= LADDER.length) { this._finish(e, mine); return; }
        e._ggRung = next;

        if (mine) {
            this._equipPlayer(LADDER[next]);
            this.banner(`LEVEL ${next + 1}`, '#67c6ff', this._nameAt(next));
        } else if (e.setWeapon) {
            e.setWeapon(LADDER[next]);
            if (next >= LADDER.length - 2) {
                this.banner(`${e.name} IS ON ${next + 1}`, '#FF9A3C', 'Close them out');
            }
        }
    }

    update(dt) {
        this._elapsed += dt;
        this.scoring.update(dt);
        this._reconcile();

        // The switch has to go through the player so the viewmodel swaps with
        // it; requestSwitch refuses mid-swap, so keep asking until it takes.
        const p = this.player;
        if (p && p.alive && this._want >= 0 && p.current !== this._want && p.switchTo) {
            p.switchTo(this._want);
        }
    }

    result() {
        const r = this._result;
        const mine = `you reached ${this.rung + 1}/${this.rungs}`;
        r.won = this.scoring.winner === TEAM_A;
        r.title = r.won ? 'VICTORY' : 'DEFEAT';
        // Only say somebody finished the ladder when somebody else did — a win of
        // your own should not read like a report about someone else.
        const clean = r.won && (!this.champion || this.champion === 'You');
        r.subtitle = clean
            ? `All ${this.rungs} weapons`
            : `${this.champion ? `${this.champion} finished the ladder` : 'Ladder not finished'} · ${mine}`;
        return r;
    }

    hudState() {
        const h = this._hud;
        const r = this.rung;
        if (r !== this._capKey) {
            this._capKey = r;
            h.primary = `${Math.min(r + 1, this.rungs)} / ${this.rungs}`;
            h.secondary = r + 1 < LADDER.length ? `NEXT: ${this._nameAt(r + 1)}` : 'FINAL WEAPON';
        }
        return h;
    }

    get noTeams() { return true; }

    /**
     * Everyone is against everyone here too, so the board is one table — with the
     * rung each rival is on, which is the only way to see the ladder being climbed
     * around you.
     */
    standings() {
        const rows = [];
        for (const e of this.entities()) {
            const rung = Math.min(e._ggRung | 0, this.rungs - 1);
            const d = DEFS[LADDER[rung]];
            rows.push({
                name: this.isPlayer(e) ? 'You' : e.name,
                k: e.kills | 0, d: e.deaths | 0, s: e.score | 0,
                me: this.isPlayer(e),
                tag: `${rung + 1}/${this.rungs} ${d ? d.short : ''}`.trim()
            });
        }
        rows.sort((a, b) => (parseInt(b.tag, 10) || 0) - (parseInt(a.tag, 10) || 0) || b.k - a.k);
        return { title: `GUN GAME · ${this.rungs} weapons`, columns: ['Operator', 'Kills', 'Dead', 'Score'], rows };
    }

    // Bots re-roll a weapon whenever ai.js respawns them — put them back on
    // their rung instead of the Team Deathmatch pool.
    _giveWeapon(bot) {
        const idx = LADDER[Math.min(bot._ggRung | 0, LADDER.length - 1)];
        if (bot.setWeapon && bot.weaponIndex !== idx) bot.setWeapon(idx);
    }

    _nameAt(rung) {
        const d = DEFS[LADDER[rung]];
        return d ? d.name : '—';
    }

    _equipPlayer(idx) {
        const p = this.player;
        if (!p || !inRange(idx)) return;
        this._want = idx;
        // A fresh rung starts loaded; otherwise a promotion mid-firefight hands
        // you a gun with whatever was left in it last time.
        const mag = p.weapons && p.weapons[idx], def = DEFS[idx];
        if (mag && def) { mag.ammo = def.magSize; mag.reserve = def.reserve; mag.reloading = false; }
        if (p.switchTo) p.switchTo(idx);
    }

    _finish(entity, mine) {
        this.champion = entity.name || 'Enemy';
        entity._ggRung = LADDER.length - 1;
        // Winner drives the end screen, so map it onto the player's team.
        this.scoring.forceEnd(mine ? TEAM_A : TEAM_B, 'Ladder complete');
        this.banner(mine ? 'GUN GAME WON' : 'GUN GAME LOST',
            mine ? '#5AD469' : '#FF4D4D', `${this.champion} · ${this.rungs}/${this.rungs}`);
    }
}

// ── factory ─────────────────────────────────────────────────────────────────
export function createMode(id, ctx) {
    const meta = MODES.find(m => m.id === id) || MODES[0];
    switch (meta.id) {
        case 'ctl': return new RoundControl(meta, ctx);
        case 'gun': return new GunGame(meta, ctx);
        case 'ffa': return new FreeForAll(meta, ctx);
        default:    return new TeamDeathmatchMode(meta, ctx);
    }
}
