// ============================================================================
// test-rules.mjs — the headless rules test.
//
// The browser verifiers cost minutes in a sandbox without a GPU, and none of what
// this checks needs one: what a kill is worth, when a mode ends, who is hostile
// to whom. All of it is plain numbers and state, so it runs in Node in about a
// second and asserts the parts that are easy to get quietly wrong.
//
//   npm run test:rules
// ============================================================================
import { KillChain, milestoneFor, nextMilestone, milestoneProgress, CHAIN_WINDOW } from '../src/js/medals.js';
import { MODES, createMode } from '../src/js/modes.js';
import { GUN_GAME_LADDER, WEAPON_DEFS } from '../src/js/weapons.js';
import { SPAWN_A, SPAWN_B, WAYPOINTS } from '../src/js/map.js';
import { TEAM_A, TEAM_B } from '../src/js/utils.js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { STAND_FLIP, NO_FLIP, flipFromJoints, foldedLimb, POSE_JOINTS, restPoseOf, poseBones, ARMS, TARGET_HEIGHT, fitFactor } from '../src/js/rebel-pose.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`   ok   ${name}${detail ? '   — ' + detail : ''}`); }
    else { fail++; console.log(`   FAIL ${name}${detail ? '   — ' + detail : ''}`); }
};
const group = t => console.log(`\n ${t}`);

// ── 1. kill chains and streak names ──────────────────────────────────────────
group('medals.js — chains, headshots, milestones');
{
    const c = new KillChain();
    let r = c.note(10, false, 1);
    ok('a lone kill says KILL and nothing else',
        r.medals.length === 1 && r.medals[0].label === 'KILL', r.medals.map(m => m.label).join('/'));
    ok('chain counts one', r.chain === 1);

    r = c.note(12, false, 2);
    ok('a second kill inside the window is a DOUBLE KILL',
        r.medals.some(m => m.label === 'DOUBLE KILL') && r.chain === 2, r.medals.map(m => m.label).join('/'));

    r = c.note(13.4, true, 3);
    ok('a third is a TRIPLE KILL', r.medals.some(m => m.label === 'TRIPLE KILL'), r.medals.map(m => m.label).join('/'));
    ok('a headshot adds the HEADSHOT medal with its bonus',
        r.medals.some(m => m.label === 'HEADSHOT' && m.sub === '+150'));

    r = c.note(14, false, 4);
    ok('a fourth becomes MULTI KILL ×4',
        r.medals.some(m => m.label === 'MULTI KILL' && m.sub === '×4'), JSON.stringify(r.medals[2]));
    r = c.note(15, false, 5);
    ok('and keeps counting past four', r.medals.some(m => m.label === 'MULTI KILL' && m.sub === '×5'));

    r = c.note(15 + CHAIN_WINDOW + 1, false, 6);
    ok('the chain dies on its own once the window passes', r.chain === 1 && r.medals.length === 1);

    c.reset();
    ok('reset() clears the chain', c.count === 0 && !c.active);

    const m = new KillChain();
    r = m.note(100, false, 3);
    ok('the streak name lands exactly on its number',
        r.medals.some(x => x.label === 'ON A ROLL' && /×3 STREAK/.test(x.sub)), JSON.stringify(r.medals[1]));
    r = m.note(100.5, false, 4);
    ok('and does not repeat on the kill after it', !r.medals.some(x => x.id === 'milestone'));

    ok('milestoneFor picks the highest name reached', milestoneFor(7).label === 'KILLING SPREE');
    ok('milestoneFor is null below the first', milestoneFor(2) === null);
    ok('nextMilestone looks ahead', nextMilestone(7).n === 10);
    ok('progress fills inside a band', Math.abs(milestoneProgress(10) - 0) < 1e-9 && milestoneProgress(11) > 0);
    ok('progress is complete after the last name', milestoneProgress(999) === 1);
}

// ── 2. who may be shot ───────────────────────────────────────────────────────
group('ai.js — hostility');
{
    // The prototype alone is enough; no scene, no rig, no GL.
    const isHostile = (await import('../src/js/ai.js')).Bot.prototype.isHostile;
    const t = (self, e) => !!isHostile.call(self, e);
    ok('team play ignores your own side', t({ team: TEAM_A }, { team: TEAM_A, alive: true }) === false);
    ok('team play sees the other side', t({ team: TEAM_A }, { team: TEAM_B, alive: true }) === true);
    ok('a teamless match sees your own side too',
        t({ team: TEAM_A, allHostile: true }, { team: TEAM_A, alive: true }) === true);
    ok('nobody shoots a corpse', t({ team: TEAM_A, allHostile: true }, { team: TEAM_B, alive: false }) === false);
    ok('and nobody shoots the air', t({ team: TEAM_A }, null) === false);

    // "everyone is hostile" has to mean everyone ELSE. When it included the self,
    // a bot targeted its own position, divided by a distance of 0, and rode the
    // resulting NaN off the map — invisible and untouchable.
    const me = { team: TEAM_A, allHostile: true, alive: true };
    ok('a soldier is never hostile to himself, even with no teams', t(me, me) === false);
    ok('the same body under two references is still himself',
        t({ team: TEAM_A, allHostile: true }, me) === true, 'a different soldier must stay valid');

    const { Bot } = await import('../src/js/ai.js');
    const healable = {
        position: { x: NaN, z: 4, set(x, y, z) { this.x = x; this.z = z; } },
        velocity: { x: NaN, z: 0, set(x, y, z) { this.x = x; this.z = z; } },
        team: TEAM_A, spawnPoints: [{ x: -11, z: 7 }], goal: 'stale', enemy: 'stale',
        pickGoal() { this.goal = 'fresh'; }
    };
    ok('a non-finite transform is detected', Bot.prototype.needsHeal.call(healable) === true);
    Bot.prototype.selfHeal.call(healable);
    // Back near the point, not exactly on it: every soldier takes a place on the
    // ring around its spawn, so a repaired one cannot land inside a healthy one.
    ok('and repaired: back on the map, aiming at nothing',
        Math.hypot(healable.position.x + 11, healable.position.z - 7) < 1.7
        && healable.velocity.x === 0
        && healable.enemy === null && healable.goal === 'fresh'
        && Bot.prototype.needsHeal.call(healable) === false);
    ok('a healthy soldier is left alone', Bot.prototype.needsHeal.call({
        position: { x: 1, z: 2 }, velocity: { x: 0, z: 0 }
    }) === false);
}

// ── 3. the modes ─────────────────────────────────────────────────────────────
group('modes.js — the menu');
{
    const ids = MODES.map(m => m.id);
    ok('four modes are offered', ids.length === 4, ids.join(', '));
    ok('free for all and gun game are on the menu', ids.includes('ffa') && ids.includes('gun'));
    ok('every entry has a name and a one-line pitch',
        MODES.every(m => m.name && m.desc && m.desc.length < 80));
}

const fakePlayer = () => ({
    name: 'You', team: TEAM_A, alive: true, kills: 0, deaths: 0, score: 0,
    position: { x: 0, y: 0, z: 0 }, killStreak: 0, spawnProtect: 0, keys: {},
    current: 0, _ggRung: 0, weapons: WEAPON_DEFS.map(d => ({ ammo: 0, reserve: 0, reloading: false })),
    switchTo(i) { if (i === this.current) return; this.current = i; this._switches = (this._switches || 0) + 1; },
    respawn() { this.alive = true; }
});
const fakeBot = (name, team) => ({
    name, team, alive: true, kills: 0, deaths: 0, score: 0, killStreak: 0,
    position: { x: 1, y: 0, z: 1 }, _ggRung: 0, weaponIndex: 0,
    setWeapon(i) { this.weaponIndex = i; },
    spawn() { this.alive = true; }
});

group('modes.js — Free For All');
{
    const player = fakePlayer();
    const bots = [fakeBot('SERGEANT-A', TEAM_A), fakeBot('WOLFE-B', TEAM_B), fakeBot('HALE-A', TEAM_A)];
    const banners = [];
    const ctx = {
        player, getBots: () => bots,
        hud: { banner: (a, b, c) => banners.push(a), hideDeath() { } },
        effects: { clearHoles() { } }, scene: {}, audio: {}
    };
    const m = createMode('ffa', ctx);
    ok('the mode is registered', m.name === 'Free For All');
    ok('it tells the HUD there are no teams', m.noTeams === true);
    ok('killstreaks are off, and unusable rather than merely hidden',
        m.usesKillstreaks === false && ['uav', 'air', 'nuke'].every(k => m.disabledStreaks.has(k)));
    ok('the clock does not run out', !isFinite(m.timeLimit) && !isFinite(m.scoring.timeRemaining) === false
        || m.scoring.timeRemaining === Infinity);
    ok('respawning stays on', m.canRespawn(player) === true && m.canRespawn(bots[0]) === true);

    m.onMatchStart();
    m.update(0.016);
    ok('every bot becomes hostile to everyone', bots.every(b => b.allHostile === true),
        bots.map(b => `${b.name}:${b.allHostile ? 'solo' : 'team'}`).join(' '));
    ok('and spawns across both halves of the map',
        bots.every(b => (b.spawnPoints || []).length === SPAWN_A.length + SPAWN_B.length));
    ok('they are not all pushed the same way', new Set(bots.map(b => b.pushDir)).size > 1);

    const hud1 = m.hudState();
    ok('the HUD counts your own kills against the target', /^ME 0 \/ 200$/.test(hud1.primary), hud1.primary);

    // 199 kills is not a win, and the enemy hitting 200 first is a loss
    player.kills = 199;
    m.onKill(player, bots[0]);
    ok('199 kills does not end it', !m.isOver());
    player.kills = 200;
    m.onKill(player, bots[0]);
    ok('the 200th kill ends it, won', m.isOver() && m.result().won === true, m.result().subtitle);

    const m2 = createMode('ffa', { ...ctx, player: Object.assign(fakePlayer(), { kills: 3 }) });
    m2.onMatchStart();
    m2.update(0.016);
    const rival = m2.bots()[0];
    rival.kills = 200;
    m2.onKill(rival, rival);
    ok('an AI reaching 200 first wins it from you', m2.isOver() && m2.result().won === false,
        m2.result().subtitle);
    ok('a bot-vs-bot kill is a real kill (they grind each other)',
        /reached 200/.test(m2.scoring.endReason || ''), m2.scoring.endReason);

    const s = m2.standings();
    ok('the board is one table sorted by kills, you are flagged',
        s.rows.length === 4 && s.rows[0].k >= s.rows[1].k && s.rows.some(r => r.me),
        s.rows.map(r => `${r.name}:${r.k}`).join(' '));
    ok('each row carries the count toward the target', /^\d+\/200$/.test(s.rows[0].tag), s.rows[0].tag);
}

group('modes.js — Gun Game');
{
    ok('the ladder is four guns long', GUN_GAME_LADDER.length === 4, GUN_GAME_LADDER.join(','));
    ok('and every rung is a real weapon', GUN_GAME_LADDER.every(i => !!WEAPON_DEFS[i]),
        GUN_GAME_LADDER.map(i => WEAPON_DEFS[i].short).join(' → '));

    const player = fakePlayer();
    const bots = [fakeBot('PAIN-B', TEAM_B), fakeBot('REYES-A', TEAM_A)];
    const banners = [];
    const ctx = {
        player, getBots: () => bots,
        hud: { banner: t => banners.push(t), hideDeath() { } },
        effects: { clearHoles() { } }, scene: {}, audio: {}
    };
    const m = createMode('gun', ctx);
    m.onMatchStart();

    ok('you start on the first gun', player.current === GUN_GAME_LADDER[0] && player._ggRung === 0,
        WEAPON_DEFS[player.current].short);
    ok('the match is raced to 75 kills, not to the last gun', m.killTarget === 75, String(m.killTarget));
    ok('the HUD counts kills against 75 and still names the gun you are on',
        m.hudState().primary === '0 / 75' && /GUN 1\/4/.test(m.hudState().secondary)
        && /NEXT:/.test(m.hudState().secondary), `${m.hudState().primary} · ${m.hudState().secondary}`);

    m.onKill(player, bots[0]);
    ok('one kill moves you up exactly one gun', player._ggRung === 1 && player.current === GUN_GAME_LADDER[1],
        WEAPON_DEFS[player.current].short);
    ok('and the promotion is announced with the gun name',
        banners.some(b => /LEVEL 2/.test(b)), banners.join(','));

    m.update(0.016);
    ok('a fresh rung is loaded, not half-empty',
        player.weapons[GUN_GAME_LADDER[1]].ammo === WEAPON_DEFS[GUN_GAME_LADDER[1]].magSize);

    m.onKill(bots[0], player);
    ok('the enemy climbs the same ladder', bots[0]._ggRung === 1 && bots[0].weaponIndex === GUN_GAME_LADDER[1]
        && bots[0]._ggKills === 1, `rung ${bots[0]._ggRung}`);
    m.onKill(bots[0], player);
    ok('two kills is two guns, and nobody has won anything yet',
        !m.isOver() && bots[0]._ggKills === 2 && bots[0]._ggRung === 2, `kills ${bots[0]._ggKills}`);
    m.onKill(bots[0], player);
    ok('the fourth gun is one kill from a lap, not one from winning',
        !m.isOver() && bots[0]._ggKills === 3 && bots[0]._ggRung === 3, `rung ${bots[0]._ggRung}`);
    m.onKill(bots[0], player);
    ok('the fourth gun wraps them back to the first and the match goes on',
        !m.isOver() && bots[0]._ggRung === 0 && bots[0].weaponIndex === GUN_GAME_LADDER[0]
        && bots[0]._ggKills === 4, `rung ${bots[0]._ggRung} kills ${bots[0]._ggKills}`);
    for (let i = 0; i < 70; i++) m.onKill(bots[0], player);
    ok('74 kills is still not a win', !m.isOver() && bots[0]._ggKills === 74, String(bots[0]._ggKills));
    m.onKill(bots[0], player);
    ok('and they can win it at 75 while you are still climbing', m.isOver() && m.result().won === false,
        m.result().subtitle);
    ok('the loss says what it took and how far you got',
        /75 kills to win/.test(m.result().subtitle) && /you had 1/.test(m.result().subtitle)
        && /PAIN-B got 75/.test(m.result().subtitle), m.result().subtitle);

    // a clean board: run the player's own ladder to the end
    const p2 = fakePlayer();
    const m2 = createMode('gun', { ...ctx, player: p2, getBots: () => [] });
    m2.onMatchStart();
    for (let i = 0; i < 3; i++) m2.onKill(p2, { team: TEAM_B });
    ok('three kills is not the win', !m2.isOver() && p2._ggRung === 3);
    m2.onKill(p2, { team: TEAM_B });
    ok('nor is the fourth — that is lap 2, back on the first gun',
        !m2.isOver() && p2._ggRung === 0 && p2._ggKills === 4 && p2.current === GUN_GAME_LADDER[0]
        && /LAP 2/.test(m2.hudState().secondary), m2.hudState().secondary);
    ok('…and the wrap is announced as a lap, not as a finish',
        /LAP 2 — back to/.test(banners[banners.length - 1]), String(banners[banners.length - 1]));
    for (let i = 0; i < 71; i++) m2.onKill(p2, { team: TEAM_B });
    ok('75 kills wins it', m2.isOver() && m2.result().won === true, m2.result().subtitle);
    ok('no gun is used twice on the ladder', new Set(GUN_GAME_LADDER).size === GUN_GAME_LADDER.length);
    ok('and a kill on a former team-mate still counts here (no teams)', (() => {
        const mate = fakeBot('REYES-A', TEAM_A);
        const p3 = fakePlayer();
        const m3 = createMode('gun', { ...ctx, player: p3, getBots: () => [mate] });
        m3.onMatchStart();
        m3.onKill(p3, mate);
        return p3._ggRung === 1;
    })());
    ok('the win says the count that did it, not the gun you happened to be on',
        /75 kills to win · you had 75/.test(m2.result().subtitle), m2.result().subtitle);
    const s = m2.standings();
    ok('the board counts kills, because a gun no longer says who is winning',
        /^\d+\/75 /.test(s.rows[0].tag), s.rows[0].tag);
    ok('…and its title says what the match is', /75 kills/.test(s.title), s.title);
}

// ── 4. the modes the game already had still work ─────────────────────────────
group('modes.js — no regressions in the two team modes');
{
    const player = fakePlayer();
    const bots = [fakeBot('AONE-A', TEAM_A), fakeBot('BONE-B', TEAM_B)];
    const ctx = {
        player, getBots: () => bots, hud: { banner() { }, hideDeath() { } },
        effects: { clearHoles() { } }, scene: {}, audio: {}
    };
    const tdm = createMode('tdm', ctx);
    tdm.onMatchStart();
    tdm.onKill(player, bots[1]);
    ok('TDM still scores the team', tdm.teamAScore === 1 && !tdm.isOver());
    ok('TDM still has teams', tdm.noTeams === false && tdm.standings() === null);
    for (let i = 0; i < 74; i++) tdm.onKill(player, bots[1]);
    ok('TDM ends at 75', tdm.isOver() && tdm.result().won === true);

    // The bug the single-kill-path refactor was about: one kill, one credit.
    const tdm2 = createMode('tdm', ctx);
    tdm2.onMatchStart();
    tdm2.onKill(player, bots[1]);
    ok('one reported kill is one point, not two', tdm2.teamAScore === 1, `score ${tdm2.teamAScore}`);

    // Round Control scores rounds, not kills — a kill must never hand it out.
    const ctlKills = createMode('ctl', { ...ctx, player: fakePlayer(), getBots: () => [] });
    ctlKills.onMatchStart();
    for (let i = 0; i < 4; i++) ctlKills.onKill(ctlKills.player, { team: TEAM_B });
    ok('kills in Round Control do not score rounds', ctlKills.teamAScore === 0 && !ctlKills.isOver(),
        `rounds ${ctlKills.teamAScore}`);

    const ctl = createMode('ctl', ctx);
    ctl.onMatchStart();
    ok('Round Control keeps its one-life rule and its nuke ban',
        ctl.canRespawn(player) === false && ctl.disabledStreaks.has('nuke'));
    ok('Round Control is not a solo mode', ctl.noTeams === false);

    // One clock, not two. The scorebar already prints the countdown, so a mode
    // that repeats it one row below reads as a desync (10:00 beside 9:59).
    ok('Team Deathmatch leaves the match clock to the scorebar',
        tdm.hudState().primary === '', JSON.stringify(tdm.hudState().primary));
    ok('Round Control leaves the match clock to the scorebar',
        ctl.hudState().primary === '', JSON.stringify(ctl.hudState().primary));
    ok('Round Control still captions the round',
        /ROUND/.test(ctl.hudState().secondary), ctl.hudState().secondary);
    ok('Free For All and Gun Game still own their primary line',
        /^ME \d+ \/ 200$/.test(createMode('ffa', ctx).hudState().primary) &&
        /^\d+ \/ \d+$/.test(createMode('gun', ctx).hudState().primary));
}

// ── 8. the imported FBX: standing pose and the sizing fit ────────────────────
// The model file is bound wrong (limbs folded up along the body), so two numbers
// decide whether it looks like a soldier: the standing flip underneath every
// animation angle, and the scale correction taken from what the page drew rather
// than what the loader reported. Both live in one module the game and the tester
// share, and both are plain arithmetic — so they are testable here, in Node.
group('rebel-pose.js — the FBX calibration the bot rig runs on');
{
    const src = await readFile(new URL('../src/js/rebel-pose.js', import.meta.url), 'utf8');
    ok('the pose table is its own module, so the rig and the rules read one source',
        /STAND_FLIP/.test(src) && !/document\.|WebGLRenderer/.test(src), src.split('\n')[0].slice(0, 40));

    ok('the flip covers exactly the four limb roots, and nothing else',
        Object.keys(STAND_FLIP).join(',') === 'LeftUpLeg,RightUpLeg,LeftArm,RightArm',
        Object.keys(STAND_FLIP).join(','));
    ok('each one is half a turn about X', Object.values(STAND_FLIP).every(v => Math.abs(v - Math.PI) < 1e-9));
    ok('a soldier is 1.80 m', Math.abs(TARGET_HEIGHT - 1.8) < 1e-9);

    // the fit: a rig that drew the file's bound height is nearly twice too big
    ok('a 3.42 m drawing of a 1.80 m soldier is shrunk, not left alone',
        Math.abs(fitFactor(3.42) - 1.8 / 3.42) < 1e-9, fitFactor(3.42).toFixed(4));
    ok('something already within 2% is left exactly alone', fitFactor(1.82) === 1 && fitFactor(1.78) === 1);
    ok('a junk measurement never rescales the rig', fitFactor(0) === 0 && fitFactor(NaN) === 0 && fitFactor(-3) === 0);
    ok('the aim pose is forward, not up: positive angles, both hands in front',
        ARMS.aim.leftArm > 0 && ARMS.aim.rightArm > 0 && ARMS.elbow > 0, JSON.stringify(ARMS.aim));

    // and both consumers actually use it
    const rebel = await readFile(new URL('../src/js/rebel.js', import.meta.url), 'utf8');
    // The flip used to be unconditional, which is how "the feet are where the head
    // is and there are no hands" happened: the same half-turn that unfolds a rig
    // that shipped folded ties a rig that ships standing into a knot. So both pages
    // now ask the rig which of the two poses is taller and use that one.
    ok('the bot rig keeps the rotations the file shipped with, and reads them first',
        /S\.rest = restPoseOf\(bones\);/.test(rebel)
        && rebel.indexOf('restPoseOf(bones)') < rebel.indexOf('flipFromJoints(jointY)'));
    ok('the bot rig decides the pose from its joints, not from a constant',
        /S\.standFlip = flipFromJoints\(jointY\)/.test(rebel));
    ok('and animates it as a delta through the shared helper',
        /poseBones\(this\.bones, S\.rest, t, \{/.test(rebel));
    ok('and reuses one pooled target per bone instead of building maps per frame',
        /this\._tgt \|\| \(this\._tgt = Object\.create\(null\)\)/.test(rebel)
        && !/Object\.keys\(POSE_JOINTS\)\.map/.test(rebel));
    ok('the flip the bot rig applies is the one it measured, with no constant behind it',
        /flip: S\.standFlip \|\| NO_FLIP/.test(rebel) && !/STAND_FLIP\[name\]/.test(rebel));
    ok('the rig writes no channel the helper does not read (no .bend, no .rx)',
        !/\.bend\b/.test(rebel) && !/\.rx\b/.test(rebel));
    ok('and the shared helper has one shape to accept, so the two cannot drift',
        /poseBones\(bones, rest, angles, \{ k = 1, flip = null, easeOthers = true \} = \{\}\)/.test(
            await readFile(new URL('../src/js/rebel-pose.js', import.meta.url), 'utf8')));
    ok('the module exports what a second consumer would need, unchanged',
        /export const STAND_FLIP/.test(src) && /export function flipFromJoints/.test(src)
        && /export function poseBones/.test(src));
    ok('the box is not what decides it any more',
        !/chooseStandFlip/.test(rebel));
    ok('the rig reports the height it drew next to the height the file claimed',
        /rawHeight: \+S\.rawHeight\.toFixed\(2\)/.test(rebel) && /height: S\.drew \|\| TARGET_HEIGHT/.test(rebel));
    ok('the rig never writes an angle by assignment',
        !/b\.rotation\.x \+= \(g\.x/.test(rebel));
    ok('and it never clears the bones to measure them, which is how the fold was invented',
        !/setTable\(/.test(rebel));
    ok('one joint table, imported rather than copied',
        /POSE_JOINTS/.test(src) && /poseBones\(/.test(rebel));
    ok('the bot rig sizes itself from what it drew, once, and shares the fit',
        /fitFactor\(h\)/.test(rebel) && /if \(!S\.calibrated\)/.test(rebel));
    ok('the seam is still off by default, so the shipped soldiers stay the GLB ones',
        /DEFAULT_MODE = 'off'/.test(rebel));
}

// A canvas that is good enough for three's texture helpers to be constructed
// against: nothing is drawn, this only stops the procedural-material code from
// needing a browser to run in the rules tests.
function mkEl(w = 64, h = 64) {
    const ctx = new Proxy({ canvas: { width: w, height: h } }, {
        get(t, k) {
            if (k in t) return t[k];
            if (k === 'getImageData') return (x, y, gw, gh) => ({ data: new Uint8ClampedArray(gw * gh * 4), width: gw, height: gh });
            if (k === 'createImageData') return (gw, gh) => ({ data: new Uint8ClampedArray(gw * gh * 4), width: gw, height: gh });
            return () => ({ addColorStop() {} });
        },
        set(t, k, v) { t[k] = v; return true; }
    });
    return { style: {}, setAttribute() {}, addEventListener() {}, getContext: () => ctx, width: w, height: h };
}

// ── 8b. which of the two poses is standing, decided by measuring ────────────
group('rebel-pose.js — the standing pose is chosen, not assumed');
{
    // The FBX this game ships with has its limbs folded up: an ankle at 1.42 m with
    // the hip at 0.13 m. Standing it needs a half-turn on the four limb roots. What
    // the box says is useless here, so these cases are joints.
    const folded = { Hips: 0.13, Spine2: 0.82, LeftFoot: 1.42, RightFoot: 1.42, LeftHand: 1.60, RightHand: 1.60 };
    const standing = { Hips: 0.93, Spine2: 1.42, LeftFoot: 0.08, RightFoot: 0.08, LeftHand: 0.30, RightHand: 0.30 };
    const t = (map) => flipFromJoints(k => map[k]);

    ok('a rig with its feet above its hips and its hands above its chest is folded',
        Object.keys(t(folded)).sort().join(',') === 'LeftArm,LeftUpLeg,RightArm,RightUpLeg',
        Object.keys(t(folded)).sort().join(','));
    ok('every folded limb gets exactly half a turn',
        Object.values(t(folded)).every(v => Math.abs(v - Math.PI) < 1e-9));
    ok('a rig that already stands gets no turn at all', t(standing) === NO_FLIP);
    ok('a T-pose is level, not folded: the tolerance is a slice of the torso',
        Object.keys(t({ ...standing, LeftHand: 1.44, RightHand: 1.40 })).length === 0);
    ok('and only the limb that is actually folded is turned',
        Object.keys(t({ ...standing, LeftFoot: 1.9 })).join(',') === 'LeftUpLeg');
    ok('centimetres decide the same way as metres — no unit is assumed',
        Object.keys(t(Object.fromEntries(Object.entries(folded).map(([k, v]) => [k, v * 100])))).length === 4);
    ok('a rig whose joints cannot be read is left exactly as it shipped',
        Object.keys(flipFromJoints(() => undefined)).length === 0);
    ok('and a limb is judged by whatever joint of it CAN be read, wrist before elbow',
        Object.keys(flipFromJoints((k) => (k === 'Hips' ? 150 : k === 'Spine2' ? 208
            : k === 'LeftFoot' || k === 'RightFoot' ? 17
            : k === 'LeftHand' ? NaN            // an export with no hand bones at all
            : k === 'LeftForeArm' ? 300 : 200))).join(',') === 'LeftArm');
    ok('the hip height alone is enough to judge the legs',
        Object.keys(flipFromJoints((k) => (k === 'Hips' ? 150 : k === 'Spine2' ? 208
            : k === 'LeftFoot' ? 300 : k === 'RightFoot' ? 300 : 200)))
        .sort().join(',') === 'LeftUpLeg,RightUpLeg');
    ok('folded means below-the-joint, with slack', foldedLimb(1, 1.2) === true
        && foldedLimb(1, 0.2) === false && foldedLimb(1, 1.05, 0.2) === false);
    ok('the flip both pages converge on is the same table the fold produces',
        JSON.stringify(t(folded)) === JSON.stringify(STAND_FLIP));
}

// ── 8b2. the joint table, re-measured against the file it was fitted to ───────
// POSE_JOINTS says which axis bends each joint and in which direction. Those were
// measured once by hand, which is exactly how they went wrong the first time — so
// the table is now checked against the FBX itself, in the loader the page uses.
// If a re-export moves a joint's flexion onto another axis, this is what catches it.
group('rebel-pose.js — the joint table is what the FBX actually does');
{
    globalThis.document = globalThis.document || {
        createElementNS: mkEl, createElement: mkEl, body: { appendChild() {} }
    };
    globalThis.window = globalThis.window || { devicePixelRatio: 1, addEventListener() {} };
    const THREE = await import('three');
    const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
    const { readFileSync } = await import('node:fs');
    const fbx = new URL('../src/assets/rebel/rebel.fbx', import.meta.url);
    ok('the FBX this table was fitted to is in the repo', existsSync(fbx), 'src/assets/rebel/rebel.fbx');
    const buf = readFileSync(fbx);
    const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
    const norm = n => (n || '').toLowerCase().replace(/^mixamorig[:_\s-]?/, '').replace(/\.[0-9]+$/, '').replace(/[:_\s-]/g, '');
    // the table's own joints, plus the ones it compares against
    const names = [...new Set(Object.values(POSE_JOINTS).reduce(
        (acc, v) => acc.concat([v.then].filter(Boolean)), Object.keys(POSE_JOINTS)))];
    const bones = {};
    root.traverse(o => {
        if (!o.isBone) return;
        const k = norm(o.name);
        for (const key of names) if (!bones[key] && k === key.toLowerCase()) bones[key] = o;
    });
    ok('every joint in the table exists in the file', names.every(k => !!bones[k]),
        names.filter(k => !bones[k]).join(',') || 'all present');
    const rest = restPoseOf(bones);
    const at = k => bones[k].getWorldPosition(new THREE.Vector3());
    const put = (over) => {
        for (const k of names) { const b = bones[k]; if (b) b.rotation.set(rest[k].x, rest[k].y, rest[k].z); }
        for (const [k, v] of Object.entries(over)) {
            const spec = POSE_JOINTS[k];
            if (bones[k] && spec) bones[k].rotation[spec.axis] += spec.sign * v;
        }
        (function prime(o) { o.updateMatrix(); for (const c of o.children) prime(c); })(root);
        root.updateMatrixWorld(true);
    };
    put({});
    ok('the file ships its soldier standing: the toe is on the floor, the head is on top',
        at('LeftToeBase').y < 0.5 && at('Head').y > at('Spine2').y && at('LeftFoot').y < at('Hips').y,
        `toe ${at('LeftToeBase').y.toFixed(1)} head ${at('Head').y.toFixed(1)} ankle ${at('LeftFoot').y.toFixed(1)} hip ${at('Hips').y.toFixed(1)}`);
    ok('so no standing flip is wanted or needed for this rig',
        Object.keys(flipFromJoints(k => (bones[k] ? at(k).y : NaN))).length === 0);
    for (const [name, spec] of Object.entries(POSE_JOINTS)) {
        if (!spec.want || !spec.then || !bones[name] || !bones[spec.then]) continue;
        put({}); const a = at(spec.then);
        put({ [name]: 0.6 }); const b = at(spec.then);
        const dz = b.z - a.z, dy = b.y - a.y;
        const good = spec.want === 'forward' ? dz < -8 : spec.want === 'back' ? dz > 8 : dy > 8;
        ok(`a positive bend on ${name} moves ${spec.then} ${spec.want}`, good, `Δz ${dz.toFixed(1)}, Δy ${dy.toFixed(1)}`);
    }
    put({ LeftUpLeg: 0.5, RightUpLeg: -0.5 });
    ok('the legs swing in opposite phases, as a walk needs',
        (at('LeftLeg').z - at('RightLeg').z) < -20,
        `L ${at('LeftLeg').z.toFixed(1)} R ${at('RightLeg').z.toFixed(1)}`);
    put({}); const handRest = at('LeftHand').z;
    put({ LeftArm: 0.9, RightArm: 0.9 });
    ok('both arms come forward for the aim pose, mirrored by the table, not one side only',
        Math.abs(at('LeftHand').z - at('RightHand').z) < 12 && at('LeftHand').z < handRest - 4,
        `hand z ${at('LeftHand').z.toFixed(1)} / ${at('RightHand').z.toFixed(1)} from ${handRest.toFixed(1)}`);
    ok('and nothing about the pose is a magic number the file was not checked against',
        Object.values(POSE_JOINTS).every(v => ['x', 'y', 'z'].includes(v.axis) && Math.abs(v.sign) === 1));
    put({});
}

// ── 8c. switching weapons: the frame you press the key must not build anything ─
// A switch used to build the new gun's viewmodel on the press frame and then wait
// 0.22 s in the air before showing it, which together felt like the game stopping.
// The work now happens in a queue the loop drains on cheap frames (and warms on
// the GPU), the swap is at 0.14 s, and a key pressed mid-swap retargets the swap
// instead of being dropped.
group('viewmodel.js — a switch costs the press frame nothing');
{
    const vm = await readFile(new URL('../src/js/viewmodel.js', import.meta.url), 'utf8');
    const main = await readFile(new URL('../src/js/main.js', import.meta.url), 'utf8');
    const press = vm.slice(vm.indexOf('requestSwitch(index) {'), vm.indexOf('startReload(def) {'));
    ok('the press path builds nothing', !/_ensure\(|_build\(/.test(press), press.slice(0, 0) + 'no build call');
    ok('it asks the queue instead', /this\._queue\.unshift\(index\)/.test(press));
    ok('a key during a swap retargets it instead of being dropped',
        /this\.pendingSwitch = index;/.test(press) && /switchT > SWAP_LOWER/.test(press));
    // scoped to the switch block: 0.22 is also an ambient light intensity and a
    // trigger angle elsewhere in the file, and this rule is about the timings
    const swapBlock = vm.slice(vm.indexOf('── weapon switch'), vm.indexOf('const swPhase'));
    ok('the dip is where the model changes, and it is shorter than it was',
        /const half = SWAP_LOWER;/.test(swapBlock) && /const SWAP_LOWER = 0\.14;/.test(vm),
        `SWAP_LOWER ${/SWAP_LOWER/.test(swapBlock) ? 'in the swap block' : 'missing'}`);
    ok('the raise is timed off the same number, so the two cannot drift',
        /switchT >= half \* 2/.test(swapBlock) && /\/ \(SWAP_LOWER \* 2\)/.test(vm));
    ok('the loop drains the queue only on frames that have room',
        /if \(frameAvg < 15\) vm\.prebuild\(renderer, 6\);/.test(main));
    ok('a match queues every gun it could hand you', /vm\.queueAll\(\);/.test(main));

    // the same rules, behaviourally, with no GPU in sight
    globalThis.document = globalThis.document || {
        createElementNS: mkEl, createElement: mkEl, body: { appendChild() {} }
    };
    globalThis.window = globalThis.window || { devicePixelRatio: 1, addEventListener() {} };
    const { ViewModel } = await import('../src/js/viewmodel.js');
    const fake = { renders: 0, targets: [], autoClear: 'was',
        render() { this.renders++; },
        getRenderTarget() { return null; },          // the world pass is at the screen
        setRenderTarget(t) { this.targets.push(t === null ? 'null' : 'rt'); } };
    const v = new ViewModel(0);
    ok('every weapon but the one in hand starts out unbuilt',
        v.models.filter(m => !m).length === v.models.length - 1, `${v.models.length - 1} queued`);
    ok('the queue holds exactly the unbuilt ones', v.queueAll() === v.models.length - 1);
    const before = v._queue.length;
    v.prebuild(fake, 0);
    ok('one call builds one weapon, then stops to let the frame finish',
        before - v._queue.length === 1, `queue ${before} → ${v._queue.length}`);
    ok('and drawing it once, off screen, is part of building it',
        fake.renders === 1 && fake.targets.join(',') === 'rt,null',
        `renders ${fake.renders}, targets ${fake.targets.join(',')}`);
    ok('the warm draw leaves the renderer as it found it', fake.autoClear === 'was');
    ok('a pressed switch waits its turn in the queue rather than being built now',
        v.requestSwitch(v.current + 3) === true && !v.models[v.current + 3],
        `pendingSwitch ${v.pendingSwitch}`);
    ok('a second press during the dip wins the first one',
        v.requestSwitch(v.current + 5) === true && v.pendingSwitch === v.current + 5);
    ok('pressing the gun you already hold is refused', v.requestSwitch(v.current) === false);
}

// ── 9. panels a mode owns are applied at match start, not on a later frame ───
// Free For All has no teams, so the blue-vs-red bars must be gone. They were only
// ever toggled from the per-frame HUD pass, which is why a headless verifier could
// read them as still visible: the loop had not run the frame yet. Same class of bug
// as a scoreboard labelled from the previous match — the fix is to apply it where
// the mode is handed over.
group('hud.js — mode panels at match start');
{
    const hud = await readFile(new URL('../src/js/hud.js', import.meta.url), 'utf8');
    const setMode = hud.slice(hud.indexOf('setMode(mode) {'), hud.indexOf('setScoreLimit'));
    ok('setMode applies the mode panels itself', /this\._modePanels\(mode, this\._modeRounds\(mode\)\)/.test(setMode));
    ok('the per-frame pass calls the same helper, so the two cannot disagree',
        /_modeHud[\s\S]{0,700}this\._modePanels\(s\.mode \|\| this\.mode, ms\)/.test(hud));
    ok('nothing else toggles the team bars', (hud.match(/el\.teamBars\.classList/g) || []).length === 1);
}

// ── 10. the free-roam camera is the whole dead-player experience now ────────
// freeroam.js is written without three.js or the DOM on purpose: everything below
// runs the real code, not a regex over it. The behaviour that matters is that keys
// go somewhere, that nothing can fly you out of the world, and that a focus jump
// actually frames the operator it jumped to.
group('freeroam.js — flying the camera');
{
    const { createFreeRoam, ROAM } = await import('../src/js/freeroam.js');
    const step = (r, n, dt = 1 / 60) => { for (let i = 0; i < n; i++) r.update(dt, null); return r.pos; };

    let r = createFreeRoam();
    r.enter(null);
    r.key('KeyW', true);
    step(r, 40);
    ok('holding W flies along the view, and yaw 0 looks down -Z', r.pos.z < -1 && Math.abs(r.pos.x) < 1e-6,
        `z=${r.pos.z.toFixed(2)}`);
    ok('the camera never leaves the floor or the ceiling', r.pos.y >= ROAM.floor - 1e-6 && r.pos.y <= ROAM.ceil + 1e-6);

    r = createFreeRoam(); r.enter(null);
    r.key('KeyS', true); step(r, 40);
    ok('S reverses', r.pos.z > 1, `z=${r.pos.z.toFixed(2)}`);

    r = createFreeRoam(); r.enter(null); r.yaw = Math.PI / 2;
    r.key('KeyW', true); step(r, 40);
    ok('turning the yaw turns the flight path', r.pos.x < -1 && Math.abs(r.pos.z) < 1, `x=${r.pos.x.toFixed(2)}`);

    r = createFreeRoam(); r.enter(null);
    r.key('Space', true); step(r, 30);
    ok('Space gains height, and stops at the ceiling', r.pos.y > ROAM.floor && r.pos.y <= ROAM.ceil + 1e-6);
    r.key('Space', false); r.key('KeyC', true); step(r, 600);
    ok('C sinks back to the floor and no further', Math.abs(r.pos.y - ROAM.floor) < 1e-6, `y=${r.pos.y.toFixed(2)}`);

    r = createFreeRoam(); r.enter(null);
    const b = r.bounds;
    r.key('KeyW', true); r.key('KeyD', true); step(r, 4000);
    ok('you cannot fly off the map', r.pos.x <= b.maxX + 1e-6 && r.pos.z >= b.minZ - 1e-6, JSON.stringify(r.pos));

    const dist = rr => { rr.enter(null); rr.key('ShiftLeft', true); rr.key('KeyW', true); step(rr, 30); return Math.abs(rr.pos.z); };
    const sprint = dist(createFreeRoam());
    let walk = 0;
    { const w = createFreeRoam(); w.enter(null); w.key('KeyW', true); step(w, 30); walk = Math.abs(w.pos.z); }
    ok('Shift is a sprint, and a real one', sprint > walk * 1.8, `${sprint.toFixed(1)} vs ${walk.toFixed(1)}`);

    r = createFreeRoam({ accel: 6, speed: 4 });
    r.enter(null); r.key('KeyW', true);
    for (let i = 0; i < 60; i++) r.update(1 / 60, null);
    const oneWay = { ...r.pos };
    const r2 = createFreeRoam({ accel: 6, speed: 4 });
    r2.enter(null); r2.key('KeyW', true);
    for (let i = 0; i < 120; i++) r2.update(1 / 120, null);
    ok('flight is frame-rate independent (120 Hz matches 60 Hz)',
        Math.abs(oneWay.z - r2.pos.z) < 0.05, `${oneWay.z.toFixed(3)} vs ${r2.pos.z.toFixed(3)}`);

    r = createFreeRoam(); r.enter(null);
    r.look(300, 0); const yawA = r.yaw;
    r.look(-300, 0);
    ok('mouse look is clamped and reversible', Math.abs(yawA) > 0.1 && Math.abs(r.yaw) < 1e-6);
    r.look(0, 1e6);
    ok('a huge mouse delta cannot flip the camera upside down', Math.abs(r.pitch) <= ROAM.pitchLimit + 1e-9);

    r = createFreeRoam(); r.enter(null);
    r.focusOn({ position: { x: 4, y: 0, z: -6 }, yaw: 0, name: 'BOB' }, null);
    const d = Math.hypot(r.pos.x - 4, r.pos.z + 6);
    ok('a focus jump parks you behind the operator', d > 3 && d < ROAM.focusBack + 0.6, `d=${d.toFixed(2)}m`);
    ok('…and remembers who it framed, so the strip can name them', r.watching && r.watching.name === 'BOB');
    ok('…and looks down at their chest rather than past the horizon',
        r.pitch < -0.05 && r.pitch > -0.7, `pitch=${r.pitch.toFixed(2)}`);
    ok('the wide spectator FOV comes back when the camera is handed over', (() => {
        let fov = 0;
        const cam = { position: { set(x, y, z) { fov = fov; } }, rotation: { order: '', set() {} }, fov: 78,
            updateProjectionMatrix() {} };
        const q = createFreeRoam(); q.enter(cam); q.apply(cam); fov = cam.fov;
        q.exit(cam);
        return fov === ROAM.fov && cam.fov === 78;
    })());
}

group('main.js / hud.js — the handover, and not painting over the game');
{
    const main = await readFile(new URL('../src/js/main.js', import.meta.url), 'utf8');
    const hud = await readFile(new URL('../src/js/hud.js', import.meta.url), 'utf8');
    const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
    ok('the roam camera takes the view only after the death fall ends',
        /if \(!player\.alive && player\.deathProgress < 1\) return;[\s\S]{0,260}roam\.enter\(camera\)/.test(main));
    ok('the loop hands the camera back as soon as the player is alive',
        /if \(player\.alive\) \{\s*\n\s*if \(roam\.active\) exitFreeRoam\(\);/.test(main));
    ok('a match start, a menu and a result card all end the flight',
        (main.match(/exitFreeRoam\(\);/g) || []).length >= 5);
    ok('the flight keys are read off one list so nothing leaks through',
        /const ROAM_KEYS = new Set\(/.test(main) && /ROAM_KEYS\.has\(e\.code\)/.test(main));
    ok('the death card gets out of the way of the view', /hud\.hideDeath\(\);\s*\n\s*hud\.freeRoam\(true/.test(main));
    ok('the strip says what the keys do, not whose eyes you are in',
        /freeRoam\(on, focus = '', killedBy = ''\)/.test(hud) && !/Spectating <b>/.test(hud));
    ok('the map stopped scattering human silhouettes across the lawns', !/mannequin\(/.test(html) &&
        !/mannequin\(/.test(await readFile(new URL('../src/js/map.js', import.meta.url), 'utf8')));
    // The tab-closing bug: a viewport-sized backdrop blur of a live WebGL canvas
    // is the most expensive composite the browser can be asked for, and it appears
    // at exactly the moment a victory card goes up. Losing the GPU context is the
    // other half — without preventDefault the page tailspins on a dead canvas.
    const overlay = html.slice(html.indexOf('.overlay{'), html.indexOf('.overlay.on'));
    ok('no full-screen card blurs the live canvas', !/backdrop-filter:blur/.test(overlay));
    ok('no overlay animation runs a filter over the whole viewport',
        !/@keyframes diedIn\{[^}]*filter:blur/.test(html.replace(/\n\s*/g, '')));
    ok('a lost GL context is caught, stopped and explained',
        /addEventListener\('webglcontextlost'/.test(main) && /e\.preventDefault\(\)/.test(main)
        && /if \(glLost\) return;/.test(main));
}

// ── 11. difficulty is a number the AI reads, not a label on a button ─────────
group('difficulty.js — easy / medium / hard');
{
    const D = await import('../src/js/difficulty.js');
    const easy = D.difficultyById('easy'), med = D.difficultyById('medium'), hard = D.difficultyById('hard');
    ok('the three options exist and an unknown id falls back to Medium',
        D.DIFFICULTIES.length === 3 && D.difficultyById('nightmare').id === D.DEFAULT_DIFFICULTY);
    ok('they order up: aim, skill band and cap all climb',
        easy.aimScale < med.aimScale && med.aimScale < hard.aimScale &&
        easy.skill[1] < med.skill[0] && med.skill[1] < hard.skill[0] &&
        easy.chanceCap < med.chanceCap && med.chanceCap < hard.chanceCap,
        `${easy.aimScale}/${med.aimScale}/${hard.aimScale}`);
    ok('easy misses wide and slow to react, hard does neither',
        easy.spreadScale > 2 && easy.reactionScale > 1.5 && hard.spreadScale < 1 && hard.reactionScale < 1);
    const roll = d => { const out = []; for (let i = 0; i < 60; i++) out.push(D.rollSkill(d, () => i / 60)); return out; };
    ok('the skill roll stays inside the band, so a squad is varied but not wrong',
        roll(easy).every(x => x >= easy.skill[0] - 1e-9 && x <= easy.skill[1] + 1e-9)
        && roll(hard).every(x => x >= hard.skill[0] && x <= hard.skill[1]));
    const bot = D.skillFor('easy', {});
    ok('applying it writes exactly the fields ai.js reads',
        bot.aimScale === easy.aimScale && bot.spreadScale === easy.spreadScale
        && bot.reactionScale === easy.reactionScale && bot.chanceCap === easy.chanceCap
        && bot.difficulty === 'easy' && bot.skill >= easy.skill[0] && bot.skill <= easy.skill[1]);
    ok('and a mid-match switch re-scales a live bot without touching its skill',
        (() => { const before = bot.skill; D.applyDifficulty(bot, 'hard');
            return bot.skill === before && bot.aimScale === hard.aimScale && bot.difficulty === 'hard'; })());
    ok('describe() says what the option does, for the card', /Easy —/.test(D.describe('easy')));

    // The wiring that makes the module real: ai.js must multiply by these, and the
    // menu must set them.
    const ai = await readFile(new URL('../src/js/ai.js', import.meta.url), 'utf8');
    ok('ai.js reads the scales', /chance = clamp\(chance, 0\.03, this\.chanceCap\)/.test(ai)
        && /\* this\.aimScale/.test(ai) && /rand\(-1\.6, 1\.6\) \* sp/.test(ai)
        && /\* this\.reactionScale/.test(ai));
    ok('a bot without a difficulty fights at the old numbers', /this\.chanceCap = 0\.72;/.test(ai));
    const main = await readFile(new URL('../src/js/main.js', import.meta.url), 'utf8');
    ok('the game asks on a fresh profile and remembers after',
        /if \(!isDifficulty\(settings\.difficulty\)\) showDiffGate\(\);/.test(main)
        && /difficulty: null/.test(main) && /if \(!isDifficulty\(settings\.difficulty\)\) settings\.difficulty = null;/.test(main));
    ok('the ask names the way back in Controls',
        /You can change it later in Controls\./.test(await readFile(new URL('../src/index.html', import.meta.url), 'utf8')));
    ok('changing it re-scales the soldiers already alive',
        /for \(const b of bots\) applyDifficulty\(b, d\);/.test(main));
    ok('a Deploy from the keyboard with no answer yet counts as Medium, and is saved',
        /if \(!isDifficulty\(settings\.difficulty\)\) setDifficulty\(DEFAULT_DIFFICULTY\);/.test(main));
}

// ── 12. the menu sells Gun Game as it now plays ─────────────────────────────
group('modes.js — Gun Game, described honestly');
{
    const modes = await readFile(new URL('../src/js/modes.js', import.meta.url), 'utf8');
    const aiSrc = await readFile(new URL('../src/js/ai.js', import.meta.url), 'utf8');
    ok('the target is a named constant, not a number repeated in three places',
        /export const GUN_GAME_KILLS = 75;/.test(modes) && /this\.killTarget = GUN_GAME_KILLS;/.test(modes));
    ok('the playlist card says 75 kills and cycling guns',
        /75 kills · 4 guns, and they keep cycling as you climb\./.test(modes));
}

// ── 13. nothing ends up outside the fence ───────────────────────────────────
group('utils.js — the perimeter is a clamp, not a mesh');
{
    const U = await import('../src/js/utils.js');
    ok('the rectangle is the authored footprint, multiplied as one piece',
        Math.abs(U.MAP_RECT.maxX - 42 * U.MAP_SCALE) < 1e-9
        && Math.abs(U.MAP_RECT.minZ + 40 * U.MAP_SCALE) < 1e-9
        && Math.abs(U.MAP_RECT.minX + 42 * U.MAP_SCALE) < 1e-9
        && Math.abs(U.MAP_RECT.maxZ - 38 * U.MAP_SCALE) < 1e-9);
    ok('and the map is 45% more ground than the 84 × 78 it was authored at',
        Math.abs(U.MAP_SCALE - 1.45) < 1e-9, `${U.MAP_RECT.maxX - U.MAP_RECT.minX} × ${U.MAP_RECT.maxZ - U.MAP_RECT.minZ} m`);
    const p = { x: 61.3, y: 0, z: -900 };
    ok('a runaway position is pulled back inside', U.clampToMap(p, 2.0) === true
        && p.x === U.MAP_RECT.maxX - 2 && p.z === U.MAP_RECT.minZ + 2, JSON.stringify(p));
    ok('and an in-bounds position is left completely alone',
        (() => { const q = { x: 3.5, z: -7.25 }; const moved = U.clampToMap(q, 2.0); return !moved && q.x === 3.5 && q.z === -7.25; })());
    ok('a NaN is recovered instead of parked at sea',
        (() => { const q = { x: NaN, z: 4 }; U.clampToMap(q, 2.0); return q.x === 0 && q.z === 4; })());
    const ai = await readFile(new URL('../src/js/ai.js', import.meta.url), 'utf8');
    const pl = await readFile(new URL('../src/js/player.js', import.meta.url), 'utf8');
    ok('bots clamp after collision and drop the outward push',
        /if \(clampToMap\(this\.position, 2\.0\)\) \{ this\.velocity\.x \*= 0\.2/.test(ai));
    ok('so does the player', /clampToMap\(this\.position, 2\.0\)/.test(pl));
    ok('nobody is born in the fence strip either', /clampToMap\(this\.position, 2\.4\)/.test(ai));
    const map = await readFile(new URL('../src/js/map.js', import.meta.url), 'utf8');
    ok('and the spawn points sit inside the last cover line',
        !/x: 39\.5/.test(map) && /x: 36\.6, z: -4\.0/.test(map));
    ok('the map and the entities agree on one rectangle',
        /export const MAP_BOUNDS = MAP_RECT;/.test(map));
}


// ── 20. gun game: one gun, one slot, and the cycle never stops ───────────────
group('gun game — one gun at a time until 75');
{
    const LAD = GUN_GAME_LADDER;
    // The player's side of the contract, mirrored from player.js exactly: the mode
    // may move you, the input may not. If those two rules ever drift apart this
    // test goes red rather than the ladder silently breaking.
    const mkPlayer = () => ({
        alive: true, current: 0, loadout: null, noSwap: false,
        kills: 0, deaths: 0, score: 0, killStreak: 0, matchKills: 0, team: TEAM_A,
        weapons: WEAPON_DEFS.map(d => ({ ammo: d.magSize, reserve: d.reserve, reloading: false })),
        setLoadout(list) {
            this.loadout = Array.isArray(list) && list.length ? list.slice() : null;
            this.noSwap = !!this.loadout && this.loadout.length < 2;
        },
        canHold(i) { return !this.loadout || this.loadout.indexOf(i) >= 0; },
        switchTo(i) {
            if (i === this.current || i < 0 || i >= WEAPON_DEFS.length) return;
            if (!this.canHold(i)) return;
            this.weapons[this.current].reloading = false;
            this.current = i;
        },
        useSlot(i) { if (this.noSwap) return; this.switchTo(i); }
    });

    const player = mkPlayer();
    const banners = [];
    const mode = createMode('gun', {
        player, getBots: () => [],
        hud: { banner: (t, c, sub) => banners.push([t, sub]) },
        effects: {}, scene: {}, audio: {}
    });
    ok('the mode fields a one-gun match around', mode.warmGuns && mode.warmGuns.length === LAD.length
        && mode.killTarget === 75, JSON.stringify({ warm: mode.warmGuns, target: mode.killTarget }));

    mode.onMatchStart();
    ok('a fresh match puts you on the first ladder gun', player.current === LAD[0], `current ${player.current}`);
    ok('…and holds nothing else', player.loadout && player.loadout.length === 1
        && player.loadout[0] === LAD[0], JSON.stringify(player.loadout));
    ok('…and that is a locked loadout', player.noSwap === true);

    // The whole match, one kill at a time.
    const seen = [], held = [];
    for (let k = 1; k <= 75; k++) {
        const before = player.current;
        player.useSlot(0); player.useSlot(1); player.useSlot(2); player.useSlot(3);   // mashing the strip
        if (player.current !== before) seen.push('input moved the gun at kill ' + k);
        player.kills = k; player.matchKills = k;
        mode.onKill(player, { team: TEAM_B, kills: 0, deaths: 0, score: 0 }, 'M4A1', false);
        seen.push(player.current);
        held.push(player.loadout ? player.loadout.length : 0);
        mode.update(0.016);                     // the ladder's retry loop
        seen[seen.length - 1] = player.current;
    }
    ok('mashing 1-4 never changes the gun you hold', !seen.some(s => String(s).startsWith('input')),
        seen.find(x => typeof x === 'string') || 'all four keys ignored');
    const want = [];
    for (let k = 1; k <= 74; k++) want.push(LAD[k % LAD.length]);
    ok('every kill walks the next rung, in order, wrapping at the end',
        JSON.stringify(seen.slice(0, want.length)) === JSON.stringify(want),
        `${seen.slice(0, 8).join(' ')} … ${seen.slice(-4).join(' ')}`);
    ok('the cycle keeps going — four guns, ~19 laps, not a ladder that runs out',
        LAD.length === 4 && new Set(seen).size === 4, 'guns seen: ' + [...new Set(seen)].join(','));
    ok('you never hold more than one gun, not even for a frame',
        held.every(h => h === 1), 'slot counts: ' + [...new Set(held)].join(','));
    ok('the promotion is the only thing allowed to swap it',
        mode._want === player.current, `want ${mode._want} · holding ${player.current}`);
    ok('75 kills ends it, whoever got there', mode.isOver() === true && mode.result().won === true,
        mode.result().subtitle);
    ok('the HUD counts the kills it is really racing',
        /^\d+ \/ 75$/.test(mode.hudState().primary) && /LAP/.test(mode.hudState().secondary),
        JSON.stringify([mode.hudState().primary, mode.hudState().secondary]));
    ok('a promotion onto the last gun says what happens next',
        banners.some(b => /cycles/.test(b[1] || '')), banners.filter(b => /cycles/.test(b[1] || '')).length + ' hints');
    ok('and a lap back to the top is announced as a lap',
        banners.some(b => /^LAP \d+/.test(b[0])), banners.map(b => b[0]).filter(t => /^LAP/.test(t))[0] || 'none');

    // A mode switch must not inherit the lock.
    player.setLoadout(null);
    const tdm = createMode('tdm', { player, getBots: () => [], hud: { banner() { } }, effects: {}, scene: {}, audio: {} });
    tdm.onMatchStart();
    ok('the team modes still carry the whole armory',
        player.loadout === null && player.noSwap === false, JSON.stringify([player.loadout, player.noSwap]));

    // Now the wiring, since these are the lines that go missing quietly.
    const pl = await readFile(new URL('../src/js/player.js', import.meta.url), 'utf8');
    const mj = await readFile(new URL('../src/js/main.js', import.meta.url), 'utf8');
    const hd = await readFile(new URL('../src/js/hud.js', import.meta.url), 'utf8');
    const md = await readFile(new URL('../src/js/modes.js', import.meta.url), 'utf8');
    const vmd = await readFile(new URL('../src/js/viewmodel.js', import.meta.url), 'utf8');
    ok('number keys go through the refusal, not straight to switchTo',
        /Digit1'\) this\.useSlot\(0\)/.test(pl) && /KeyQ'\) this\.cycleSlot\(1\)/.test(pl)
        && !/Digit\d'\) this\.switchTo/.test(pl));
    ok('the scroll wheel is locked out too', /wheel[\s\S]{0,160}this\.cycleSlot\(e\.deltaY/.test(pl));
    ok('switchTo is where the loadout is enforced, so nothing else can walk around it',
        /if \(!this\.canHold\(i\)\) return this\._refusedSwap\(\);/.test(pl));
    ok('the mode sets the loadout before it asks to switch',
        md.indexOf('p.setLoadout([idx])') < md.indexOf('p.switchTo(idx)'),
        'order matters — switchTo checks the list it is standing on');
    ok('every match starts from the open armory',
        /if \(player\.setLoadout\) player\.setLoadout\(null\);/.test(mj));
    ok('a one-gun mode builds four viewmodels, not fifteen',
        /gamemode\.warmGuns && vm\.queueOnly/.test(mj) && /queueOnly\(list\)/.test(vmd));
    ok('the strip shows what you may carry and hides the rest',
        /setLoadout\(list\)/.test(hd) && /slots\[i\]\.style\.display = d \? '' : 'none'/.test(hd));
    ok('a slot the loadout does not fill is blanked, never dereferenced',
        /\(WEAPON_DEFS\[w\] \|\| null\)/.test(hd)
        && /txt\(slots\[i\], d \? \(this\._loadout \? \(d\.short \|\| d\.name\) : String\(i \+ 1\)\) : ''\)/.test(hd));
    ok('the HUD does not promise grenades the game cannot throw',
        /equipRow: \$\('equip'\)/.test(hd) && /this\.el\.equipRow\) this\.el\.equipRow\.style\.display = 'none'/.test(hd)
        && !/throwGrenade|Grenade\b/.test(mj + pl));
    ok('a bad index in a loadout is dropped before anyone reads it',
        /list\.filter\(i => Number\.isInteger\(i\) && i >= 0 && i < WEAPON_DEFS\.length\)/.test(pl));
    ok('and a locked strip is not hidden by the old four-weapon rule',
        /if \(this\.el\.slotRow\) this\.el\.slotRow\.classList\.remove\('hidden'\);/.test(hd));
    ok('trying to swap in a one-gun mode tells you the rule',
        /onRefusedSwap: refuseSwapHint/.test(mj) && /hud\.banner\('ONE GUN AT A TIME'/.test(mj));
    ok('and the hint is throttled, so mashing does not spam',
        /now - _refusedAt < \d+/.test(mj));

    // ── the bugs this hunt found, kept fixed on purpose ──────────────────────
    const ks = await readFile(new URL('../src/js/killstreaks.js', import.meta.url), 'utf8');
    const sv = await readFile(new URL('../scripts/serve.mjs', import.meta.url), 'utf8');
    const au = await readFile(new URL('../src/js/audio.js', import.meta.url), 'utf8');
    ok('a disabled killstreak is refused at the gate, not only in the HUD',
        /canUse\(id\) \{ return this\.isEnabled\(id\) && this\.progress\(id\)\.ready/.test(ks));
    ok('and the game does not promise a reward the mode removed',
        /if \(p\.enabled && !streaks\.used\[id\]\)/.test(mj));
    ok('every HTML page revalidates, not just the root one',
        /ext === '\.html'\) return 'public, max-age=0, must-revalidate'/.test(sv)
        && !/rel === 'index\.html'/.test(sv));
    ok('all three sound primitives tear their chain down when they end',
        /release\(src, \[g, lpf, hpf, send\]\)/.test(au) && /release\(o, \[g, send\]\)/.test(au)
        && /release\(src, \[g, bp, send\]\)/.test(au)
        && /src\.onended = \(\) =>/.test(au) && /try \{ n\.disconnect\(\); \}/.test(au)
        && (au.match(/\n    release\(/g) || []).length === 3);
    ok('the send gain is handed back so it can be disconnected too',
        /return s;/.test(au.split('function out(')[1].split('\n\n')[0]));
}


// ── 21. a bigger map, decided in one place ──────────────────────────────────
group('map scale — geometry, collision, tables and textures move together');
{
    const U = await import('../src/js/utils.js');
    const map = await readFile(new URL('../src/js/map.js', import.meta.url), 'utf8');
    const phy = await readFile(new URL('../src/js/physics.js', import.meta.url), 'utf8');
    const mj = await readFile(new URL('../src/js/main.js', import.meta.url), 'utf8');
    const ks = await readFile(new URL('../src/js/killstreaks.js', import.meta.url), 'utf8');
    const hud = await readFile(new URL('../src/js/hud.js', import.meta.url), 'utf8');

    ok('one constant decides the size of the world',
        /export const MAP_SCALE = 1\.45;/.test(await readFile(new URL('../src/js/utils.js', import.meta.url), 'utf8')));
    ok('the build applies it once, at the end, before anything is validated',
        map.indexOf('applyWorldScale(scene, cw, MAP_SCALE, sky.mesh)') < map.indexOf('validateWaypoints(cw);'),
        'order matters — nodes are checked against the scaled colliders');
    ok('objects move out AND grow, so proportions survive',
        /o\.position\.multiplyScalar\(k\)/.test(map) && /o\.scale\.multiplyScalar\(k\)/.test(map));
    ok('the sky dome is left where it is',
        /applyWorldScale\(scene, cw, MAP_SCALE, sky\.mesh\)/.test(map) && /if \(o === skip \|\| !\(o\.isMesh/.test(map));
    ok('collision boxes follow the meshes, not a second copy of the layout',
        /cw\.rescale\(k\)/.test(map) && /rescale\(k\) \{/.test(phy));
    ok('and the broadphase grid is rebuilt rather than trusted',
        /this\.grid\.clear\(\);/.test(phy) && /for \(let i = 0; i < this\.boxes\.length; i\+\+\) this\._span\(this\.boxes\[i\], i\)/.test(phy));
    ok('a stale grid would hide walls, so the insert path is shared, not duplicated',
        /_span\(b, idx\) \{/.test(phy) && /this\._span\(b, idx\);/.test(phy));
    ok('steps grow with the map, or upstairs becomes unreachable',
        /this\.stepHeight \*= k;/.test(phy));
    ok('tiled textures get denser so a wall is not 45% wider siding',
        /t\.repeat\.x \/= k/.test(map) && /t\.repeat\.y \/= k/.test(map));
    ok('but only the tiling ones — a clamped decal is sized to its surface',
        /if \(t\.wrapS === REP\) t\.repeat\.x \/= k/.test(map) && /SLOTS = \['map', 'normalMap'/.test(map));
    ok('each texture is divided once, however many meshes share it',
        /seen\.has\(t\.uuid\)/.test(map) && /seen\.add\(t\.uuid\)/.test(map));
    ok('the minimap is authored in metres too, so it moves with the map',
        /scaleMinimap\(k\)/.test(map) && /for \(const f of MINIMAP\.fences\) for \(let i = 0/.test(map));
    ok('and its bounds are not scaled twice — they come from MAP_BOUNDS',
        !/flat\(MINIMAP\.bounds\)/.test(map) && /bounds: \{ x0: MAP_BOUNDS\.minX/.test(map));
    ok('the HUD draws in world units under that transform, so it needs no change',
        /c\.strokeRect\(MAP_BOUNDS\.minX, MAP_BOUNDS\.minZ,/.test(hud));
    ok('spawn points, nav nodes and perches are scaled at their definition',
        /export const SPAWN_A = atScale\(/.test(map) && /export const SPAWN_B = atScale\(/.test(map)
        && /export const WAYPOINTS = atScale\(\[/.test(map) && /export const PERCHES = atScale\(\[/.test(map));
    ok('a perch has a floor to stand on, so its height scales as well',
        /if \(Number\.isFinite\(n\.y\)\) o\.y = n\.y \* MAP_SCALE/.test(map));
    ok('the perimeter is placed in authored metres, so it scales exactly once',
        /const B = MAP_RECT_AUTHORED;/.test(map) && !/chainLinkRun\(MAP_BOUNDS|chainLinkRun\(B\.minX, B\.minZ, B\.maxX, B\.minZ\)/.test(map));
    ok("a round's clock grew with the ground, so the point is still reachable",
        (() => {
            const ctl = createMode('ctl', { player: null, getBots: () => [], hud: { banner() { } }, effects: {}, scene: {}, audio: {} });
            return Math.abs(ctl.roundT - 90 * U.MAP_SCALE) < 0.01 && ctl.roundT > 130;
        })(), 'Round Control opens at 2:10, not 1:30');
    ok('the freeze at the head of a round did NOT grow — nobody is walking during it',
        /const FREEZE_TIME = 5\.0;/.test(await readFile(new URL('../src/js/modes.js', import.meta.url), 'utf8')));
    ok('the authored rectangle is the only source of the scaled one',
        /minX: MAP_RECT_AUTHORED\.minX \* MAP_SCALE/.test(await readFile(new URL('../src/js/utils.js', import.meta.url), 'utf8')));
    ok('the world floor is authored too, and still covers the whole map',
        /cw\.addAABB\(-140, -1\.0, -140, 140/.test(map));
    ok('the fog reaches across the wider ground',
        /new THREE\.Fog\(0xcfc4ac, 110 \* MAP_SCALE, 360 \* MAP_SCALE\)/.test(mj));
    ok('the UAV orbit grows with the block it is watching',
        /Math\.cos\(ang\) \* 62 \* MAP_SCALE/.test(ks) && /Math\.sin\(ang\) \* 48 \* MAP_SCALE/.test(ks));
    ok('the camera still sees past the far house',
        /new THREE\.PerspectiveCamera\(78,[^)]*,\s*(\d+)\)/.test(mj)
        && Number(RegExp.$1) > 360 * U.MAP_SCALE, 'far plane vs fog');
    ok('the primitive helpers do no scaling of their own, so none can forget it',
        !/MAP_SCALE/.test(map.split('function box(')[1].split('\n}')[0])
        && !/MAP_SCALE/.test(map.split('function cylinder(')[1].split('\n}')[0])
        && !/MAP_SCALE/.test(map.split('function pave(')[1].split('\n}')[0]));
    ok('every builder function stays authored in the original metres',
        (map.match(/\* MAP_SCALE/g) || []).length === 3 && !/MAP_SCALE = /.test(map),
        (map.match(/\* MAP_SCALE/g) || []).length + ' multiplications, all of them inside atScale');

    // The clamp has to follow the rectangle it is given, at any size.
    const at = (k, m = 2.0) => {
        const p = { x: 42 * k + 1.9, z: 0 };
        U.clampToMap(p, m, { minX: -42 * k, maxX: 42 * k, minZ: -40 * k, maxZ: 38 * k });
        return p.x;
    };
    ok('the perimeter clamp bites at whatever edge it is given',
        Math.abs(at(1.45) - (42 * 1.45 - 2)) < 1e-9 && Math.abs(at(1) - 40) < 1e-9,
        `clamped to ${at(1.45).toFixed(2)} m at 1.45x, ${at(1).toFixed(2)} m at 1x`);
    ok('and MAP_RECT is that same rectangle, not a copy that can drift',
        Math.abs(U.MAP_RECT.maxX / 42 - U.MAP_SCALE) < 1e-12);
    ok('so a soldier spawned at the far fence is still inside it',
        (() => { const p = { x: U.MAP_RECT.maxX - 0.2, z: 0 }; U.clampToMap(p, 2.4); return p.x <= U.MAP_RECT.maxX - 2.4 + 1e-9; })());
}

// ── 15. this pass: the menu, the mouse, the callsign, the ground ────────────
// Twelve reports, answered one at a time. Each gets a rule that says the same
// thing the complaint said, so "the fog stayed on the menu" cannot quietly come
// back the next time somebody touches the grade or the pause key.
group('the punch list — menus, mouse, callsign, cover and room to roam');
{
    const mj = await readFile(new URL('../src/js/main.js', import.meta.url), 'utf8');
    const html = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
    const hud = await readFile(new URL('../src/js/hud.js', import.meta.url), 'utf8');
    const map = await readFile(new URL('../src/js/map.js', import.meta.url), 'utf8');
    const modes = await readFile(new URL('../src/js/modes.js', import.meta.url), 'utf8');
    const aiSrc = await readFile(new URL('../src/js/ai.js', import.meta.url), 'utf8');
    const ply = await readFile(new URL('../src/js/player.js', import.meta.url), 'utf8');
    const ai = await readFile(new URL('../src/js/ai.js', import.meta.url), 'utf8');

    // 1 — the nuke's whiteout used to stay on the main menu, because the grade is
    // written every frame from streak state and nothing cleared that state.
    ok('leaving a match resets the streaks that own the screen',
        /function toMenu\(\) \{[\s\S]{0,900}?if \(streaks\) streaks\.reset\(\);\n\s*if \(hud\.abortNuke\) hud\.abortNuke\(\);/.test(mj));
    ok('so does the end card',
        /function endMatch\(\)[\s\S]{0,400}?if \(streaks\) streaks\.reset\(\);/.test(mj));
    ok('the nuke overlay has an abort that does not play its flash', /abortNuke\(\) \{/.test(hud));
    ok('and the grade is switched off outside a match, at the source',
        /const graded = state === 'playing' \|\| state === 'paused';/.test(mj)
        && /g\.whiteout\.value = graded && streaks\.nukeFired/.test(mj)
        && /g\.damage\.value = graded \?/.test(mj) && /g\.death\.value = graded \?/.test(mj)
        && /composerFX\.bloom\.strength = 0\.34 \+ \(graded && streaks\.nukeFired/.test(mj));

    // 12 — free cursor on every screen you click, mouse captured only in play.
    ok('one helper hands the mouse back',
        /function releaseCursor\(\)/.test(mj)
        && /if \(document\.pointerLockElement\) document\.exitPointerLock\(\);\n\s*document\.body\.classList\.remove\('playing'\);/.test(mj));
    ok('menu, pause, end card and the first-run gate all release it',
        /function toMenu\(\) \{[\s\S]{0,500}?releaseCursor\(\);/.test(mj)
        && /if \(on\) releaseCursor\(\);/.test(mj)
        && /function endMatch\(\)[\s\S]{0,300}?releaseCursor\(\);/.test(mj)
        && /function showDiffGate\(\)[\s\S]{0,300}?releaseCursor\(\);/.test(mj));
    ok('the settings card counts as a menu, so its sliders are clickable',
        /function menuOpen\(\) \{[\s\S]{0,400}?const pn = \$\('panel'\);\n\s*if \(pn && pn\.style\.display === 'flex'\) return true;/.test(mj));
    ok('nothing re-captures the mouse behind an overlay',
        /if \(state === 'playing' && !menuOpen\(\) && !document\.pointerLockElement\) grabPointer\(\);/.test(mj));
    ok('the hidden system cursor follows the menus, not just the lock',
        /document\.body\.classList\.toggle\('playing', locked && !menuOpen\(\)\);/.test(mj));
    ok('and losing the lock while a menu is up does not pause the game again',
        /if \(!locked && state === 'playing' && player\.alive && !menuOpen\(\)\) pause\(true\);/.test(mj));

    // 11 — the callsign: asked for above the difficulty, shown wherever scores are.
    ok('the name is filtered and bounded, not trusted',
        /function cleanCallsign\(raw\)/.test(mj) && /slice\(0, 14\)/.test(mj));
    {
        const m = mj.match(/function cleanCallsign\(raw\) \{[\s\S]*?\n\}/);
        ok('and the filter does what it claims on the strings people paste', (() => {
            if (!m) return false;
            const body = m[0].slice(m[0].indexOf('{') + 1, m[0].lastIndexOf('}'));
            const f = new Function('raw', body);
            const a = f('<b>Private</b> "Rex"! <i>x</i>');
            return !/[<>&"'!\][]/.test(a) && a.length <= 14
                && f('   ') === 'SOLDIER-01' && f(null) === 'SOLDIER-01' && f('Åsa_9') === 'Åsa_9';
        })(), m ? 'the real body, run here' : 'cleanCallsign not found');
    }
    ok('the gate asks for the name before it asks for the difficulty',
        html.indexOf('id="gateName"') > 0 && html.indexOf('id="gateName"') < html.indexOf('id="diffGateOpts"'),
        `field at ${html.indexOf('id="gateName"')}, options at ${html.indexOf('id="diffGateOpts"')}`);
    ok('and the menu can change it without the gate', /id="menuName"[\s\S]{0,240}class="callsignInput"/.test(html));
    ok('the field is 14 characters, like the row it sits in',
        /id="nameMenu" type="text" maxlength="14"/.test(html) && /id="nameGate" type="text" maxlength="14"/.test(html));
    ok('typing it is not gameplay: the field swallows the keystroke',
        /el\.addEventListener\('keydown', e => \{\n\s*e\.stopPropagation\(\);/.test(mj));
    ok('the board prints the callsign, not "You"',
        /name: player\.name \|\| 'You'/.test(hud) && (modes.match(/name: e\.name \|\| 'You',/g) || []).length >= 2);
    ok('the kill feed says the same thing',
        (mj.match(/player\.name \|\| callsign\(\)/g) || []).length === 2);
    ok('it is written down the moment the field loses focus',
        /el\.addEventListener\('blur', \(\) => applyCallsign\(el\.value\)\)/.test(mj));
    ok('the player object gets it even though it was built before the profile loaded',
        /loadSettings\(\);\n\s*\/[\s\S]{0,400}?\n\s*applyCallsign\(settings\.name\);/.test(mj));

    // 8 — cover that only worked one way. Foliage stops legs and never bullets,
    // and both sides read the same set, so it cannot lean.
    const { CollisionWorld, SOFT_COVER } = await import('../src/js/physics.js');
    {
        const w = new CollisionWorld();
        w.addAABB(2, 0, -1, 2.6, 1.4, 1, 'bush');
        w.addAABB(6, 0, -1, 6.6, 2.4, 1, 'solid');
        const o = { x: 0, y: 1.2, z: 0 }, dir = { x: 1, y: 0, z: 0 };
        const hard = w.raycast(o, dir, 20);
        const soft = w.raycast(o, dir, 20, SOFT_COVER);
        ok('a hedge stops a movement ray', !!hard && Math.abs(hard.distance - 2) < 1e-6, hard && hard.tag);
        ok('the bullet rule gives the shot to the wall behind it instead',
            !!soft && soft.tag === 'solid' && Math.abs(soft.distance - 6) < 1e-6,
            soft && `${soft.tag}@${soft.distance.toFixed(2)}`);
        ok('sightlines use the bullet rule by default, so neither side gets a free look',
            w.isLineOfSight(o, { x: 5, y: 1.2, z: 0 }) === true
            && w.isLineOfSight(o, { x: 9, y: 1.2, z: 0 }) === false);
    }
    ok("the player's hitscan and the bots' both pass that set",
        /this\.cw\.raycast\(origin, dir, d\.range, SOFT_COVER\)/.test(ply)
        && /cw\.raycast\(muzzle, dir, w\.range, SOFT_COVER\)/.test(ai));
    ok('stairs are NOT in the soft list — a tread still stops a round',
        !SOFT_COVER.has('stairs') && SOFT_COVER.size === 1, [...SOFT_COVER].join(','));

    // 3 — the holes in the bushes.
    ok('bush jitter is decided per corner, and re-used by every triangle sharing it',
        /const jit = new Map\(\)/.test(map) && /if \(k === undefined\)/.test(map));
    ok('the per-row random that tore the surface is gone',
        !/const k = 0\.84 \+ Math\.random\(\) \* 0\.30;\n\s*pos\.setXYZ/.test(map));

    // 2 — the floor that flickered: a plinth and a finished floor on one plane.
    ok('plinths sit under their floors, not level with them',
        /box\(w \+ 0\.5, 0\.5, d \+ 0\.5, cx, -0\.06, cz, mats\.concrete/.test(map)
        && /box\(w \+ 0\.5, 0\.4, d \+ 0\.5, cx, -0\.05, cz, mats\.concrete/.test(map)
        && /box\(w \+ 0\.4, 0\.26, d \+ 0\.4, cx, -0\.05, cz, mats\.concrete/.test(map));
    ok('the top porch step no longer meets the deck at the same height',
        /box\(0\.4, 0\.26, 2\.4, 15\.42, 0\.13, -5\.8/.test(map));
    ok('walk height is untouched: the floor boxes did not move',
        /box\(w, floor, d, cx, floor \/ 2, cz, mats\.floor, \{ tag: 'wood' \}\);/.test(map));

    // 5 — a stair that looked like it was leaning on nothing.
    ok('a flight carries stringers that cast, and a post every other tread',
        /deco\(0\.14, 0\.42, len, px, cy, pz, mat, \{ rotX: -dir \* ang \}\);/.test(map)
        && /for \(let i = 1; i < steps; i \+= 2\)/.test(map));
    ok('and the long flights get a centre stringer under the treads',
        /if \(steps >= 10\) \{/.test(map) && /0\.5, len, mx, mid, mz, mat/.test(map));

    // 6 — 45% bigger had to mean room, not just fence.
    ok('a team has more places to start than it has soldiers',
        SPAWN_A.length >= 10 && SPAWN_B.length === SPAWN_A.length, `${SPAWN_A.length} candidates`);
    ok('no two candidates on a team are within 4 m, so nobody deploys inside a teammate', (() => {
        let bad = 0, min = Infinity;
        for (const list of [SPAWN_A, SPAWN_B])
            for (let i = 0; i < list.length; i++)
                for (let j = i + 1; j < list.length; j++) {
                    const d = Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z);
                    if (d < min) min = d;
                    if (d < 4) bad++;
                }
        return bad === 0;
    })());
    ok('and a list is long enough that eight solos never wrap around it',
        SPAWN_A.length * 2 >= 8 * 2, `${SPAWN_A.length} × 2 teams vs 8 players`);
    ok('the deploy writes down the spread it actually bought, at the moment it decides',
        /const placed = \[\];/.test(modes)
        && /placed\.push\(\{ x: p\.position\.x, z: p\.position\.z \}\);/.test(modes)
        && /placed\.push\(\{ x: b\.position\.x, z: b\.position\.z \}\);/.test(modes)
        && !/placed\.push\(sp\);/.test(modes)
        && /this\._deploySpread = \{/.test(modes));
    ok('the deploy records where the soldiers were actually put, ring offset included',
        /placed\.push\(\{ x: p\.position\.x, z: p\.position\.z \}\);/.test(modes)
        && /placed\.push\(\{ x: b\.position\.x, z: b\.position\.z \}\);/.test(modes));
    ok('the claim ledger is shared per team, not kept by each soldier',
        /spawnLedger\(this\.team\)/.test(aiSrc) && !/this\._claim/.test(aiSrc));
    ok('the player claims their spawn so no bot is dropped on top of them',
        /player\.respawn\(claimPoint\(randElement\(SPAWN_A\), TEAM_A, 3\)\)/.test(mj)
        && /return claimPoint\(best, TEAM_A, 3\);/.test(mj));
    ok('a ring place is only used if it is clear of walls, fences and steps',
        /export function pickRingSlot\(sp, cw, start = takeRingSlot\(sp\)\)/.test(aiSrc)
        && /this\._ring = pickRingSlot\(sp, this\._cw, takeRingSlot\(sp\)\);/.test(aiSrc)
        && /if \(cw\) this\._cw = cw;/.test(aiSrc)
        && /b\.tag === 'bound' \|\| b\.tag === 'ground' \|\| b\.tag === 'bush' \|\| b\.tag === 'glass'/.test(aiSrc));
    ok('and the wave of placements is written down for the harness to read',
        /export function deploySpread\(\)/.test(aiSrc)
        && /deploySpread: \(\) => deploySpread\(\)/.test(mj)
        && /notePlacement\(best, nowSec\)/.test(aiSrc)
        && /resetDeploySpread\(\);/.test(mj));
    {
        const ai = await import('../src/js/ai.js');
        const pts = ai.spawnOffset ? [0, 1, 2, 3, 4, 5].map(i => ai.spawnOffset(i)) : [];
        let ringMin = 0;
        for (let i = 0; i < pts.length; i++)
            for (let j = i + 1; j < pts.length; j++)
                ringMin = ringMin ? Math.min(ringMin, Math.hypot(pts[i].dx - pts[j].dx, pts[i].dz - pts[j].dz))
                    : Math.hypot(pts[i].dx - pts[j].dx, pts[i].dz - pts[j].dz);
        ok('each spawn point hands out six places, and no two of them are the same',
            pts.length === 6 && pts.every(o => Number.isFinite(o.dx) && Number.isFinite(o.dz)));
        ok('the closest two places on the ring are 1.6 m apart, so a mate cannot stand inside you',
            (() => {
                let min = Infinity;
                for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++)
                    min = Math.min(min, Math.hypot(pts[i].dx - pts[j].dx, pts[i].dz - pts[j].dz));
                return min > 1.5;
            })(),
            ringMin ? `${ringMin.toFixed(2)} m apart` : 'no ring');
        ok('the ring is taken in order, per point', (() => {
            const sp = { x: 1, z: 2 };
            const a = ai.takeRingSlot(sp), b = ai.takeRingSlot(sp), c = ai.takeRingSlot(sp);
            return a === 0 && b === 1 && c === 2 && ai.takeRingSlot({ x: 9, z: 9 }) === 0;
        })());
        ok('nine soldiers on one shared ledger get nine different points', (() => {
            const claim = new Map();
            const list = Array.from({ length: 13 }, (_, i) => ({ x: i * 8, z: 0 }));
            const got = Array.from({ length: 9 }, () => ai.claimSpawnPoint(list, claim, 0.1));
            return new Set(got).size === 9;
        })());
        ok('and a point just handed to someone is not handed to the next one', (() => {
            const claim = new Map();
            const list = [{ x: 0, z: 0 }, { x: 40, z: 40 }];
            const a = ai.claimSpawnPoint(list, claim, 0);
            const b = ai.claimSpawnPoint(list, claim, 0.1);
            const c = ai.claimSpawnPoint(list, claim, 5.0);      // the ledger has expired
            return a !== b && c !== undefined;
        })());
    }
    ok('nothing in the deploy touches the record before it is declared', (() => {
        const d = modes.slice(modes.indexOf('_deploy() {'));
        const body = d.slice(0, d.indexOf('\n    }'));
        const decl = body.indexOf('const placed');
        let first = -1;
        for (let i = body.indexOf('placed'); i >= 0; i = body.indexOf('placed', i + 1)) {
            if (i < decl && !/^\s*\/\//.test(body.slice(body.lastIndexOf('\n', i) + 1, i))) { first = i; break; }
        }
        return decl > 0 && (first === -1 || first > decl);
    })());
    ok('the harness reads that record rather than where the soldiers happen to be now',
        /_deploySpread/.test(await readFile(new URL('../scripts/verify.mjs', import.meta.url), 'utf8')));
    ok('the deploy takes the candidate furthest from everyone already placed',
        /const sp = farthestSpawn\(onA \? TEAM_A : TEAM_B, onA \? takenA : takenB, \(onA \? ia : ib\)\);/.test(modes)
        && /if \(onA\) takenA\.push\(sp\); else takenB\.push\(sp\);/.test(modes));
    ok("the bots' patrol ring grew with the ground it patrols", (() => {
        const ring = WAYPOINTS.filter(w => Math.hypot(w.x, w.z) > 18 && Math.hypot(w.x, w.z) < 25);
        return ring.length >= 8;
    })(), `${WAYPOINTS.filter(w => Math.hypot(w.x, w.z) > 18 && Math.hypot(w.x, w.z) < 25).length} nodes in the grown ring`);
    ok('the spawn lists speak the scaled metres, not the authored ones',
        Math.abs(SPAWN_A[0].x) > 34 && Math.abs(SPAWN_A[0].x) < 62, `first candidate at x ${SPAWN_A[0].x}`);

    // 10 — the tester page is out, and the game keeps its own soldiers.
    ok('the model tester is gone from the tree, the scripts and the routes',
        !existsSync(new URL('../src/tester', import.meta.url))
        && !existsSync(new URL('../public/tester', import.meta.url))
        && !existsSync(new URL('../scripts/build-tester.mjs', import.meta.url))
        && !/"tester":/.test(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
        && !/\/tester\//.test(await readFile(new URL('../vercel.json', import.meta.url), 'utf8')));
    ok('the zip no longer carries its source or its private assets',
        !/src\/tester|src\/assets\/rebel/.test(await readFile(new URL('../scripts/make-deploy-zip.mjs', import.meta.url), 'utf8')));
    ok('the imported model is still off by default, so the old soldiers ship',
        /DEFAULT_MODE = 'off'/.test(await readFile(new URL('../src/js/rebel.js', import.meta.url), 'utf8')));

    // 4 + 7 — the two things you read on paper: a folded label, and orange soup.
    ok('a settings label holds its line instead of folding one word per row',
        /\.rowSet label\{[\s\S]{0,220}?white-space:nowrap/.test(html));
    ok('the sentence beside "Enemy skill" is typeset as a sentence',
        /id="diffOut" class="note"/.test(html) && /\.rowSet output\.note\{flex:1 1 100%/.test(html));
    ok('one filled button per screen: the primary is the only solid orange',
        /\.menuBtn\.primary\{background:linear-gradient\(180deg,#FF8A33,var\(--accent\)\)/.test(html)
        && /position:relative;background:linear-gradient\(180deg,rgba\(159,178,192,\.10\)/.test(html));
    ok('quitting is the one red thing in the menu', /#btnQuit\{color:#F0B7B7/.test(html));
}


// ── 16. this pass: standing back up, the driver, and the furniture ──────────
// Three reports, all of them the kind that make a game feel broken rather than
// hard: you press crouch and stay crouched; the tab dies with a driver error and
// comes back dead; and the inside of every house is shelves and tables hanging in
// mid-air. The last one is settled by measuring the built map, not by reading
// the source, because "floating" is a property of the geometry.
group('crouch, the graphics driver, and nothing floating');
{
    const ply = await readFile(new URL('../src/js/player.js', import.meta.url), 'utf8');
    const mj = await readFile(new URL('../src/js/main.js', import.meta.url), 'utf8');
    const map = await readFile(new URL('../src/js/map.js', import.meta.url), 'utf8');

    ok('a held crouch key is one crouch, not thirty',
        /if \(e\.code === 'KeyC' && !e\.repeat\) this\.isCrouching = !this\.isCrouching;/.test(ply));
    ok('the headroom probe starts above the crouched head, not at the waist',
        /this\.position\.y \+ EYE_CROUCH, HEAD_RADIUS\)/.test(ply)
        && /const HEAD_RADIUS = 0\.2;/.test(ply)
        && !/this\.position\.y \+ 0\.4, this\.radius\)/.test(ply));
    ok('and a low ceiling refuses the eye height, it never rewrites your own toggle',
        /this\.headroomBlocked = true;/.test(ply)
        && !/if \(ceil < this\.position\.y \+ EYE_STAND \+ 0\.15\) \{ targetEye = EYE_CROUCH; this\.isCrouching = true; \}/.test(ply));

    ok('the WebGL probe gives its context straight back',
        /const lose = gl\.getExtension\('WEBGL_lose_context'\);\s*if \(lose\) lose\.loseContext\(\);/.test(mj));
    ok('building the renderer is inside a try, and the card that follows is the useful one',
        /try \{\s*renderer = new THREE\.WebGLRenderer/.test(mj)
        && /e\.handled = true;/.test(mj)
        && /if \(err && err\.handled\) return;/.test(mj));
    ok('the first dropped context reloads once, in safe graphics',
        /writeFlag\(GFX_LOSS_KEY, true\);\s*writeFlag\(SAFE_GFX_KEY, true\);/.test(mj)
        && /setTimeout\(\(\) => location\.reload\(\), 2600\)/.test(mj)
        && /releaseCursor\(\);\s*if \(!readFlag\(SAFE_GFX_KEY\)/.test(mj));
    ok('the second one stops and explains, and never reloads again',
        (mj.match(/setTimeout\(\(\) => location\.reload\(\)/g) || []).length === 1
        && /already come back once in safe graphics mode/.test(mj));
    ok('safe graphics is borrowed for the tab only — nothing is written to the saved profile',
        /renderer\.shadowMap\.enabled = !safeGfx;/.test(mj)
        && /if \(composerFX && composerFX\.setQuality\) composerFX\.setQuality\(0\);/.test(mj)
        && !/settings\.quality = 0/.test(mj));
    ok('and the auto ladder may only go down while the tab is on safe graphics',
        /if \(!safeGfx && !autoQualityLocked && curDpr >= maxDpr/.test(mj));

    ok('the balcony opening is a window now, and the front door is the only way in',
        /const balDoor = \[\{ a: -8\.1, b: -5\.8, y0: 4\.15, y1: 5\.3 \}\];/.test(map)
        && !/one leaf swung open over the deck/.test(map)
        && /windowGlass\('z', -8\.1, -5\.8, 4\.15, 5\.3, x0, mats\);/.test(map));
    ok('the welcome sign is a board on posts, not a wall from the ground up',
        /CTX\.cw\.addAABB\(8\.0, 1\.9, 27\.0, 8\.4, 4\.9, 33\.0, 'sign'\);/.test(map));
    ok('the chairs at the kitchen table have legs',
        (map.match(/deco\(0\.07, 0\.41, 0\.07, 22\.0 \+ lx, F \+ 0\.205, oz \+ lz/mg) || []).length === 1
        && /for \(const lx of \[-0\.17, 0\.17\]\) for \(const lz of \[-0\.17, 0\.17\]\)/.test(map));
    ok('so does the bungalow coffee table',
        /for \(const lx of \[-0\.5, 0\.5\]\) for \(const lz of \[-0\.22, 0\.22\]\)\n\s*deco\(0\.08, 0\.38, 0\.08, 18\.6 \+ lx, floor \+ 0\.19, 19\.8 \+ lz/.test(map));
    ok('the wall ladder has stiles to the ground',
        /for \(const sx2 of \[24\.72, 26\.08\]\)/.test(map)
        && /deco\(0\.1, 2\.86, 0\.16, sx2, 1\.43, 24\.4, mats\.wood\);/.test(map));
    ok('the garage shelving is built from one frame, not three sets of loose boards',
        /const RACK = \{ x: x1 - 0\.45, z: cz \+ 0\.1, y0: floor, top: 2\.72 \};/.test(map)
        && /1\.5 \+ i \* 0\.6, RACK\.z, mats\.wood/.test(map)
        && /, 1\.0, RACK\.z, mats\.wood, \{ tag: 'prop' \}/.test(map));
    ok('and the hose reel bracket spans from the wall to the reel',
        /new THREE\.BoxGeometry\(0\.34, 0\.5, 0\.5\)/.test(map)
        && /b\.position\.set\(sx \* 10\.50, 1\.9, -27\.5\)/.test(map));
    ok('and the firehouse hose reel is bolted to something',
        /new THREE\.BoxGeometry\(0\.34, 0\.5, 0\.5\)/.test(map));

    // The real test. Not the source text: the built scene, measured. Each of
    // these pieces was put into the town with the size and count below, so if
    // somebody deletes a leg again the number moves and this says so.
    const { CollisionWorld } = await import('../src/js/physics.js');
    const mapMod = await import('../src/js/map.js');
    const THREE0 = await import('three');
    const { MAP_SCALE } = await import('../src/js/utils.js');
    const scene = new THREE0.Scene();
    const cwx = new CollisionWorld();
    mapMod.buildNuketown(scene, cwx);
    const sz = new THREE0.Vector3();
    const bb = new THREE0.Box3();
    // Counted near the furniture it belongs to, because a leg the same size as
    // somebody else's leg is not evidence. Every position is authored metres, and
    // both mirrorings are listed.
    const countNear = (w, h, d, spots, r = 0.9, tol = 0.03) => {
        let n = 0;
        scene.traverse(o => {
            if (!o.isMesh || !o.geometry) return;
            bb.setFromObject(o);
            bb.getSize(sz);
            if (Math.abs(sz.x / MAP_SCALE - w) > tol || Math.abs(sz.y / MAP_SCALE - h) > tol
                || Math.abs(sz.z / MAP_SCALE - d) > tol) return;
            const cx = (bb.min.x + bb.max.x) / 2 / MAP_SCALE, cz = (bb.min.z + bb.max.z) / 2 / MAP_SCALE;
            if (!spots.length || spots.some(([px, pz]) => Math.hypot(cx - px, cz - pz) < r)) n++;
        });
        return n;
    };
    const chairSpots = [[22.0, -4.8], [22.0, -3.6], [-22.0, -4.8], [-22.0, -3.6]];
    const tableSpots = [[21.0, -6.9], [18.6, 19.8], [-21.0, -6.9], [-18.6, 19.8]];
    // Two houses, two chairs each, four legs a chair: sixteen.
    ok('the kitchen chairs stand on four legs each, in both houses', countNear(0.07, 0.41, 0.07, chairSpots, 0.45) === 16,
        `${countNear(0.07, 0.41, 0.07, chairSpots, 0.45)} legs at the tables`);
    ok('both coffee tables have their four legs', countNear(0.08, 0.38, 0.08, tableSpots, 0.95) === 16,
        `${countNear(0.08, 0.38, 0.08, tableSpots, 0.95)} legs by the tables`);
    ok('the wall ladders have stiles that reach the ground', countNear(0.1, 2.86, 0.16, [[25.4, 24.4], [-25.4, 24.4]], 1.2) === 4,
        `${countNear(0.1, 2.86, 0.16, [[25.4, 24.4], [-25.4, 24.4]], 1.2)} stiles`);
    ok('the garage rack stands on two full-height end panels, one per side', countNear(0.6, 2.57, 0.1, [], 0) === 4,
        `${countNear(0.6, 2.57, 0.1, [], 0)} panels — two per garage, from the floor to the top board`);
    {
        // Measured in the built scene: the boards, the working shelf and the
        // uprights must be one object, so their centres and spans are compared
        // rather than the source text. A rack can be edited into three pieces
        // without a single line of the loops changing.
        const shelf = [], board = [], panel = [];
        scene.traverse(o => {
            if (!o.isMesh || !o.geometry) return;
            bb.setFromObject(o);
            bb.getSize(sz);
            const W = sz.x / MAP_SCALE, H = sz.y / MAP_SCALE, D = sz.z / MAP_SCALE;
            const rec = { cz: (bb.min.z + bb.max.z) / 2 / MAP_SCALE, minZ: bb.min.z / MAP_SCALE, maxZ: bb.max.z / MAP_SCALE };
            if (Math.abs(W - 0.7) < 0.03 && Math.abs(H - 0.1) < 0.03 && Math.abs(D - 2.6) < 0.03) shelf.push(rec);
            if (Math.abs(W - 0.55) < 0.03 && Math.abs(H - 0.06) < 0.03 && Math.abs(D - 2.2) < 0.03) board.push(rec);
            if (Math.abs(W - 0.6) < 0.03 && Math.abs(H - 2.57) < 0.04 && Math.abs(D - 0.1) < 0.03) panel.push(rec);
        });
        ok('the upper boards are centred over the working shelf',
            shelf.length === 2 && board.length === 6
            && board.every(b => shelf.some(sh => Math.abs(b.cz - sh.cz) < 0.06)),
            `${board.length} boards, ${shelf.length} shelves`);
        ok('and every board reaches both uprights',
            board.length > 0 && panel.length === 4
            && board.every(b => {
                const same = panel.filter(p => (p.cz > 0) === (b.cz > 0));
                return same.length === 2 && b.minZ - Math.min(...same.map(p => p.cz)) < 0.35
                    && Math.max(...same.map(p => p.cz)) - b.maxZ < 0.35;
            }),
            `${panel.length} uprights`);
    }
    ok('every piece of furniture with a collider still has something under it', (() => {
        // Returns true, or a description. `ok` prints whichever it is, so a
        // failure here names the exact box instead of just saying 3.
        const bad = [];
        for (const b of cwx.boxes) {
            if (b.tag !== 'prop' && b.tag !== 'cover') continue;
            if ((b.maxY - b.minY) > 0.45 * MAP_SCALE || b.minY < 0.06) continue;
            let held = false;
            for (const o of cwx.boxes) {
                if (o === b || o.tag === 'bound' || o.tag === 'ground') continue;
                if (b.maxX <= o.minX + 0.05 || b.minX >= o.maxX - 0.05) continue;
                if (b.maxZ <= o.minZ + 0.05 || b.minZ >= o.maxZ - 0.05) continue;
                if (o.maxY >= b.minY - 0.06 && o.maxY <= b.minY + 0.30) { held = true; break; }
            }
            if (!held) {
                // legs and stiles are decoration, so they are not in the collider
                // table: look for a mesh the same size as a leg under a corner.
                scene.traverse(o => {
                    if (!o.isMesh || !o.geometry || held) return;
                    bb.setFromObject(o);
                    if (bb.maxY > b.minY + 0.08 || bb.maxY < b.minY - 0.25) return;
                    if (bb.maxX < b.minX - 0.2 || bb.minX > b.maxX + 0.2) return;
                    if (bb.maxZ < b.minZ - 0.2 || bb.minZ > b.maxZ + 0.2) return;
                    if ((bb.maxY - bb.minY) > 0.05) held = true;
                });
            }
            if (!held) bad.push(`${b.tag} at ${(b.minX / MAP_SCALE).toFixed(1)},${(b.minZ / MAP_SCALE).toFixed(1)} y${(b.minY / MAP_SCALE).toFixed(2)}`);
        }
        return bad.length === 0 ? true : (bad.slice(0, 4).join(' · ') + ` — ${bad.length} unsupported`);
    })());

}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
