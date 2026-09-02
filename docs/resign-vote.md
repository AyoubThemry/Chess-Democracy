# Resign Vote Protocol

A single player cannot resign unilaterally. A majority of the currently connected teammates must vote yes within the vote window.

## Configuration (set at lobby, via config handshake)

| Key | Default | Meaning |
|---|---|---|
| `resignThreshold` | 0.67 | Fraction of connected team needed (e.g. 0.67 → 2 of 3) |
| `resignWindowMs` | 60 000 ms | Window auto-expires after this with no effect |

## Sequence

```mermaid
sequenceDiagram
    participant A as Player A (initiator)
    participant B as Player B (teammate)
    participant C as Player C (teammate)
    participant OPP as Opponent side

    Note over A,C: Game in progress — A clicks Resign
    A->>A: castResignVote()<br/>opens _resignVote window, adds self to yesVoters
    A->>A: emit resign:vote_started {expiresAt}
    A->>B: broadcast resign_vote (team-only, signed)
    A->>C: broadcast resign_vote (team-only, signed)
    Note over OPP: resign_vote never reaches opponent

    A->>A: checkResignThreshold()<br/>1/3 = 0.33 < 0.67 → no action

    B->>B: onResignVote(A's key)<br/>adds A to yesVoters
    B->>A: emit resign:vote_updated {yesVotes:1, teamSize:3}

    Note over B: B decides to vote
    B->>B: castResignVote()<br/>adds self to yesVoters
    B->>A: broadcast resign_vote
    B->>C: broadcast resign_vote
    B->>B: checkResignThreshold()<br/>2/3 = 0.67 ≥ 0.67 → _executeResign()

    B->>B: game.finish({winner: opponent, reason: resignation})
    B->>OPP: broadcast game_over
    B->>B: emit game:over → push GAME_OVER to renderer

    A->>A: onResignVote(B's key)<br/>yesVoters = {A, B}<br/>checkResignThreshold() → _executeResign()
```

## Disconnect handling

When a teammate disconnects mid-vote, `handlePeerDisconnect` calls `checkResignThreshold()`. The denominator shrinks — a vote that was at 1/3 (below threshold) becomes 1/2 or higher and may cross the threshold automatically.

```mermaid
sequenceDiagram
    participant A as Player A (voted)
    participant B as Player B (voted)
    participant C as Player C (has not voted, disconnects)

    Note over A,C: A and B voted. C has not. 2/3 = 0.67 ≥ threshold → not yet triggered<br/>(because C is still connected — teamSize = 3)

    C--xA: disconnects
    A->>A: handlePeerDisconnect(C)<br/>teamSize → 2, yesVoters = {A, B}<br/>checkResignThreshold(): 2/2 = 1.0 ≥ 0.67 → _executeResign()
```

## Expiry

If the window reaches `resignWindowMs` without threshold being met, the timer fires:

```mermaid
sequenceDiagram
    participant A as Player A
    participant Timer as setTimeout

    A->>Timer: starts resignWindowMs timer
    Note over Timer: ... 60 seconds pass ...
    Timer->>A: timer fires
    A->>A: _resignVote = null<br/>emit resign:vote_expired
    A->>A: Renderer: push RESIGN_VOTE_EXPIRED → closeResignVote()
```

## Deduplication rules

- A player's key can only appear in `yesVoters` once, regardless of how many times they click Resign or how many `resign_vote` messages arrive from the network.
- The threshold check uses `connectedTeamSize()` as the denominator — alive peers on the same team + self.
- Votes from disconnected players **remain** in `yesVoters`; only the denominator shrinks.
