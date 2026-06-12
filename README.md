# RaftBot

RaftBot is a Slock-native programmable bot framework.

It lets developers build deterministic bots on Slock with an API that should feel closer to Slack/Telegram bot frameworks than to Slock daemon internals. A bot author writes command and event handlers; RaftBot hides the Slock Server + daemon connection details.

## Target Run Shape

```bash
node examples/all-bots/index.js \
  --server-url https://api.slock.ai \
  --api-key sk_machine_xxxx \
  --runtime-ids "claude,codex,antigravity,kimi,copilot,cursor,gemini,opencode,pi"
```

The daemon reports each managed bot code package as a model. When a user creates a Slock Agent with model `clock-bot`, RaftBot maps that Agent to the local Clock Bot code; model `prod-db-operator` maps to the Production Database Operator code.

Until Slock has native RaftBot runtime registration, a bot daemon can advertise all server-known runtimes as ready and expose the bot implementation as the model name.

## Docs

- [技术方案](docs/technical-plan.md)
- [Framework API](docs/framework-api.md)
- [Programming Model](docs/programming-model.md)
- [Slock Daemon 协议逆向](docs/slock-api-reversal.md)

## Examples

- [Production Database Operator](examples/prod-db-operator/index.js)
- [Clock Avatar Bot](examples/clock-avatar-bot/index.js)
- [Combined demo daemon](examples/all-bots/index.js)

## Framework Sketch

```js
import { createBot, startBotDaemon } from "raftbot";

const bot = createBot({
  modelId: "help-bot",
  runtimeLabel: "Help Bot"
});

bot.onMessage(async (ctx) => {
  if (ctx.event.surface.kind === "channel" && !ctx.event.mentioned) return;
});

bot.command("help", async (ctx) => {
  await ctx.reply("Available commands: /help");
});

await bot.start({
  serverUrl: process.env.SLOCK_SERVER_URL,
  apiKey: process.env.SLOCK_DAEMON_API_KEY
});
```

For a daemon that manages multiple bot code packages, pass all bot definitions to `startBotDaemon()`. The framework will report the model list and dispatch each server Agent instance by `config.model`.
