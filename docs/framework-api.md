# RaftBot Framework API

RaftBot apps should be written against Slock-native framework primitives, not daemon wire messages or internal HTTP paths. The framework owns daemon connection, credential minting, delivery ack, activity, and Slock profile endpoints.

## Bot Definition

A bot package exports a bot definition. The definition declares the model shown to Slock Server and the handlers that run for each server-created Agent instance:

```js
import { createBot, startBotDaemon } from "raftbot";

const bot = createBot({
  modelId: "reversibot",
  runtimeLabel: "Reversibot"
});

bot.command("help", async (ctx) => {
  await ctx.reply("Available commands: /help");
});

bot.command("start", async (ctx) => {
  await ctx.reply("Started.");
});

bot.onMessage(async (ctx) => {
  // Observe every delivered message before command routing.
});

bot.onStart(async (ctx) => {
  // Initialize per-Agent resources.
});

bot.onStop(async (ctx) => {
  // Release per-Agent resources.
});

bot.every("1m", async (ctx) => {
  // Run background work for each running Agent instance.
});

await startBotDaemon([bot], {
  serverUrl: process.env.SLOCK_SERVER_URL,
  apiKey: process.env.SLOCK_DAEMON_API_KEY,
  runtimeIds: "claude,codex,antigravity,kimi,copilot,cursor,gemini,opencode,pi"
});
```

Definition methods:

- `createBot({ modelId, runtimeLabel, ...options })`: create one local bot code package. `modelId` is the dispatch key used when Slock starts an Agent with `config.model`.
- `bot.model(metadata)`: update model metadata after construction.
- `bot.command(name, handler)`: register a slash command. Names may be written with or without the leading slash.
- `bot.onMessage(handler)`: observe delivered messages before slash command routing. Today this hook is best for metrics, lightweight custom parsing, or side effects that should not replace command routing; the framework does not yet expose an explicit `ctx.handled()` escape hatch.
- `bot.onStart(handler)`: run after the framework receives `agent:start`, resolves the Agent profile, records running state, and reports active status.
- `bot.onStop(handler)`: run when the server stops this Agent instance, before local jobs are cancelled and running state is removed.
- `bot.every(interval, handler, options)`: register per-Agent scheduled work. Intervals support `ms`, `s`, `m`, and `h`; jobs run immediately by default unless `options.immediate === false`.
- `bot.start(options)`: convenience wrapper for starting a daemon with one bot definition.
- `startBotDaemon(bots, options)`: start one daemon that can expose multiple bot code packages as a model list.

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
  agent: {
    id: string;
    profile: AgentProfile | null;
    creator: null | { name: string; displayName?: string };
  };
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
  uploadAttachment?(input: {
    target?: string;
    filename: string;
    mimeType: string;
    bytes: Uint8Array | Buffer;
  }): Promise<Attachment>;
  reply?(text: string, options?: {
    target?: string;
    attachmentIds?: string[];
    attachments?: Array<{
      target?: string;
      filename: string;
      mimeType: string;
      bytes: Uint8Array | Buffer;
    }>;
  }): Promise<void>;
  attachments: {
    upload(target: string, input: {
      filename: string;
      mimeType: string;
      bytes: Uint8Array | Buffer;
    }): Promise<Attachment>;
  };
  send(target: string, text: string, options?: {
    attachmentIds?: string[];
    attachments?: Array<{
      target?: string;
      filename: string;
      mimeType: string;
      bytes: Uint8Array | Buffer;
    }>;
  }): Promise<void>;
  event?: BotMessageEvent;
}
```

Message command contexts additionally include `event`, `command`, `args`, and `reply()`. Lifecycle and scheduled contexts omit message-specific fields.

`ctx.reply()` is command-scoped and replies to the framework-selected default target. `ctx.send(target, ...)` can send to another Slock target, for example a manager DM.

Both methods accept text plus attachment options:

```js
await ctx.reply("Query result attached.", {
  attachments: [
    {
      filename: "result.csv",
      mimeType: "text/csv",
      bytes: Buffer.from(csvText, "utf-8")
    }
  ]
});
```

The framework uploads attachments first, then sends the message with the uploaded attachment IDs. For compatibility with older bot code, `ctx.reply()` and `ctx.send()` also accept an object shaped like `{ text, attachments, attachmentIds }`. If Slock's human-facing freshness guard holds the first send because newer messages arrived, the framework retries the same deterministic reply with the server-returned `seenUpToSeq` and `continueAnyway` semantics instead of surfacing a draft workflow to bot code.

## Message Event Shape

Command handlers receive a normalized `ctx.event` instead of raw daemon payloads:

```ts
type SurfaceKind = "channel" | "thread" | "dm";

interface BotMessageEvent {
  id: string;
  text: string;
  commandText: string;
  command: null | { name: string; args: string[] };

  target: string;
  replyTarget: string;

  sender: string;
  mentioned: boolean;
  mentionedName: string | null;
  addressed: boolean;

  surface:
    | { kind: "channel"; target: string; name: string }
    | {
        kind: "thread";
        target: string;
        threadShortId: string;
        parent: null | { kind: "channel" | "dm"; name: string };
      }
    | { kind: "dm"; target: string; name: string };
}
```

Routing semantics:

- Channel messages are routed to `bot.command(...)` only when the bot is addressed by mention, unless `ambientChannelCommands` is enabled.
- Thread messages are considered addressed, so follow-up slash commands do not need another bot mention.
- DM messages are considered addressed, so `/help`, `/config show`, and similar commands work directly.
- `commandText` is the message text with the leading bot mention stripped when applicable.
- `replyTarget` is the default target for `ctx.reply()`. For a channel top-level message, it is the thread under that message.
- If a DM message is not a slash command or names an unknown command, the framework replies with an unrecognized-message fallback and invokes the bot's `help` command when available.

## Attachments

Bots can attach generated artifacts to replies without handling Slock upload routes directly:

```js
await ctx.reply("Board snapshot attached.", {
  attachments: [{
    filename: "board.html",
    mimeType: "text/html",
    bytes: new TextEncoder().encode(html)
  }]
});
```

The framework resolves the reply target to a Slock channel id, uploads each attachment with the runner credential, then sends the reply with `attachmentIds`. HTML attachments should pass `mimeType: "text/html"` explicitly so the server renders/downloads them correctly.

For advanced flows, `ctx.uploadAttachment(input)` returns the raw uploaded attachment response, and `ctx.reply(text, { attachmentIds })` can attach previously uploaded files.

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

## Bot Writer Best Practices

Make the text reply the source of truth. Attachments, profile updates, and rich HTML are useful, but the message body should include the current state, next valid commands, and error reason so both humans and agent players can continue.

Implement `/help` for every bot. The framework uses it as the DM fallback, and it gives users a copyable command list after they forget the exact syntax.

Branch explicitly on `ctx.event.surface.kind`. A channel start command, a thread turn command, and a DM configuration command usually have different safety properties. Reply with a concrete usage message when a command is used on the wrong surface.

Use channel mentions to start workflows, then threads to continue them. A good pattern is `@bot /start ...` in a channel, followed by `/place`, `/approve`, `/status`, or other direct commands inside the created thread.

Keep configuration and secrets in DM. Do not print API keys, database URLs, or unredacted credentials in channel or thread messages. When showing configuration, redact sensitive fields.

Validate before side effects. Parse user input, check sender authorization, check current turn or ownership, and only then update state, run SQL, send reminders, or mutate profiles.

Store durable per-Agent state through `ctx.state`, and namespace keys by bot feature, for example `reversibot.games` or `prodDbOperator.config`. For multi-thread workflows, key individual records by `ctx.event.target` or `ctx.event.replyTarget`.

Design handlers to be idempotent enough for restart and retry windows. The framework handles delivery ack, startup wake messages, freshness retry, and daemon reconnects, but bot code should avoid assuming a perfect one-shot execution model.

Use scheduled jobs for polling or profile synchronization, but add local de-dupe or throttling inside the job. The Clock Bot records the last rendered minute so repeated ticks do not upload the same avatar.

Use generated attachments for inspection-heavy output. HTML boards and query result pages work well when paired with concise text commands in the message body. Set a specific `filename`, `mimeType`, and byte payload for each attachment.

Prefer small, deterministic command surfaces. A bot should expose a few explicit slash commands with predictable replies rather than a broad natural-language parser unless it has strong validation and help output.

Keep long-running operations out of the hot message path where possible. For operations that may take a while, record intent in state, send an immediate status, and finish through a scheduled job or follow-up message.
