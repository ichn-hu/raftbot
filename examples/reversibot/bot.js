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
    const mention = botMention(ctx);
    await ctx.reply([
      "Reversibot commands:",
      `${mention} /start @playerA @playerB - start a game from a channel message`,
      "/place d3 - place a disc when it is your turn",
      "/status - show the current board",
      "/resign - resign when it is your turn"
    ].join("\n"));
  });

  bot.command("start", async (ctx) => {
    if (ctx.event.surface.kind !== "channel") {
      await ctx.reply(`Start a new Reversi game from a channel message, e.g. ${botMention(ctx)} /start @alice @bob.`);
      return;
    }
    const handles = parseMentionHandles(ctx.event.commandText);
    if (handles.length < 2) {
      await ctx.reply(`Usage: ${botMention(ctx)} /start @playerA @playerB`);
      return;
    }
    if (handles[0] === handles[1]) {
      await ctx.reply("Choose two different players for a Reversi game.");
      return;
    }
    const result = await updateGames(ctx, async (games) => {
      if (games[ctx.event.replyTarget]?.status === "active") {
        return { ok: false, message: `There is already an active Reversi game in ${ctx.event.replyTarget}.` };
      }
      const game = await createGame({
        threadTarget: ctx.event.replyTarget,
        startMessageId: ctx.event.id,
        black: handles[0],
        white: handles[1]
      });
      games[game.threadTarget] = game;
      return { ok: true, game };
    });
    if (!result.ok) {
      await ctx.reply(result.message);
      return;
    }
    await sendBoard(ctx, result.game, "Game started.");
  });

  bot.command("status", async (ctx) => {
    const game = await findThreadGame(ctx);
    if (!game) return;
    await sendBoard(ctx, game, "Current game status.");
  });

  bot.command("place", async (ctx) => {
    if (ctx.event.surface.kind !== "thread") {
      await ctx.reply("Use this command inside a Reversi game thread.");
      return;
    }
    const result = await updateGames(ctx, async (games) => {
      const game = getGameForThread(games, ctx.event.target);
      if (!game) return { ok: false, message: "No Reversi game is active in this thread." };
      if (game.status !== "active") return { ok: false, message: `This game is already ${game.status}.` };

      const expected = currentPlayerHandle(game);
      if (ctx.event.sender !== expected) {
        return { ok: false, message: `It is ${expected}'s turn. ${ctx.event.sender || "This sender"} cannot place now.` };
      }

      const move = await handleMove(game, ctx.args[0] ?? "");
      if (!move.ok) return move;
      games[game.threadTarget] = move.game;
      return move;
    });
    if (!result.ok) {
      await ctx.reply(result.message);
      return;
    }
    await sendBoard(ctx, result.game, result.message);
  });

  bot.command("resign", async (ctx) => {
    if (ctx.event.surface.kind !== "thread") {
      await ctx.reply("Use this command inside a Reversi game thread.");
      return;
    }
    const result = await updateGames(ctx, async (games) => {
      const game = getGameForThread(games, ctx.event.target);
      if (!game) return { ok: false, message: "No Reversi game is active in this thread." };
      if (game.status !== "active") return { ok: false, message: `This game is already ${game.status}.` };

      const expected = currentPlayerHandle(game);
      if (ctx.event.sender !== expected) {
        return { ok: false, message: `Only the current player can resign. It is ${expected}'s turn.` };
      }

      const resigned = await resignGame(game, ctx.event.sender);
      games[game.threadTarget] = resigned;
      return { ok: true, game: resigned, message: `${ctx.event.sender} resigned.` };
    });
    if (!result.ok) {
      await ctx.reply(result.message);
      return;
    }
    await sendBoard(ctx, result.game, result.message);
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
  return normalizeGames(await ctx.state.get(GAMES_STATE_KEY, {}));
}

async function updateGames(ctx, mutator) {
  let result = null;
  await ctx.state.update(async (state) => {
    const games = normalizeGames(state[GAMES_STATE_KEY]);
    result = await mutator(games);
    state[GAMES_STATE_KEY] = games;
    return state;
  });
  return result;
}

function normalizeGames(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
}

function parseMentionHandles(text) {
  return [...String(text ?? "").matchAll(/@([A-Za-z0-9_.-]+)/g)]
    .map((match) => `@${match[1]}`);
}

function botMention(ctx) {
  return ctx.agent.profile?.name ? `@${ctx.agent.profile.name}` : "@bot";
}
