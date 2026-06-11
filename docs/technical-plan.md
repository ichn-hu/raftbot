# Raft Bot technical plan

## Goal

Raft Bot is a programmable Slock Agent runtime. From the Slock server and user perspective it behaves like an Agent: it has an agent identity, can receive channel/thread/DM delivery, can send messages, can create/claim/update tasks, can upload attachments, and can react to messages. The difference is the decision loop: a Raft Bot runs deterministic application code instead of an LLM turn.

## Expected Launch UX

Target user flow:

```bash
npx raftbot-prod-db-operator \
  --server-url https://api.slock.ai \
  --api-key rbk_xxxx
```

In Slock, the user/admin first adds a new Agent. That Agent is the bot identity. Slock mints an API key for this bot install; the API key is bound to:

- server/workspace id
- bot agent id and display profile
- installed package name/version
- granted scopes
- allowed channel/thread/DM subscriptions
- optional command manifest

This means the bot package does not require `slock agent login` or a local Slock profile. `--server-url` and `--api-key` are enough for the runtime to connect, receive events, and send messages. The existing `slock` CLI remains useful for development/debugging, but it should not be required for production bot launch.

## Daemon model

Phase 1 should support one bot per daemon:

```text
one npm package process = one bot Agent identity = one API key = one daemon
```

This keeps deployment, logs, permissions, state, and failure isolation simple. If the Production Database Operator crashes, it only affects that operator bot; a Reminder Bot or another workflow bot runs as a separate process.

Future phases can add:

- one daemon running multiple bot packages.
- hot update of bot packages and manifests.
- marketplace-managed install/update lifecycle.
- Slock-hosted bot runner where users install from marketplace without manually running `npx`.

## MVP transport

Use a direct bot API transport as the primary runtime:

1. A human/server admin adds a bot Agent in Slock.
2. Slock creates a bot install and shows an API key.
3. The operator runs the package with `npx raftbot-xxxx --server-url <url> --api-key <key>`.
4. The bot loops over:
   - bot event receive endpoint for ordinary delivery.
   - configured target subscriptions for channel/thread/DM watches.
   - bot send endpoint for replies.
   - later task/attachment/reminder/action endpoints for richer workflows.

The CLI-shell transport can remain as a local fallback while the direct bot API is being stabilized.

## Long-term transport

Expose a small Raft Bot SDK around a transport interface:

```ts
interface RaftBotTransport {
  receive(): Promise<SlockEvent[]>;
  read(target: string, cursor?: string): Promise<SlockEventPage>;
  send(target: string, body: string, opts?: SendOptions): Promise<SentMessage>;
  createTask(input: CreateTaskInput): Promise<Task>;
  updateTask(input: UpdateTaskInput): Promise<void>;
  upload(input: UploadInput): Promise<Attachment>;
}
```

Implementations:

- `SlockBotApiTransport`: direct HTTP/WebSocket transport using `--server-url` and `--api-key`. Best production path.
- `SlockCliTransport`: shells out to the published CLI. Useful fallback for development while API contracts are being stabilized.
- `SlockAgentApiTransport`: compatibility layer over current agent-token endpoints.
- `SlockBridgeTransport`: optional event-stream bridge similar to `slock agent bridge` for low-latency wake delivery.

## Bot framework

The framework should provide:

- Identity: one Slock Agent profile per bot instance.
- Listener registry: subscribe to targets such as `#channel`, `#channel:thread`, or `dm:@user`.
- Command router: parse slash-style text commands like `/help`, `/sql <statement>`, `/deploy staging`, `/approve <id>`.
- Event filters: ignore system messages, ignore the bot's own messages, optionally require allowlisted channels/users.
- State store: file/SQLite/Postgres adapter for cursors, approval records, idempotency keys, and audit history.
- Workflow primitives: approval request, timeout reminder, task mirror, message thread reply, attachment handling.
- Policy hooks: who can invoke a command, who can approve, whether requester self-approval is allowed.

## Demo behavior

The current prototype behavior should implement:

- `/help`: prints available bot commands.
- `/sql <statement>`: accepts a production database write request.
  - If sender is in `RAFT_BOT_SQL_ALLOWLIST`, the request is immediately recorded as executed.
  - Otherwise the bot sends an approval request to `RAFT_BOT_MANAGER_TARGET` if configured, or the same thread if not configured.
  - The demo records approved SQL into `RAFT_BOT_SQL_LOG` as JSON lines. It intentionally does not connect to a real database.
- `/remind in <duration> <text>`: schedules a bot-managed reminder, e.g. `/remind in 10m check job`.
- `/remind at <iso-time> <text>`: schedules a bot-managed reminder at an exact timestamp.
- `/deploy <env>`: creates a pending approval request in local JSON state and replies in the message thread.
- `/approve <id>`: approves a pending request.
- `/reject <id>`: rejects a pending request.

Run shape:

```bash
npx raftbot-prod-db-operator \
  --server-url https://api.slock.ai \
  --api-key rbk_xxxx \
  --targets "#ops,dm:@db-manager" \
  --sql-allowlist "@Alice,@Bob" \
  --managers "@ichnhu" \
  --manager-target "dm:@ichnhu"
```

For a production approval flow, replace the local JSON state with durable DB storage and add policy checks:

- requester cannot approve their own request unless explicitly allowed.
- approvers must match channel/team policy.
- each state transition writes an audit message to the request thread.
- optional timeout uses `slock reminder schedule`.
- final approval can trigger an external action, such as deployment, webhook call, or task status update.

## Production Database Operator example

Concrete flow:

1. User or agent posts `/sql update users set plan = 'pro' where id = 'u_123'`.
2. Bot receives the message as a Slock Agent.
3. Bot checks policy:
   - sender in SQL allowlist: execute immediately and write audit result to the thread.
   - sender not in allowlist: create approval record and notify the manager in a DM or the same thread.
4. Manager replies `/approve <id>` or `/reject <id>`.
5. On approval, bot executes the DB adapter and posts the result back to the original thread.

Production DB execution should be behind an adapter:

```ts
interface SqlExecutor {
  explain(sql: string): Promise<SqlPlan>;
  execute(sql: string, approval: ApprovalRecord): Promise<SqlResult>;
}
```

Required production controls:

- allow only configured write verbs, or require an explicit `--write` flag.
- run `EXPLAIN`/dry-run before manager approval.
- bind DB credentials to the bot instance, not to arbitrary user input.
- require manager approval for all non-allowlisted senders.
- record requester, approver, SQL, timestamp, target, and execution result.
- optionally require two-person approval for dangerous tables.

## Programmatic Reminder Bot example

Slock's built-in reminder model is time-based. A Raft Bot reminder can be rule-based because the bot owns the detection loop.

Examples:

- `/remind in 10m review deploy result`
- `/remind at 2026-06-11T16:00:00Z run settlement check`
- future: `/remind when job nightly_import failed for 3 runs`
- future: `/remind when BTC drawdown > 8% and volume spike`

Implementation model:

1. Command handler parses a rule and stores it as a reminder record.
2. Scheduler loop evaluates due reminders and arbitrary predicates.
3. When a rule matches, bot sends a Slock message to the target channel/thread/DM and marks the reminder fired.
4. For complex rules, predicate adapters can poll databases, queues, metrics, CI systems, or webhooks.

This makes reminders a bot/plugin capability, not just a fixed Slock server primitive.

## Slash command semantics

For MVP, "slash command" means a normal Slock message whose first token starts with `/`. This requires no server change and works in channels, threads, and DMs.

For a more native product surface later, add server-side command metadata:

- Bot publishes command manifest: command name, args schema, help text, scopes.
- Slock UI autocompletes `/help`, `/deploy`, etc.
- Server delivers a structured command event to the bot, while still rendering the command in chat for auditability.

## Reliability

- Use per-target cursors for read polling.
- Use message id + command text as an idempotency key.
- Store outbound send results to avoid duplicate replies after restart.
- Run only one active bot process per profile, using a lock file.
- Keep `message check` and explicit `read --after` paths separate: inbox delivery handles normal mentions/membership, explicit watches handle configured channels/threads/DMs.

## Security

- Treat the bot token like an agent token.
- Scope bot membership to only channels/DMs it needs.
- Enforce command permissions in bot code, not just in UI.
- Keep approval decisions append-only in audit state.
- Do not expose arbitrary shell execution as a bot command.

## Recommended milestones

1. MVP CLI transport and command router.
2. Durable state store and idempotency.
3. Approval workflow primitive with policy checks.
4. Bot manifest and `/help` generation.
5. Native Agent API transport or event bridge for lower latency.
6. Slock UI/native slash command integration.
7. Raft Bot marketplace: packaged bot manifests, required scopes, setup UI, per-server install, versioning, and server-admin approval.

## Marketplace direction

A marketplace bot package should contain:

- manifest: name, description, version, commands, required scopes, event subscriptions.
- install schema: required env/secrets such as DB DSN, manager target, allowlists.
- runtime image or source package.
- permission request: channels, DMs, task access, attachment access, external network/secrets.
- audit contract: where decisions and executions are logged.

Install flow:

1. Server admin selects a bot from marketplace.
2. Slock creates or links an Agent identity for that bot.
3. Admin approves scopes and configures secrets/policies.
4. Slock mints an install-scoped bot API key.
5. Operator starts the bot with `npx <package> --server-url <url> --api-key <key>`, or Slock-hosted runner starts it automatically.
6. Slock exposes its command manifest as native slash commands.

This positions Raft Bot as the Slock-native programmable CLI layer: instead of every operation being driven by an LLM Agent, reusable bot packages provide deterministic, auditable workflows inside the same chat/task/DM surfaces.

## Slack and Telegram references

Slack's proven model:

- Events API delivers subscribed events to a bot/app through HTTP callbacks or Socket Mode.
- Slash commands are app invocations from the composer and deliver a structured payload to the app.
- Apps declare scopes and are installed into workspaces.
- Marketplace/app directory provides discovery, install, permission review, and updates.

Telegram's proven model:

- A bot receives updates through either `getUpdates` long polling or webhook delivery.
- Updates are JSON objects with a monotonically advancing offset.
- Sending messages is a simple Bot API method call such as `sendMessage`.
- Bot commands are declared so clients can show command help/autocomplete.

Raft Bot should borrow these choices:

- support both polling and push/webhook/event-stream delivery.
- expose a stable update object and cursor/offset.
- keep send-message as a simple API call.
- let bots publish command manifests for `/help` and UI autocomplete.
- make install scopes explicit like Slack apps.

Official docs checked:

- Slack Events API: https://docs.slack.dev/apis/events-api/
- Slack slash commands: https://docs.slack.dev/interactivity/implementing-slash-commands
- Telegram Bot API updates: https://core.telegram.org/bots/api#getting-updates
