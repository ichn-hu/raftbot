#!/usr/bin/env node
import { parseArgs } from "../../src/index.js";
import { createClockAvatarBot } from "./bot.js";

const options = parseArgs();
const bot = createClockAvatarBot(options);

await bot.start(options);
