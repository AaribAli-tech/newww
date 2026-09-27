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
import { SPAWN_A, SPAWN_B } from '../src/js/map.js';
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
    ok('and repaired: back on the map, aiming at nothing',
        healable.position.x === -11 && healable.velocity.x === 0
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
group('rebel-pose.js — the FBX calibration both pages share');
{
    const src = await readFile(new URL('../src/js/rebel-pose.js', import.meta.url), 'utf8');
    ok('the pose table is its own module, so the game and the tester cannot drift',
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
    const tester = await readFile(new URL('../src/tester/tester.js', import.meta.url), 'utf8');
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
    ok('neither page writes a channel the helper does not read (no .bend, no .rx)',
        !/\.bend\b/.test(rebel) && !/\.bend\b/.test(tester) && !/\.rx\b/.test(tester));
    ok('and the shared helper has one shape to accept, so the two cannot drift',
        /poseBones\(bones, rest, angles, \{ k = 1, flip = null, easeOthers = true \} = \{\}\)/.test(
            await readFile(new URL('../src/js/rebel-pose.js', import.meta.url), 'utf8')));
    ok('the test page decides it the same way and poses through the same helper',
        /rig\.standFlip = flipFromJoints\(jointY\)/.test(tester)
        && /poseBones\(b, s\.rest \|\| rig\.rest, t, \{/.test(tester)
        && /rig\.rest = restPoseOf\(rig\.bones\)/.test(tester));
    ok('the box is not what decides it any more, on either page',
        !/chooseStandFlip/.test(rebel) && !/chooseStandFlip/.test(tester));
    ok('the test page prints the evidence it judged on',
        /standJoints = \{/.test(tester) && /ankle \$\{rig\.standJoints\.ankleL\}/.test(tester));
    ok('neither page writes an angle by assignment any more',
        !/bone\.rotation\.[xyz] \+= \(tg\./.test(tester) && !/b\.rotation\.x \+= \(g\.x/.test(rebel));
    ok('and neither one clears the bones to measure them, which is how the fold was invented',
        !/setTable\(/.test(rebel) && !/setTable\(/.test(tester));
    ok('both pages agree on one joint table, imported rather than copied',
        /POSE_JOINTS/.test(await readFile(new URL('../src/js/rebel-pose.js', import.meta.url), 'utf8'))
        && /poseBones\(/.test(rebel) && /poseBones\(/.test(tester));
    ok('the bot rig sizes itself from what it drew, once, and shares the fit',
        /fitFactor\(h\)/.test(rebel) && /if \(!S\.calibrated\)/.test(rebel));
    ok('the test page dresses its range with clones of the model',
        /cloneRig\(rig\.group\)/.test(tester) && /userData\.part = isHead \? 'head' : 'body'/.test(tester));
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
    ok('the target is a named constant, not a number repeated in three places',
        /export const GUN_GAME_KILLS = 75;/.test(modes) && /this\.killTarget = GUN_GAME_KILLS;/.test(modes));
    ok('the playlist card says 75 kills and cycling guns',
        /75 kills · 4 guns, and they keep cycling as you climb\./.test(modes));
}

// ── 13. nothing ends up outside the fence ───────────────────────────────────
group('utils.js — the perimeter is a clamp, not a mesh');
{
    const U = await import('../src/js/utils.js');
    ok('the rectangle is the one the map uses', U.MAP_RECT.maxX === 42 && U.MAP_RECT.minZ === -40);
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

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
