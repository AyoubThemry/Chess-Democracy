import type { Team } from "../game/game-state.js";

/**
 * Who is in the current game and on which side, fixed when the countdown
 * starts. Empty outside a game.
 *
 * Before this, "the game" meant "whoever is connected right now", so a new
 * app appearing on the LAN mid-game joined the peer list and could even
 * become master.
 */
export class Roster {
    private readonly teams = new Map<string, Team>();

    get inGame(): boolean { return this.teams.size > 0; }
    get size():   number  { return this.teams.size; }

    has(key: string): boolean              { return this.teams.has(key); }
    teamOf(key: string): Team | undefined  { return this.teams.get(key); }

    /** Fix the players for a game. Anyone without a side isn't in it. */
    record(players: Iterable<[key: string, team: Team | null]>): void {
        this.teams.clear();
        for (const [key, team] of players) {
            if (team) this.teams.set(key, team);
        }
    }

    clear(): void { this.teams.clear(); }

    /** Of these connected players, the ones in the game. Outside a game, all of them. */
    playing(connected: readonly string[]): string[] {
        return this.inGame ? connected.filter(key => this.teams.has(key)) : [...connected];
    }

    /** The lowest key among the connected players in the game. It picks the game id and counts the votes. */
    master(connected: readonly string[]): string {
        return this.playing(connected).sort()[0];
    }

    /**
     * Votes are only counted while more than half the players are connected.
     * Without this a player who drops out is alone, counts as master, and
     * keeps playing a game of their own that can't be merged back.
     */
    hasQuorum(connected: readonly string[]): boolean {
        return !this.inGame || this.playing(connected).length * 2 > this.teams.size;
    }
}
