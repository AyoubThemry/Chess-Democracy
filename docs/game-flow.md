# Game Flow

Full sequence from node boot to game over.

```mermaid
sequenceDiagram
    participant P as Player (Node)
    participant N as Network (mDNS)
    participant R as Renderer (React)

    Note over P,N: Discovery & Handshake
    P->>N: Publishes service via mDNS
    N-->>P: Discovers peer(s)
    P->>P: TCP handshake + Ed25519 signature verify
    P->>R: push peer:joined

    Note over P,R: Lobby
    R->>P: invoke game:set_team {white|black}
    P->>N: broadcast team
    R->>P: invoke game:ready
    P->>N: broadcast ready
    P->>P: all-ready poll (every 2 s)
    P->>R: push game:starting {startsAt, countdownMs}
    P->>R: push game:started {gameId, fen, legalMoves}

    Note over P,R: Config handshake (optional, lobby phase)
    R->>P: invoke game:set_config {voteWindowMs, maxRevotes, ...}
    P->>N: broadcast config_proposal
    N-->>P: peers reply config_accepted
    P->>R: push config:peer_accepted / config:self_accepted

    Note over P,R: In-game — voting round
    P->>R: push vote:window_opened {turnIndex, windowCloseAt}
    R->>P: invoke game:cast_vote {move}
    P->>N: broadcast vote
    N-->>P: peers broadcast vote
    P->>R: push vote:received
    P->>P: tally when window closes
    alt winner found
        P->>N: broadcast move
        P->>R: push tally:done {move, fen, legalMoves}
    else 3-way split
        P->>R: push revote:started
        Note over P,R: repeat vote round (max maxRevotes times)
    else revotes exhausted
        P->>N: broadcast game_over {reason: revotes_exhausted}
        P->>R: push game:over
    end

    Note over P,R: Game over (any reason)
    P->>N: broadcast game_over {winner, reason, fen}
    P->>R: push game:over {result, lastFen}
    R->>P: invoke game:reset (rematch)
```

## Game-ending reasons

| Reason | Trigger |
|---|---|
| `checkmate` | Chess engine detects checkmate |
| `stalemate` | Chess engine detects stalemate |
| `resignation` | Resign vote reaches ≥ resignThreshold of connected team |
| `disconnect` | Peer disconnect detected mid-game |
| `draw_agreement` | Both sides accept a draw offer |
| `revotes_exhausted` | No plurality after maxRevotes re-vote rounds |
| `timeout` | No vote cast before MOVE_TIMEOUT_MS (120 s hard cap) |
