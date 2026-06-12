# Production Database Operator Design

## Goal

Production Database Operator is a RaftBot example that can operate one configured database target per Slock Agent instance. It supports PostgreSQL, MySQL, and SQLite, and gives Agents or humans a controlled Slock-native workflow for inspecting and changing production data.

The bot is deterministic. It classifies SQL, presents approval summaries, records audit data, and executes write SQL only after a configured manager approves.

## Decisions

- Default execution policy: read-only SQL runs immediately; write SQL requires manager approval.
- One bot instance maps to one database target.
- SQLite may be configured with a local path. If no path is supplied, the bot creates an empty SQLite file under the Agent workspace.
- Multi-statement SQL is allowed and executes as one transaction.
- Transaction failure semantics are all-or-nothing: `BEGIN`, run all statements, `ROLLBACK` on the first error, `COMMIT` only if all statements succeed.
- Managers are configured at daemon startup. All managers are mentioned in the request thread. Any manager can approve or reject. The requester cannot self-approve. If no manager is configured, write SQL cannot be approved.
- Default approval surface is the original request thread. `/dm <requestId>` can force DM reminders to all managers.
- Pending write requests snapshot the execution target at request creation. Later `/config db ...` changes do not retarget already-pending SQL.
- SELECT/WITH read-only queries are hard-capped at the adapter layer by fetching at most `maxRows + 1` rows and returning at most `maxRows` rows. Metadata reads such as `SHOW` or `DESCRIBE` remain read-only but are executed without the subquery wrapper because those statements are not valid inside `SELECT * FROM (...)`.
- High-risk SQL is allowed after manager approval. The bot marks risk categories in the approval summary and audit log, but does not hard-block them.
- Driver dependencies are included directly in the repo for the MVP.

## Commands

- `/help`: show usage and current database target.
- `/sql <statement...>`: classify and execute or request approval.
- `/approve <requestId>`: manager approval, then execute the pending write transaction.
- `/reject <requestId>`: manager rejection.
- `/dm <requestId> @manager [@manager...]`: send explicit DM reminders to selected managers for a pending request.
- `/status <requestId>`: show request status.
- `/config show`: show current bot-instance configuration. DM only.
- `/config db sqlite [path]`: configure SQLite. If path is omitted, use the Agent workspace default db. DM only.
- `/config db pg <databaseUrl>`: configure PostgreSQL. DM only.
- `/config db mysql <databaseUrl>`: configure MySQL. DM only.
- `/config manager add @manager [@manager...]`: add managers. DM only.
- `/config manager remove @manager [@manager...]`: remove managers. DM only.

## User Story

### 1. Admin Starts The RaftBot Daemon

An admin runs the combined RaftBot daemon with the Slock daemon connection shape:

```bash
node examples/all-bots/index.js \
  --server-url https://api.slock.ai \
  --api-key sk_machine_xxxx \
  --runtime-ids "claude,codex,antigravity,kimi,copilot,cursor,gemini,opencode,pi"
```

The daemon advertises `prod-db-operator` as one model in its model list.

### 2. Human Creates A Prod DB Operator Agent

In Slock, a human creates an Agent using model `prod-db-operator`. To the server this is a normal Slock Agent; to RaftBot it is a bot instance.

When the server sends `agent:start`, RaftBot resolves that Agent's profile. If the profile includes a `creator`, the framework exposes it as `ctx.agent.creator`. The Prod DB Operator uses that creator as the default manager for the new bot instance.

If Slock does not return creator metadata, the bot falls back to managers configured at daemon startup. If neither exists, read-only SQL still works, but write SQL cannot be approved until a manager is configured.

### 3. Creator Configures The Bot In DM

The creator DMs the bot:

```text
/config show
```

The bot replies with current configuration: driver, redacted database URL, SQLite path, managers, and result limits.

For SQLite, the creator can either use the workspace default:

```text
/config db sqlite
```

or specify a machine-local path:

```text
/config db sqlite /var/lib/prod-db-operator/app.sqlite
```

The workspace default SQLite database is initialized with small demo tables so a newly created bot can be tested immediately:

- `raftbot_demo_customers`
- `raftbot_demo_orders`
- `raftbot_demo_events`

Example query:

```sql
select c.name, c.plan, sum(o.amount_cents) as total_cents
from raftbot_demo_customers c
join raftbot_demo_orders o on o.customer_id = c.id
group by c.id, c.name, c.plan
order by total_cents desc;
```

Explicit SQLite paths are not seeded, so user-provided local databases are left untouched.

For PostgreSQL or MySQL, the creator configures a DSN in DM:

```text
/config db pg postgres://user:password@host:5432/app
/config db mysql mysql://user:password@host:3306/app
```

The DSN is stored in this bot instance's local `ctx.state` and is redacted in config displays and audit entries. This is local process state, not server-side secret management.

### 4. Creator Adds More Managers

The creator can add or remove managers in DM:

```text
/config manager add @alice @bob
/config manager remove @alice
```

Only configured managers can change config, approve, reject, or receive forced approval DMs. The requester cannot approve their own write request even if they are a manager.

### 5. User Runs Read-Only SQL

A human or Agent mentions the bot in a channel:

```text
@ProdDb /sql select id, email from users limit 10
```

The bot opens a thread and returns the result:

- small result: markdown table in the message
- large result: CSV and HTML attachments
- very large result: paginated CSV and HTML attachments, capped by configured limits

The query is recorded in the audit log.

### 6. User Requests Write SQL

A human or Agent sends:

```text
@ProdDb /sql update users set plan = 'pro' where id = 123;
```

The bot classifies it as write SQL, snapshots the current execution target into the pending request, and posts an approval summary in the thread. The summary includes:

- request ID
- requester
- configured database target
- statement count
- detected risk markers
- full SQL

The bot mentions all configured managers in that same thread.

### 7. Manager Approves Or Rejects

Any configured manager can reply in the request thread:

```text
/approve sql_abc123
```

or:

```text
/reject sql_abc123
```

On approval, the bot executes all statements against the target snapshot captured when the request was created, not whatever target is currently configured. It executes in one transaction. If any statement fails, it rolls the transaction back and reports the error. If all statements succeed, it commits and reports affected row count.

### 8. Someone Forces A Manager DM

If the thread mention is not enough, a user can force a DM reminder to selected managers:

```text
/dm sql_abc123 @alice @bob
```

The bot sends a DM to those managers with the approval summary and a pointer back to the original thread. The actual approval still happens in the original thread for a centralized audit trail.

### 9. User Checks Request Status

Anyone in the thread can inspect request state:

```text
/status sql_abc123
```

The bot returns status, requester, database target, decision metadata, execution time, or rollback error.

## Result Rendering

Read-only result sets are returned in three tiers:

- Small results: inline markdown tables.
- Large results: HTML and CSV attachments.
- Very large results: paginated HTML/CSV attachments with a configured page size and max-row cap.

If a SELECT/WITH result exceeds the configured cap, the bot marks it as truncated in the message and attachments. Adapters enforce the cap while reading by requesting at most one sentinel row beyond the configured max; the renderer never receives more than `maxRows` rows per result set. Metadata read statements that cannot be used as subqueries are left unwrapped.

## SQL Classification

The MVP uses `node-sql-parser` to parse SQL into an AST with the configured database dialect:

- PostgreSQL uses the `postgresql` dialect.
- MySQL uses the `mysql` dialect.
- SQLite uses the `sqlite` dialect.

A request is read-only only when every parsed statement is provably read-only. The bot currently treats `select`, `show`, `describe`, `desc`, and `explain` AST types as read-only, with extra checks for `SELECT INTO`, locking reads such as `FOR UPDATE`, and non-read-only CTE bodies.

If parsing fails, the bot treats that as a user input error: it reports a friendly parse error in the same conversation context, writes an audit entry, and does not execute the SQL or create an approval request. Manager approval is only for syntactically valid SQL that the parser classifies as write-capable.

This parser check is not the only safety boundary. The configured database credentials should still be scoped to the minimum privileges needed for the bot instance.

## Error Handling

Database connection and execution errors are reported as Slock messages in the same conversation context that triggered the command. Read-only query errors return a friendly message with the database target and sanitized error text. Write transaction errors are reported in the approval thread and marked as rolled back because the transaction is all-or-nothing.

Errors are also written to the local audit log.

## Framework Additions

RaftBot needs a general attachment primitive because database results and future bots such as Reversi need generated HTML files.

The Slock attachment flow is:

1. Resolve the target to `channelId`.
2. Upload multipart `file` plus `channelId`.
3. Send the message with `attachmentIds`.

Framework API:

```js
await ctx.reply("Query result attached.", {
  attachments: [
    { filename: "result.csv", mimeType: "text/csv", bytes: csvBuffer }
  ]
});

await ctx.send("dm:@manager", "Approval requested.");
```

`ctx.reply("text")` remains valid.

## Audit State

Each bot instance stores small durable state in `ctx.state`:

- pending approval requests
- request status transitions
- execution summary
- manager reminders
- bot instance configuration, including managers and database connection settings

Large query output is sent as attachments rather than stored in state.

## Non-Goals For MVP

- Dynamic database target configuration from chat.
- Server-side secret storage.
- Post-execution rollback workflow after a successful commit.
- Cross-machine state replication.
- Full SQL parser guarantees. The bot uses conservative classification and relies on database credentials/permissions as the hard security boundary.
