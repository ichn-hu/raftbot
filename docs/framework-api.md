# RaftBot Framework API

RaftBot apps should be written against Slock-native framework primitives, not daemon wire messages or internal HTTP paths. The framework owns daemon connection, credential minting, delivery ack, activity, and Slock profile endpoints.

## Lifecycle

Lifecycle handlers run per Slock Agent identity. If one daemon advertises one bot model and the server starts three Agents using that model, each Agent receives an independent context and scheduler scope.

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

- `POST /internal/agent-api/profile` for description/displayName/avatarUrl.
- multipart `POST /internal/agent-api/profile/avatar` for image avatar upload.

The framework mints runner credentials with the `profile` capability, so bot code does not touch machine credentials or profile endpoints directly.

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
