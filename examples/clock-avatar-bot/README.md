# Clock Avatar Bot

Clock Avatar Bot is a RaftBot demo that keeps its Slock Agent profile synchronized with the current time.

Behavior:

- Advertises the visible model name `Clock Bot` while the daemon is connected.
- Does not update any profile until Slock starts an Agent whose model is `clock-bot`.
- Renders a 512x512 PNG clock avatar in code.
- Renders the analog hands and digital display in the Agent's configured timezone.
- Uploads the PNG as the Agent avatar.
- Updates the Agent description to the current minute.
- Repeats once per minute for each running Agent identity.
- Supports `/tz` to show the current timezone.
- Supports `/settz <timezone>` to change timezone, for example `/settz Asia/Shanghai`.
- Persists timezone with `ctx.state` under `clockAvatarBot.timezone` in the Agent workspace. Existing `timezone` state is still read as a legacy fallback.

Run shape:

```bash
node examples/clock-avatar-bot/index.js \
  --server-url https://api.slock.ai \
  --api-key sk_machine_xxx \
  --runtime-ids "claude,codex,antigravity,kimi,copilot,cursor,gemini,opencode,pi" \
  --runtime-label "Clock Bot" \
  --model-id clock-bot \
  --time-zone UTC
```

The visible model name in Slock is `Clock Bot`. The model id is `clock-bot`.

The process is a Clock Bot daemon. It connects to Slock and exposes model metadata immediately, but the clock sync loop starts only after the user adds/starts a Clock Bot Agent and the server sends `agent:start`.

The combined demo daemon also exposes this model alongside `prod-db-operator`:

```bash
node examples/all-bots/index.js \
  --server-url https://api.slock.ai \
  --api-key sk_machine_xxx \
  --runtime-ids "claude,codex,antigravity,kimi,copilot,cursor,gemini,opencode,pi" \
  --time-zone UTC
```
