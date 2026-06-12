#!/usr/bin/env node
import { parseArgs, startBotDaemon } from "../../src/index.js";
import { createClockAvatarBot } from "../clock-avatar-bot/bot.js";
import { createProdDbOperatorBot } from "../prod-db-operator/bot.js";
import { createReversibot } from "../reversibot/bot.js";

const options = parseArgs();

await startBotDaemon([
  createProdDbOperatorBot(options),
  createClockAvatarBot(options),
  createReversibot(options)
], {
  defaultModelId: "prod-db-operator",
  ...options
});
