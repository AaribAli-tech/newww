// ============================================================================
// medals.js — what a kill is worth on screen.
//
// Two separate counters get confused for each other in a lot of shooters, so
// they are kept apart here on purpose:
//
//   CHAIN   kills inside one short window of each other  → DOUBLE / TRIPLE /
//           MULTI KILL. Resets on its own when you pause, and on death.
//   STREAK  kills since you last died                    → ON A ROLL, RAMPAGE,
//           … and the killstreak rewards in killstreaks.js. Only death resets it.
//
// No DOM and no engine imports: the numbers are the interesting part, so they
// live somewhere `npm run test:rules` can exercise in plain Node. The HUD takes
// the medal list and renders it.
// ============================================================================

/** Two kills this far apart are two kills, not a double kill. */
export const CHAIN_WINDOW = 4.2;      // seconds

/** Kill-streak milestones. CoD-style names, and none of them gate a reward. */
export const MILESTONES = [
    { n: 3,  label: 'ON A ROLL' },
    { n: 5,  label: 'BLOODTHIRSTY' },
    { n: 7,  label: 'KILLING SPREE' },
    { n: 10, label: 'RAMPAGE' },
    { n: 13, label: 'DOMINATING' },
    { n: 16, label: 'UNSTOPPABLE' },
    { n: 20, label: 'RUTHLESS' },
    { n: 25, label: 'RELENTLESS' }
];

const TONE = {
    kill: 'rgba(255,255,255,.92)',
    head: '#FFC24A',
    double: '#67c6ff',
    triple: '#5AD469',
    multi: '#FF7A18',
    milestone: '#FF9A3C'
};

/**
 * Chain a kill into the medals it earns.
 *
 * `now` is the same clock the game feeds player.tryFire (seconds), never
 * Date.now(), so a paused or tab-throttled match cannot fake a double kill out
 * of two shots fired four seconds apart in real time but one frame apart here.
 */
export class KillChain {
    constructor(window = CHAIN_WINDOW) {
        this.window = window;
        this.count = 0;
        this.last = -1e9;
    }

    reset() { this.count = 0; this.last = -1e9; }

    get active() { return this.count > 0; }

    /**
     * @param {number} now  seconds
     * @param {boolean} head   the killing shot was to the head
     * @param {number} streak  kills since the player last died
     * @returns {{medals: Array<{id:string,label:string,sub:string,tone:string}>, chain: number}}
     */
    note(now, head, streak = 0) {
        this.count = (now - this.last <= this.window) ? this.count + 1 : 1;
        this.last = now;

        const medals = [];
        // The base medal every kill earns. Said out loud rather than left to the
        // hitmarker alone — the confirmation is most of the satisfaction.
        medals.push({ id: 'kill', label: 'KILL', sub: head ? '' : '+100', tone: TONE.kill });

        if (head) medals.push({ id: 'head', label: 'HEADSHOT', sub: '+150', tone: TONE.head });

        if (this.count === 2) {
            medals.push({ id: 'double', label: 'DOUBLE KILL', sub: '', tone: TONE.double });
        } else if (this.count === 3) {
            medals.push({ id: 'triple', label: 'TRIPLE KILL', sub: '', tone: TONE.triple });
        } else if (this.count >= 4) {
            // Past three the name stops counting and just says how loud it was.
            medals.push({ id: 'multi', label: 'MULTI KILL', sub: `×${this.count}`, tone: TONE.multi });
        }

        const m = milestoneFor(streak);
        if (m && m.n === streak) {
            medals.push({ id: 'milestone', label: m.label, sub: `×${streak} STREAK`, tone: TONE.milestone });
        }

        return { medals, chain: this.count };
    }
}

/** The highest milestone at or below `streak`, or null below the first one. */
export function milestoneFor(streak) {
    let got = null;
    for (const m of MILESTONES) if (streak >= m.n) got = m; else break;
    return got;
}

/** The next milestone still to come — what a progress bar fills toward. */
export function nextMilestone(streak) {
    for (const m of MILESTONES) if (m.n > streak) return m;
    return null;
}

/** Progress 0..1 through the current milestone band, for the streak strip. */
export function milestoneProgress(streak) {
    const next = nextMilestone(streak);
    if (!next) return 1;
    const from = milestoneFor(streak);
    const lo = from ? from.n : 0;
    const span = Math.max(1, next.n - lo);
    return Math.min(1, (streak - lo) / span);
}

export const MEDAL_TONE = TONE;
