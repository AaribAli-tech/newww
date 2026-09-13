// ============================================================================
// gamemode.js — the score and clock every mode keeps its books with.
//
// The rules themselves live in modes.js; this stays a dumb tally so Round
// Control (counting round wins) and Gun Game (counting kills it never ends on)
// can reuse it without inheriting Team Deathmatch's win condition.
// ============================================================================
import { TEAM_A, TEAM_B } from './utils.js';

export class TeamDeathmatch {
    constructor(scoreLimit = 75, timeLimit = 600) {
        this.scoreLimit = scoreLimit;
        this.timeLimit = timeLimit;
        this.reset();
    }

    reset() {
        this.teamAScore = 0;
        this.teamBScore = 0;
        this.timeRemaining = this.timeLimit;
        this.matchOver = false;
        this.winner = -1;
        this.endReason = '';
    }

    addKill(team, n = 1) {
        if (this.matchOver) return;
        if (team === TEAM_A) this.teamAScore += n; else this.teamBScore += n;
        if (this.teamAScore >= this.scoreLimit) this._end(TEAM_A, 'Score limit reached');
        else if (this.teamBScore >= this.scoreLimit) this._end(TEAM_B, 'Score limit reached');
    }

    /** The nuke ends the round outright for whoever called it. */
    nukeWin(team) { this._end(team, 'Tactical nuke'); }

    /**
     * End on something that is not a score or the clock — Gun Game finishes on
     * a ladder completion, Round Control on the third round win.
     */
    forceEnd(winner, reason) { this._end(winner, reason); }

    /** Whoever is ahead right now; ties go to the player's team. */
    get leader() { return this.teamAScore >= this.teamBScore ? TEAM_A : TEAM_B; }

    _end(winner, reason) {
        this.matchOver = true;
        this.winner = winner;
        this.endReason = reason;
    }

    update(dt) {
        if (this.matchOver) return;
        // An Infinity limit stays Infinity, which is how the untimed modes opt
        // out of the clock without a special case here.
        this.timeRemaining -= dt;
        if (this.timeRemaining <= 0) {
            this.timeRemaining = 0;
            this._end(this.teamAScore >= this.teamBScore ? TEAM_A : TEAM_B, 'Time expired');
        }
    }
}

const _counts = { a: 0, b: 0 };

/**
 * Alive head-count per team, player included on A. Round modes ask for this
 * every frame, so it fills a caller-owned object instead of allocating one.
 */
export function countAlive(player, bots, out = _counts) {
    out.a = player && player.alive ? 1 : 0;
    out.b = 0;
    if (bots) {
        for (let i = 0; i < bots.length; i++) {
            const b = bots[i];
            if (!b || !b.alive) continue;
            if (b.team === TEAM_B) out.b++; else out.a++;
        }
    }
    return out;
}

export { TEAM_A, TEAM_B };
