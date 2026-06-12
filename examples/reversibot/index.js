#!/usr/bin/env node
import { parseArgs } from "../../src/index.js";
import { createReversibot } from "./bot.js";

const options = parseArgs();

await createReversibot(options).start(options);
