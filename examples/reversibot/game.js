import { OthelloGame } from "@llmletsplay/versus-othello";

const BLACK = "black";
const WHITE = "white";
const COLUMNS = "abcdefgh";

export async function createGame({ threadTarget, startMessageId, black, white }) {
  const engine = new OthelloGame(`rev_${Date.now().toString(36)}`);
  const state = await engine.initializeGame();
  return normalizeGame({
    id: state.gameId,
    threadTarget,
    startMessageId,
    status: "active",
    players: { black, white },
    winner: null,
    resignedBy: null,
    engineState: state,
    moveHistory: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

export function getGameForThread(games, threadTarget) {
  const game = games?.[threadTarget];
  return game ? normalizeGame(game) : null;
}

export function currentPlayerHandle(game) {
  return game.players[game.engineState.currentPlayer];
}

export function opponentColor(color) {
  return color === BLACK ? WHITE : BLACK;
}

export async function handleMove(game, coord) {
  const move = parseCoordinate(coord);
  if (!move) {
    return {
      ok: false,
      message: `Invalid move "${coord || "(missing)"}". Use /place d3 with columns a-h and rows 1-8.`
    };
  }

  const engine = await engineFromGame(game);
  const state = await engine.getGameState();
  const legal = coordinateList(state.validMoves);
  if (!legal.includes(move.coord)) {
    return {
      ok: false,
      message: `Illegal move: ${move.coord}. Legal moves: ${legal.map((item) => `/place ${item}`).join(", ") || "(none)"}`
    };
  }

  const beforePlayer = state.currentPlayer;
  let nextState;
  try {
    nextState = await engine.makeMove({
      row: move.row,
      col: move.col,
      player: beforePlayer
    });
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err)
    };
  }

  const updated = normalizeGame({
    ...game,
    engineState: nextState,
    moveHistory: [
      ...game.moveHistory,
      {
        player: beforePlayer,
        handle: game.players[beforePlayer],
        coord: move.coord,
        at: new Date().toISOString()
      }
    ],
    updatedAt: new Date().toISOString()
  });

  if (nextState.gameOver) {
    updated.status = "completed";
    updated.winner = winnerFromScore(updated);
  }

  const passNote = !nextState.gameOver && nextState.passCount > 0
    ? ` ${game.players[opponentColor(nextState.currentPlayer)]} had no legal move and was skipped.`
    : "";
  const outcome = updated.status === "completed"
    ? ` Game over. ${winnerText(updated)}`
    : ` ${currentPlayerHandle(updated)} is next.`;

  return {
    ok: true,
    game: updated,
    message: `${game.players[beforePlayer]} placed ${move.coord}.${passNote}${outcome}`
  };
}

export async function resignGame(game, sender) {
  const color = game.players.black === sender ? BLACK : WHITE;
  const winner = opponentColor(color);
  return normalizeGame({
    ...game,
    status: "completed",
    winner,
    resignedBy: sender,
    updatedAt: new Date().toISOString()
  });
}

export function commandList(game) {
  return listLegalCommands(game).slice(0, 8);
}

export function listLegalCommands(game) {
  if (game.status !== "active") return [];
  return coordinateList(game.engineState.validMoves).map((coord) => `/place ${coord}`);
}

export function gameSummary(game) {
  const score = `${game.players.black} black ${game.engineState.blackScore} - ${game.engineState.whiteScore} white ${game.players.white}`;
  if (game.status === "active") {
    return [
      `Thread: ${game.threadTarget}`,
      `Turn: ${currentPlayerHandle(game)} (${game.engineState.currentPlayer})`,
      `Score: ${score}`
    ].join("\n");
  }
  return [
    `Thread: ${game.threadTarget}`,
    `Final score: ${score}`,
    winnerText(game)
  ].join("\n");
}

export function winnerText(game) {
  if (game.resignedBy) {
    return `${game.players[game.winner]} wins by resignation.`;
  }
  if (game.winner === "draw") return "Result: draw.";
  return `${game.players[game.winner]} wins.`;
}

export function parseCoordinate(value) {
  const match = String(value ?? "").trim().toLowerCase().match(/^([a-h])([1-8])$/);
  if (!match) return null;
  const col = COLUMNS.indexOf(match[1]);
  const row = Number(match[2]) - 1;
  return { row, col, coord: `${match[1]}${match[2]}` };
}

export function coordinateList(moves = []) {
  return moves
    .map(([row, col]) => `${COLUMNS[col]}${row + 1}`)
    .sort();
}

export async function engineFromGame(game) {
  const engine = new OthelloGame(game.id);
  await engine.restoreFromDatabase({
    gameId: game.id,
    gameType: "othello",
    gameState: game.engineState,
    moveHistory: [],
    players: [game.players.black, game.players.white],
    status: game.status === "active" ? "active" : "completed"
  });
  return engine;
}

function normalizeGame(game) {
  return {
    ...game,
    players: {
      black: normalizeHandle(game.players?.black),
      white: normalizeHandle(game.players?.white)
    },
    moveHistory: Array.isArray(game.moveHistory) ? game.moveHistory : []
  };
}

function normalizeHandle(handle) {
  const raw = String(handle ?? "").trim();
  return raw.startsWith("@") ? raw : `@${raw}`;
}

function winnerFromScore(game) {
  if (game.engineState.blackScore > game.engineState.whiteScore) return BLACK;
  if (game.engineState.whiteScore > game.engineState.blackScore) return WHITE;
  return "draw";
}
