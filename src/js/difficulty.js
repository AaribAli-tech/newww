// ============================================================================
// difficulty.js — what the other side is good at, in one place.
//
// The bots already had a `skill` number per individual, rolled at spawn, and
// nothing above it: everyone on the server played the same fight. This is the
// knob the player gets to turn. It deliberately does not touch how much damage a
// bullet does or how much health a bot has — a harder opponent should be harder to
// hit, not a bag of hit points that survives three rifles to the chest.
//
// Three levers, all read by ai.js:
//   aimScale     — multiplied into the chance that a burst connects at all
//   spreadScale  — how far a miss is sprayed from where they were aiming
//   reactionScale — how long from spotting you to shooting back
// plus `chanceCap`, because "hard" is also "they rarely have an off day".
//
// No DOM, no three.js: scripts/test-rules.mjs runs this file directly.
// ============================================================================

export const DIFFICULTIES = [
    {
        id: 'easy', name: 'Easy',
        blurb: 'Recruits. They swing wide, they spot you late, and most of their magazine is in the dirt.',
        skill: [0.12, 0.30],        // the per-bot roll, so a squad is not identical
        aimScale: 0.42, spreadScale: 2.3, reactionScale: 2.1, chanceCap: 0.30
    },
    {
        id: 'medium', name: 'Medium',
        blurb: 'The fight the game is balanced around. They hit what they can see and punish standing still.',
        skill: [0.32, 0.62],
        aimScale: 1.0, spreadScale: 1.0, reactionScale: 1.0, chanceCap: 0.72
    },
    {
        id: 'hard', name: 'Hard',
        blurb: 'Veterans. They lead you, they pre-aim the door, and they do not miss twice at 20 metres.',
        skill: [0.66, 0.92],
        aimScale: 1.55, spreadScale: 0.55, reactionScale: 0.6, chanceCap: 0.88
    }
];

export const DEFAULT_DIFFICULTY = 'medium';

export function difficultyById(id) {
    return DIFFICULTIES.find(d => d.id === id) || DIFFICULTIES.find(d => d.id === DEFAULT_DIFFICULTY);
}

export const isDifficulty = id => DIFFICULTIES.some(d => d.id === id);

/** A per-bot skill roll inside the band the difficulty allows. */
export function rollSkill(d, rand = Math.random) {
    const [lo, hi] = d.skill;
    return lo + rand() * (hi - lo);
}

/**
 * Put a difficulty on a bot. Called at spawn and again whenever the player changes
 * the setting, so a mid-match switch takes effect on the enemies already alive
 * rather than only on the next spawn.
 */
export function applyDifficulty(bot, d) {
    if (!bot || !d) return bot;
    d = typeof d === 'string' ? difficultyById(d) : d;
    bot.difficulty = d.id;
    bot.aimScale = d.aimScale;
    bot.spreadScale = d.spreadScale;
    bot.reactionScale = d.reactionScale;
    bot.chanceCap = d.chanceCap;
    return bot;
}

/** Fresh bot for a difficulty: the skill roll and the scales in one call. */
export function skillFor(d, bot, rand = Math.random) {
    const entry = typeof d === 'string' ? difficultyById(d) : d;
    if (bot) { bot.skill = rollSkill(entry, rand); applyDifficulty(bot, entry); }
    return bot;
}

/** One line for the menu/settings card, so the choice says what it does. */
export function describe(d) {
    const entry = typeof d === 'string' ? difficultyById(d) : d;
    return `${entry.name} — ${entry.blurb}`;
}
