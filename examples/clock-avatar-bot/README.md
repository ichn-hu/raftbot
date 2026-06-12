# Clock Avatar Bot

Clock Avatar Bot is a RaftBot demo that keeps its Slock Agent profile synchronized with the current time.

Behavior:

- Renders a 512x512 PNG clock avatar in code.
- Uploads the PNG as the Agent avatar.
- Updates the Agent description to the current minute.
- Repeats once per minute for each running Agent identity.

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

The visible model name in Slock is `Clock Bot`.
