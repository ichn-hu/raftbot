# RaftBot Programming Model

RaftBot should feel like a Slock-native bot framework, not a thin wrapper around daemon delivery events. Bot code should receive one normalized event shape that makes the conversation surface, addressing, command text, and default reply behavior explicit.

## Slack And Telegram Precedent

Slack separates several bot entry points:

- General messages arrive as `message` events with fields like `channel`, `text`, `ts`, and `channel_type`.
- Direct bot mentions arrive as `app_mention` events. Slack documents this as the event for messages that directly mention the bot user.
- Slash commands are a separate interaction payload with `channel_id`, `channel_name`, `user_id`, `command`, `text`, `response_url`, and related context. Slack also notes that custom slash commands cannot be invoked in message threads.
- Threading is represented by `thread_ts`; `chat.postMessage` replies in a thread when passed the parent message's `thread_ts`.

Telegram uses a more unified message model:

- Updates contain `Message` objects with a `chat` that identifies private, group, supergroup, or channel context.
- Forum topics and bot private chat topics use `message_thread_id`.
- Mentions and slash commands are represented as message entities, including `mention`, `text_mention`, and `bot_command`.
- With privacy mode enabled, bots receive commands, replies to their messages, and mentions rather than every group message. Telegram's `ForceReply` is designed for step-by-step bot conversations under that privacy model.

RaftBot should combine these lessons:

- Use one normalized event object like Telegram.
- Preserve explicit event kinds and command routing like Slack.
- Treat group-channel ambient messages differently from addressed messages.
- Make thread continuation first-class.

## Normalized Event

Every delivered Slock message becomes a `BotMessageEvent`:

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

Key semantics:

- `surface.kind` is the primary branch for bot logic.
- `mentioned` means Slock marked the message as formally mentioning this bot Agent.
- `addressed` means the framework considers the message intended for this bot.
- `commandText` is `text` with a leading bot mention stripped when the message was addressed by mention, so `@DbBot /sql select 1` routes to `/sql select 1`.
- `target` is where the incoming message lives.
- `replyTarget` is the default destination for `ctx.reply()`.

Current implementation note: if the daemon delivery does not include `mention` / `mentioned`, RaftBot resolves the receiving `agentId` profile on `agent:start` and treats a leading textual mention like `@Alice /help` as addressed only when the leading handle matches that receiving agent.

## Default Turn Taking

The default command router should be conservative in channels and conversational in threads:

| Surface | Example | Default command routing |
| --- | --- | --- |
| Channel, not mentioned | `/sql select 1` | Ignored by `bot.command(...)` |
| Channel, mentioned | `@DbBot /sql select 1` | Accepted; `ctx.reply()` creates/replies in a thread under the invoking message |
| Thread | `/approve sql_123` | Accepted without `@DbBot` |
| DM | `/help` | Accepted without `@DbBot` |

This gives the desired user model:

1. In a noisy channel, the user explicitly addresses the bot with `@DbBot /sql ...`.
2. The bot replies in a thread under that channel message.
3. Inside that thread, the bot has the turn context, so follow-up commands do not need another `@DbBot`.
4. In DM, the whole conversation is already addressed to the bot.

Bot authors can opt into ambient channel commands with:

```js
await bot.start({
  serverUrl,
  apiKey,
  ambientChannelCommands: true
});
```

That mode is useful for global utility bots, but it should not be the default for workflow bots because command names are not globally namespaced and group channels contain unrelated conversation.

## Framework API

Bot authors should use:

```js
const bot = createBot();

bot.onMessage(async (ctx) => {
  if (ctx.event.surface.kind === "channel" && !ctx.event.mentioned) return;
  // Observe addressed/non-addressed messages for metrics, custom filters, etc.
});

bot.command("sql", async (ctx) => {
  if (ctx.event.surface.kind === "channel") {
    // The framework only routes this in a channel when the bot was mentioned
    // unless ambientChannelCommands is enabled.
  }
  await ctx.reply("SQL approval required.");
});
```

The command router is built on top of `onMessage`. `onMessage` sees all delivered messages; `bot.command(...)` only fires for parsed slash commands that pass the framework addressing rules.

## Slock Mapping

The current daemon delivery payload already carries the needed surface fields:

- `channel_type="channel"` maps to `surface.kind="channel"`.
- `channel_type="thread"` maps to `surface.kind="thread"`.
- `parent_channel_type` and `parent_channel_name` identify the thread parent.
- `channel_name="thread-<shortId>"` gives the thread short id used in Slock targets.
- `channel_type="dm"` maps to `surface.kind="dm"`. The runtime also treats `direct` / `direct_message` channel types, or a normalized target beginning with `dm:`, as DM surfaces so `/help`-style commands work without an explicit bot mention.
- `mention` / `mentioned` flags map to `event.mentioned`.

Slock thread reply targets must use the parent surface plus the parent message short id, for example `#all:8470fd4e`, not `#thread-8470fd4e:<replyMsgShortId>`.

## Open Design Items

- Server delivery should ideally include the bot Agent's stable handle/name in `agent:start` or `agent:deliver`, so the framework can strip only this bot's mention instead of stripping any leading `@...` when `mentioned=true`.
- The server should define whether thread delivery after a bot reply implies a followed turn context, or whether RaftBot should explicitly subscribe/follow the thread after replying.
- A future API can add `bot.mention(...)`, `bot.thread(...)`, and middleware, but the core event shape should stay stable.

## References

- Slack Events API: <https://docs.slack.dev/apis/events-api/>
- Slack `message` event: <https://docs.slack.dev/reference/events/message/>
- Slack `app_mention` event: <https://docs.slack.dev/reference/events/app_mention/>
- Slack slash commands: <https://docs.slack.dev/interactivity/implementing-slash-commands/>
- Slack `chat.postMessage`: <https://docs.slack.dev/reference/methods/chat.postMessage/>
- Telegram Bot API: <https://core.telegram.org/bots/api>
