# RaftBot Framework API

RaftBot apps should be written against Slock-native framework primitives, not daemon wire messages or internal HTTP paths. The framework owns daemon connection, credential minting, delivery ack, activity, and Slock profile endpoints.

## Lifecycle

RaftBot separates bot code from bot instances:

- Bot code is the local package/model implementation, for example `Clock Bot`.
- A bot instance is a Slock Agent created on the server and delivered to the daemon as an `agentId`.
- One bot code package can have many running instances.

Lifecycle handlers run per Slock Agent identity. If one daemon advertises one bot model and the server starts three Agents using that model, each Agent receives an independent context, workspace, state file, and scheduler scope.

One RaftBot daemon can also advertise multiple bot code packages as a model list. The server-created Agent's selected `model` is the dispatch key back to local bot code:

```js
import { startBotDaemon } from "raftbot";

await startBotDaemon([
  createProdDbOperatorBot(),
  createClockAvatarBot()
], {
  serverUrl,
  apiKey,
  runtimeIds: "claude,codex,antigravity,kimi,copilot,cursor,gemini,opencode,pi"
});
```

When Slock sends `agent:start` with `config.model = "clock-bot"`, the framework starts a Clock Bot instance for that `agentId`; `config.model = "prod-db-operator"` starts a Production Database Operator instance.

```js
const bot = createBot();

bot.onStart(async (ctx) => {
  await ctx.profile.update({ description: "Starting" });
});

bot.onStop(async (ctx) => {
  // Cleanup external resources if needed.
});
```

`onStart` runs after the daemon receives `agent:start`, resolves the Agent profile, records running state, and sends `agent:status active`. `onStop` runs before the framework forgets local state for that Agent.

## Scheduler

Background work should be registered declaratively:

```js
bot.every("1m", async (ctx) => {
  await ctx.profile.update({ description: new Date().toISOString() });
});
```

Semantics:

- A job is started for each running Agent after `agent:start`.
- Jobs are stopped automatically on `agent:stop`.
- Stopping a job does not delete that Agent's workspace or state.
- A job does not run concurrently with itself for the same Agent; if a tick is still active, the next tick is skipped.
- Supported interval strings are `ms`, `s`, `m`, and `h`, for example `500ms`, `30s`, `1m`, `2h`.
- A job runs once immediately by default and then on the interval. Use `{ immediate: false }` to wait for the first interval.

## Profile

Bots can update their own Slock Agent profile:

```js
await ctx.profile.update({
  description: "Clock Bot · 2026-06-12 01:00 UTC"
});

await ctx.profile.setAvatar({
  filename: "clock.png",
  mimeType: "image/png",
  bytes: pngBuffer
});
```

The framework maps these calls to Slock profile APIs:

- `POST /internal/agent/<agentId>/profile` for description/displayName/avatarUrl.
- multipart `POST /internal/agent/<agentId>/profile/avatar` for image avatar upload.

The framework uses the daemon's machine credential for these profile write requests because the deployed Slock server requires machine-auth on the Agent profile routes. Bot code only receives `ctx.profile`; it does not touch machine credentials or profile endpoints directly. Runner credential minting stays within the deployed Slock server's supported scope list for Agent API actions such as message send.

## Context

Handlers receive a `ctx`:

```ts
interface BotContext {
  agentId: string;
  profile: {
    get(): Promise<AgentProfile>;
    update(input: {
      description?: string;
      displayName?: string;
      avatarUrl?: string;
    }): Promise<AgentProfile>;
    setAvatar(input: {
      filename: string;
      mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
      bytes: Uint8Array | Buffer;
    }): Promise<AgentProfile>;
  };
  reply?(text: string): Promise<void>;
  event?: BotMessageEvent;
}
```

Message command contexts additionally include `event`, `command`, `args`, and `reply()`. Lifecycle and scheduled contexts omit message-specific fields.

## Workspace And State

RaftBot mirrors Slock daemon's per-Agent workspace model. Each running Agent gets a local workspace directory:

```text
<workspaceRoot>/<agentId>/
```

By default `workspaceRoot` is the same path Slock daemon uses: `$SLOCK_HOME/agents`, or `~/.slock/agents` when `SLOCK_HOME` is unset. Override it with `workspaceRoot` or `RAFTBOT_WORKSPACE_ROOT` only for tests or custom deployments.

The workspace is keyed by bot instance (`agentId`), not by bot code. Two Clock Bot Agents share the same Clock Bot code but have separate workspaces and state files.

Bot writers should use `ctx.state` for small durable JSON state instead of directly reading and writing files:

```js
const zone = await ctx.state.get("timezone", "UTC");
await ctx.state.set("timezone", "Asia/Shanghai");
await ctx.state.delete("timezone");
const snapshot = await ctx.state.all();
```

The default implementation stores state in:

```text
<workspaceRoot>/<agentId>/state.json
```

This is local process state. It survives daemon process restart on the same machine and workspace, but it is not a server-side replication mechanism.

`ctx.workspace.path` exposes the workspace path for bot-specific artifacts that do not fit the key-value state API.
