#!/usr/bin/env node
import { parseArgs } from "../../src/index.js";
import { createProdDbOperatorBot } from "./bot.js";

const options = parseArgs();
const bot = createProdDbOperatorBot(options);

await bot.start(options);
