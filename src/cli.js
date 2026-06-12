#!/usr/bin/env node
import { parseArgs } from "./cli-options.js";

try {
  const options = parseArgs();
  console.log("RaftBot framework CLI");
  console.log(`serverUrl=${options.serverUrl}`);
  console.log("No default bot is bundled with the framework package. Run a bot package or an example instead.");
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
