import assert from "node:assert/strict";
import test from "node:test";
import {
  createGame,
  currentPlayerHandle,
  handleMove,
  listLegalCommands,
  parseCoordinate,
  resignGame
} from "./game.js";
import { renderBoardHtml } from "./render-board.js";

test("creates a standard game with black moving first", async () => {
  const game = await createGame({
    threadTarget: "#raftbot-devs:abc12345",
    startMessageId: "abc12345",
    black: "@alice",
    white: "@bob"
  });

  assert.equal(currentPlayerHandle(game), "@alice");
  assert.equal(game.engineState.blackScore, 2);
  assert.equal(game.engineState.whiteScore, 2);
  assert.deepEqual(listLegalCommands(game), ["/place d3", "/place c4", "/place f5", "/place e6"].sort());
});

test("parses standard coordinates", () => {
  assert.deepEqual(parseCoordinate("d3"), { row: 2, col: 3, coord: "d3" });
  assert.deepEqual(parseCoordinate("H8"), { row: 7, col: 7, coord: "h8" });
  assert.equal(parseCoordinate("3,4"), null);
});

test("applies a legal move through the engine", async () => {
  const game = await createGame({
    threadTarget: "#raftbot-devs:abc12345",
    startMessageId: "abc12345",
    black: "@alice",
    white: "@bob"
  });

  const result = await handleMove(game, "d3");
  assert.equal(result.ok, true);
  assert.equal(result.game.engineState.board[2][3], "black");
  assert.equal(result.game.engineState.blackScore, 4);
  assert.equal(result.game.engineState.whiteScore, 1);
  assert.equal(currentPlayerHandle(result.game), "@bob");
});

test("rejects invalid coordinates and illegal moves", async () => {
  const game = await createGame({
    threadTarget: "#raftbot-devs:abc12345",
    startMessageId: "abc12345",
    black: "@alice",
    white: "@bob"
  });

  assert.equal((await handleMove(game, "z9")).ok, false);
  const result = await handleMove(game, "a1");
  assert.equal(result.ok, false);
  assert.match(result.message, /Illegal move/);
});

test("resign completes the game", async () => {
  const game = await createGame({
    threadTarget: "#raftbot-devs:abc12345",
    startMessageId: "abc12345",
    black: "@alice",
    white: "@bob"
  });

  const resigned = await resignGame(game, "@alice");
  assert.equal(resigned.status, "completed");
  assert.equal(resigned.winner, "white");
});

test("serialized game state resumes and renders legal commands", async () => {
  const game = await createGame({
    threadTarget: "#raftbot-devs:abc12345",
    startMessageId: "abc12345",
    black: "@alice",
    white: "@bob"
  });
  const restored = JSON.parse(JSON.stringify(game));

  assert.deepEqual(listLegalCommands(restored), listLegalCommands(game));
  const html = renderBoardHtml(restored);
  assert.match(html, /\/place d3/);
  assert.match(html, /Press Ctrl\+C \/ Cmd\+C/);
});
