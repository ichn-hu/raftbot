import { createBot } from "../../src/index.js";
import { renderClockPng } from "./render-clock.js";

export function createClockAvatarBot(options = {}) {
  const defaultTimeZone = options.timeZone || "UTC";
  const lastMinuteByAgent = new Map();

  const bot = createBot({
    modelId: "clock-bot",
    runtimeLabel: "Clock Bot"
  });

  bot.onStart(async (ctx) => {
    await syncClock(ctx);
  });

  bot.every("1m", async (ctx) => {
    await syncClock(ctx);
  });

  bot.onStop(async (ctx) => {
    lastMinuteByAgent.delete(ctx.agentId);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply([
      "Clock Bot keeps this Agent profile synchronized with the current time.",
      "It updates the avatar and description every minute.",
      "",
      "/tz - show the current timezone",
      "/settz <timezone> - change timezone, e.g. /settz Asia/Shanghai"
    ].join("\n"));
  });

  bot.command("tz", async (ctx) => {
    const zone = await getTimeZone(ctx);
    await ctx.reply(`Timezone: ${zone}\nCurrent time: ${formatDescriptionTime(new Date(), zone)}`);
  });

  bot.command("settz", async (ctx) => {
    const zone = ctx.args.join(" ").trim();
    if (!zone) {
      await ctx.reply([
        "I need a timezone name.",
        "",
        "Usage: /settz <IANA timezone>",
        "Examples: /settz UTC, /settz Asia/Shanghai, /settz America/Los_Angeles"
      ].join("\n"));
      return;
    }
    if (!isValidTimeZone(zone)) {
      await ctx.reply([
        `I don't recognize "${zone}" as an IANA timezone.`,
        "",
        "Try one of these:",
        "/settz UTC",
        "/settz Asia/Shanghai",
        "/settz America/Los_Angeles"
      ].join("\n"));
      return;
    }
    await ctx.state.set("timezone", zone);
    lastMinuteByAgent.delete(ctx.agentId);
    await syncClock(ctx);
    await ctx.reply(`Timezone updated to ${zone}.\nCurrent time: ${formatDescriptionTime(new Date(), zone)}`);
  });

  return bot;

  async function syncClock(ctx) {
    const now = new Date();
    const timeZone = await getTimeZone(ctx);
    const minuteKey = formatMinuteKey(now, timeZone);
    if (lastMinuteByAgent.get(ctx.agentId) === minuteKey) return;

    const png = renderClockPng(now, { timeZone });
    await ctx.profile.setAvatar({
      filename: "clock-avatar.png",
      mimeType: "image/png",
      bytes: png
    });
    await ctx.profile.update({
      description: `Clock Bot · ${formatDescriptionTime(now, timeZone)}`
    });
    lastMinuteByAgent.set(ctx.agentId, minuteKey);
  }

  async function getTimeZone(ctx) {
    return ctx.state.get("timezone", defaultTimeZone);
  }
}

function isValidTimeZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function formatMinuteKey(date, zone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function formatDescriptionTime(date, zone) {
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short"
  }).format(date);
  return formatted.replace(",", "");
}
