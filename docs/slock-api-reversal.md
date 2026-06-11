# Minimal Slock Agent API reversal

Source: inspected `@slock-ai/cli@0.0.10` published bundle.

This is enough for a Raft Bot MVP that only needs to receive notifications and send messages. It documents the current observed Agent API and the recommended bot-install wrapper for `npx raftbot-xxxx --server-url ... --api-key ...`.

## Target bot launch contract

Expected package launch:

```bash
npx raftbot-xxxx --server-url https://api.slock.ai --api-key rbk_xxxx
```

The API key should be an install-scoped bot key. It should resolve server-side to exactly one bot Agent identity, so the bot package does not need a separate local profile or `agent-id` flag.

Recommended bot API headers:

```http
Authorization: Bearer rbk_xxxx
X-RaftBot-Client: raftbot-xxxx/1.0.0
Content-Type: application/json
```

Recommended bot API endpoints:

```http
GET  /bot-api/v1/events?cursor=<cursor>&timeout_ms=30000
POST /bot-api/v1/messages
```

`GET /events` should return stable updates with a cursor/offset:

```json
{
  "cursor": "evt_124",
  "events": [
    {
      "id": "evt_123",
      "type": "message.created",
      "target": "#ops:abcd1234",
      "messageId": "msg_uuid",
      "sender": { "handle": "@alice", "type": "human" },
      "text": "/help",
      "createdAt": "2026-06-11T14:00:00Z"
    }
  ]
}
```

`POST /messages` minimal body:

```json
{
  "target": "#ops:abcd1234",
  "text": "hello"
}
```

This bot API can be implemented as a thin server-side facade over the current internal Agent API below.

## Auth

Every request uses JSON and these headers:

```http
Authorization: Bearer <agent-token>
X-Agent-Id: <agent-id>
X-Server-Id: <server-id>        # optional when known
X-Slock-Client: cli
Content-Type: application/json
```

The CLI supports two equivalent path families:

- Legacy/daemon path: `/internal/agent/<agent-id>/...`
- Self-hosted agent-token path: `/internal/agent-api/...`

For Raft Bot using current `slock agent login` credentials during development, prefer the agent-token path. For production `npx` launch, use the bot-install API key facade above.

## Receive

Legacy shape used by `slock message check`:

```http
GET /internal/agent/<agent-id>/receive
GET /internal/agent/<agent-id>/receive?block=true&timeout=<ms>
```

Self-hosted agent-token rewrite:

```http
GET /internal/agent-api/events?since=latest
```

Observed response normalization:

```json
{
  "messages": [
    {
      "seq": 123,
      "message_id": "uuid",
      "channel": "#raftbot-devs",
      "sender": { "handle": "@alice", "type": "human" },
      "content": "/help"
    }
  ],
  "has_more": false
}
```

The self-hosted endpoint may return `events`; the CLI normalizes it to `messages`.

Legacy ack path:

```http
POST /internal/agent/<agent-id>/receive-ack
{ "seqs": [123, 124] }
```

For managed/self-hosted agent mode, CLI does not call the explicit ack endpoint after receive; the event endpoint appears to handle delivery state server-side.

## Send

Legacy shape:

```http
POST /internal/agent/<agent-id>/send
```

Self-hosted agent-token rewrite:

```http
POST /internal/agent-api/send
```

Body:

```json
{
  "target": "#raftbot-devs:abcd1234",
  "content": "message body",
  "draftReholdCount": 0,
  "seenUpToSeq": 123,
  "draftReplacedExisting": false,
  "attachmentIds": ["optional-attachment-id"]
}
```

Minimal body should be:

```json
{
  "target": "#raftbot-devs",
  "content": "hello",
  "draftReholdCount": 0
}
```

Observed success response includes:

```json
{
  "messageId": "uuid"
}
```

The response may also return `{ "state": "held", ... }` if freshness checks block the send. A bot implementation should either retry with updated context or use the CLI transport until the exact hold contract is stabilized.

## Recommended direct-transport MVP

1. Parse `--server-url` and `--api-key`.
2. Poll the bot event endpoint. Initially this may proxy to `GET /internal/agent-api/events?since=latest`.
3. For each human message, route slash commands.
4. Send replies through the bot send endpoint. Initially this may proxy to `POST /internal/agent-api/send`.
5. Keep a local idempotency store keyed by message id + command.

This is enough to implement `/help`, `/sql`, and `/approve` without shelling out to `slock`.
