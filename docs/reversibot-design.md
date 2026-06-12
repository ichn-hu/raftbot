# Reversibot Design

Reversibot is a RaftBot demo that lets two Slock users or agents play Reversi/Othello in a Slock thread. It is also the first framework consumer that needs generated HTML attachments.

## Decisions

- Delivery boundary: one PR contains the framework attachment API, the Reversibot demo, and this design record.
- Start command: a channel top-level `@bot /start @playerA @playerB` creates a game in that message's thread. Extra words are allowed; the first two `@handle` tokens after `/start` are the players.
- Player assignment: player A is black and moves first; player B is white.
- Thread scope: one active game per thread, with multiple threads/games running concurrently.
- Turn authority: `/place <coord>` is accepted only from the current player's Slock sender handle.
- Move format: `/place d3`, using columns `a-h` and rows `1-8`.
- Game control: `/status` and `/resign`; no undo.
- Board output: every turn sends text summary plus a static HTML board attachment. Text includes the legal `/place` commands so agents do not need to parse JavaScript.
- Human HTML UX: clicking a legal square selects the corresponding command and shows a Ctrl+C/Cmd+C hint. Clipboard writes are best-effort only because iframe sandboxing may block them.
- Persistence: game state is stored in the bot instance workspace state JSON, keyed by thread target. A daemon restart can resume games from local workspace state.

## Framework API

Reversibot uses:

```js
await ctx.reply(text, {
  attachments: [{
    filename: "reversibot-board.html",
    mimeType: "text/html",
    bytes: new TextEncoder().encode(html)
  }]
});
```

The framework resolves the reply target, uploads attachments, then sends the message with attachment IDs while preserving freshness retry behavior. Advanced code can call `ctx.uploadAttachment()` and later `ctx.reply(text, { attachmentIds })`.

## State Shape

`ctx.state.get("reversibot.games", {})` stores an object keyed by thread target:

```json
{
  "#raftbot-devs:12345678": {
    "id": "rev_mabc123",
    "threadTarget": "#raftbot-devs:12345678",
    "status": "active",
    "players": {
      "black": "@alice",
      "white": "@bob"
    },
    "engineState": {},
    "moveHistory": []
  }
}
```

Completed games remain for `/status` and auditability, but no new `/place` is accepted after completion.

## Rules Engine

The demo uses `@llmletsplay/versus-othello` for legal move validation, disc flipping, pass handling, and terminal scoring. Reversibot wraps that engine with Slock-specific state, player handles, coordinates, and rendering.
