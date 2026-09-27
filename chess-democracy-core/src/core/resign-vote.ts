/**
 * An open vote on our side to resign: who has said yes, and when it lapses.
 *
 * Resigning is a team decision. The vote passes once enough of the
 * connected team has said yes; if not enough do in time, it expires.
 */
export class ResignVote {
    readonly expiresAt: number;
    private readonly yes = new Set<string>();
    private readonly timer: NodeJS.Timeout;

    constructor(windowMs: number, onExpire: () => void) {
        this.expiresAt = Date.now() + windowMs;
        this.timer = setTimeout(onExpire, windowMs);
        this.timer.unref();
    }

    get yesVotes(): number { return this.yes.size; }

    hasVoted(key: string): boolean { return this.yes.has(key); }

    /** Records a yes. False if this player already voted. */
    add(key: string): boolean {
        if (this.yes.has(key)) return false;
        this.yes.add(key);
        return true;
    }

    /** Enough yes votes among the team members who are connected? */
    passes(connectedTeamSize: number, threshold: number): boolean {
        return connectedTeamSize > 0 && this.yes.size / connectedTeamSize >= threshold;
    }

    /** The vote ended some other way: it won't expire now. */
    cancel(): void {
        clearTimeout(this.timer);
    }
}
