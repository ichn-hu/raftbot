#!/usr/bin/env node
import { createBot, parseArgs } from "../../src/index.js";
import { renderClockPng } from "./render-clock.js";

const options = {
  runtimeLabel: "Clock Bot",
  modelId: "clock-bot",
  ...parseArgs()
};
const timeZone = options.timeZone || "UTC";
const lastMinuteByAgent = new Map();

const bot = createBot();

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
    "It updates the avatar and description every minute."
  ].join("\n"));
});

await bot.start(options);

async function syncClock(ctx) {
  const now = new Date();
  const minuteKey = formatMinuteKey(now, timeZone);
  if (lastMinuteByAgent.get(ctx.agentId) === minuteKey) return;
  lastMinuteByAgent.set(ctx.agentId, minuteKey);

  const png = renderClockPng(now);
  await ctx.profile.setAvatar({
    filename: "clock-avatar.png",
    mimeType: "image/png",
    bytes: png
  });
  await ctx.profile.update({
    description: `Clock Bot · ${formatDescriptionTime(now, timeZone)}`
  });
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
