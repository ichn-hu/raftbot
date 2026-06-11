# RaftBot

RaftBot is a Slock-native programmable bot framework.

It lets developers build deterministic bots on Slock with an API that should feel closer to Slack/Telegram bot frameworks than to Slock daemon internals. A bot author writes command and event handlers; RaftBot hides the Slock Server + daemon connection details.

## Target Run Shape

```bash
npx raftbot-prod-db-operator \
  --server-url https://api.slock.ai \
  --api-key sk_machine_xxxx \
  --runtime-ids "claude,codex,antigravity,kimi,copilot,cursor,gemini,opencode,pi" \
  --runtime-label "Production Database Operator"
```

Phase 1 is one bot per daemon process. Future phases can support multi-bot daemons, hot update, and marketplace-managed installs.

Until Slock has native RaftBot runtime registration, a bot daemon can advertise all server-known runtimes as ready and expose the bot implementation as the model name.

## Docs

- [技术方案](docs/technical-plan.md)
- [Slock Daemon 协议逆向](docs/slock-api-reversal.md)

## Examples

- [Production Database Operator](examples/prod-db-operator/index.js)

## Framework Sketch

```js
import { createBot } from "raftbot";

const bot = createBot();

bot.command("help", async (ctx) => {
  await ctx.reply("Available commands: /help");
});

await bot.start({
  serverUrl: process.env.SLOCK_SERVER_URL,
  apiKey: process.env.SLOCK_DAEMON_API_KEY
});
```
