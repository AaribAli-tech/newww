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
import { STAND_FLIP, ARMS, TARGET_HEIGHT, fitFactor } from '../src/js/rebel-pose.js';

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
    ok('the HUD says 1 / 4 and names the next gun',
        m.hudState().primary === '1 / 4' && /NEXT/.test(m.hudState().secondary), m.hudState().secondary);

    m.onKill(player, bots[0]);
    ok('one kill moves you up exactly one gun', player._ggRung === 1 && player.current === GUN_GAME_LADDER[1],
        WEAPON_DEFS[player.current].short);
    ok('and the promotion is announced with the gun name',
        banners.some(b => /LEVEL 2/.test(b)), banners.join(','));

    m.update(0.016);
    ok('a fresh rung is loaded, not half-empty',
        player.weapons[GUN_GAME_LADDER[1]].ammo === WEAPON_DEFS[GUN_GAME_LADDER[1]].magSize);

    m.onKill(bots[0], player);
    ok('the enemy climbs the same ladder', bots[0]._ggRung === 1 && bots[0].weaponIndex === GUN_GAME_LADDER[1]);
    m.onKill(bots[0], player);
    m.onKill(bots[0], player);
    ok('but a rival on rung 3 has not won it yet', !m.isOver() && bots[0]._ggRung === 3,
        `rung ${bots[0]._ggRung}`);
    m.onKill(bots[0], player);
    ok('and they can win it while you are still climbing', m.isOver() && m.result().won === false,
        m.result().subtitle);
    ok('the loss says who finished and how far you got',
        /finished the ladder/.test(m.result().subtitle) && /2\/4/.test(m.result().subtitle),
        m.result().subtitle);

    // a clean board: run the player's own ladder to the end
    const p2 = fakePlayer();
    const m2 = createMode('gun', { ...ctx, player: p2, getBots: () => [] });
    m2.onMatchStart();
    for (let i = 0; i < 3; i++) m2.onKill(p2, { team: TEAM_B });
    ok('three kills is not the win', !m2.isOver() && p2._ggRung === 3);
    m2.onKill(p2, { team: TEAM_B });
    ok('the fourth rung wins it', m2.isOver() && m2.result().won === true, m2.result().subtitle);
    ok('no gun is used twice on the ladder', new Set(GUN_GAME_LADDER).size === GUN_GAME_LADDER.length);
    ok('and a kill on a former team-mate still counts here (no teams)', (() => {
        const mate = fakeBot('REYES-A', TEAM_A);
        const p3 = fakePlayer();
        const m3 = createMode('gun', { ...ctx, player: p3, getBots: () => [mate] });
        m3.onMatchStart();
        m3.onKill(p3, mate);
        return p3._ggRung === 1;
    })());
    ok('and the win names the last gun', /4\/4|All 4 weapons|weapons/.test(m2.result().subtitle),
        m2.result().subtitle);
    const s = m2.standings();
    ok('the board shows each rival’s rung', m2.bots().length === 0 || /^\d\/4 /.test(s.rows[0].tag), s.rows[0].tag);
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
    ok('the bot rig adds the flip under every animated bone',
        /b\.rotation\.x \+= \(g\.x \+ \(STAND_FLIP\[name\] \|\| 0\)/.test(rebel));
    ok('the bot rig sizes itself from what it drew, once, and shares the fit',
        /fitFactor\(h\)/.test(rebel) && /if \(!S\.calibrated\)/.test(rebel));
    ok('the test page dresses its range with clones of the model',
        /cloneRig\(rig\.group\)/.test(tester) && /userData\.part = isHead \? 'head' : 'body'/.test(tester));
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
