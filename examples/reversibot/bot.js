import { createBot } from "../../src/index.js";
import {
  commandList,
  createGame,
  currentPlayerHandle,
  gameSummary,
  getGameForThread,
  handleMove,
  listLegalCommands,
  resignGame
} from "./game.js";
import { renderBoardHtml } from "./render-board.js";

const GAMES_STATE_KEY = "reversibot.games";

export function createReversibot() {
  const bot = createBot({
    modelId: "reversibot",
    runtimeLabel: "Reversibot"
  });

  bot.command("help", async (ctx) => {
    await ctx.reply([
      "Reversibot commands:",
      "@bot /start @playerA @playerB - start a game from a channel message",
      "/place d3 - place a disc when it is your turn",
      "/status - show the current board",
      "/resign - resign when it is your turn"
    ].join("\n"));
  });

  bot.command("start", async (ctx) => {
    if (ctx.event.surface.kind !== "channel") {
      await ctx.reply("Start a new Reversi game from a channel message, e.g. @bot /start @alice @bob.");
      return;
    }
    const handles = parseMentionHandles(ctx.event.commandText);
    if (handles.length < 2) {
      await ctx.reply("Usage: @bot /start @playerA @playerB");
      return;
    }
    if (handles[0] === handles[1]) {
      await ctx.reply("Choose two different players for a Reversi game.");
      return;
    }
    const games = await loadGames(ctx);
    if (games[ctx.event.replyTarget]?.status === "active") {
      await ctx.reply(`There is already an active Reversi game in ${ctx.event.replyTarget}.`);
      return;
    }
    const game = await createGame({
      threadTarget: ctx.event.replyTarget,
      startMessageId: ctx.event.id,
      black: handles[0],
      white: handles[1]
    });
    games[game.threadTarget] = game;
    await saveGames(ctx, games);
    await sendBoard(ctx, game, "Game started.");
  });

  bot.command("status", async (ctx) => {
    const game = await findThreadGame(ctx);
    if (!game) return;
    await sendBoard(ctx, game, "Current game status.");
  });

  bot.command("place", async (ctx) => {
    const game = await findThreadGame(ctx);
    if (!game) return;
    if (game.status !== "active") {
      await ctx.reply(`This game is already ${game.status}.`);
      return;
    }
    const expected = currentPlayerHandle(game);
    if (ctx.event.sender !== expected) {
      await ctx.reply(`It is ${expected}'s turn. ${ctx.event.sender || "This sender"} cannot place now.`);
      return;
    }
    const result = await handleMove(game, ctx.args[0] ?? "");
    if (!result.ok) {
      await ctx.reply(result.message);
      return;
    }
    const games = await loadGames(ctx);
    games[game.threadTarget] = result.game;
    await saveGames(ctx, games);
    await sendBoard(ctx, result.game, result.message);
  });

  bot.command("resign", async (ctx) => {
    const game = await findThreadGame(ctx);
    if (!game) return;
    if (game.status !== "active") {
      await ctx.reply(`This game is already ${game.status}.`);
      return;
    }
    const expected = currentPlayerHandle(game);
    if (ctx.event.sender !== expected) {
      await ctx.reply(`Only the current player can resign. It is ${expected}'s turn.`);
      return;
    }
    const resigned = await resignGame(game, ctx.event.sender);
    const games = await loadGames(ctx);
    games[game.threadTarget] = resigned;
    await saveGames(ctx, games);
    await sendBoard(ctx, resigned, `${ctx.event.sender} resigned.`);
  });

  return bot;

  async function findThreadGame(ctx) {
    if (ctx.event.surface.kind !== "thread") {
      await ctx.reply("Use this command inside a Reversi game thread.");
      return null;
    }
    const games = await loadGames(ctx);
    const game = getGameForThread(games, ctx.event.target);
    if (!game) {
      await ctx.reply("No Reversi game is active in this thread.");
      return null;
    }
    return game;
  }

  async function sendBoard(ctx, game, intro) {
    const text = [
      intro,
      gameSummary(game),
      "",
      game.status === "active"
        ? `${currentPlayerHandle(game)} to move: ${commandList(game).join(" ")}`
        : "Game complete.",
      "",
      `Legal commands: ${listLegalCommands(game).join(", ") || "(none)"}`
    ].join("\n");
    const html = renderBoardHtml(game);
    await ctx.reply(text, {
      target: game.threadTarget,
      attachments: [{
        target: game.threadTarget,
        filename: `reversibot-${game.id}.html`,
        mimeType: "text/html",
        bytes: new TextEncoder().encode(html)
      }]
    });
  }
}

async function loadGames(ctx) {
  const games = await ctx.state.get(GAMES_STATE_KEY, {});
  return games && typeof games === "object" && !Array.isArray(games) ? games : {};
}

async function saveGames(ctx, games) {
  await ctx.state.set(GAMES_STATE_KEY, games);
}

function parseMentionHandles(text) {
  return [...String(text ?? "").matchAll(/@([A-Za-z0-9_.-]+)/g)]
    .map((match) => `@${match[1]}`);
}
