# Slock Daemon 协议逆向与 RaftBot 接入方式

来源：检查了 npm 发布包 `@slock-ai/daemon@0.57.5` 和 `@slock-ai/cli@0.0.10` 的 bundled JS。

这份文档记录 RaftBot MVP 需要复用的 Slock Daemon 连接方式。重点不是新建一个 Bot REST API，而是让 RaftBot 以 Slock Daemon 的方式连接 Server。

这些细节属于 `raftbot` framework 内部实现。普通 bot 开发者不应该直接处理本协议；他们应该使用 framework 提供的 command/event/context API，类似 Slack/Telegram Bot SDK。

## 启动参数

Slock Daemon 的 usage：

```text
Usage: slock-daemon --server-url <url> --api-key <key>
```

对应解析逻辑只读取两个参数：

```ts
function parseDaemonCliArgs(args) {
  let serverUrl = "";
  let apiKey = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--server-url" && args[i + 1]) serverUrl = args[++i];
    if (args[i] === "--api-key" && args[i + 1]) apiKey = args[++i];
  }
  if (!serverUrl || !apiKey) return null;
  return { serverUrl, apiKey };
}
```

RaftBot 的启动方式应保持一致：

```bash
npx raftbot-xxxx --server-url https://api.slock.ai --api-key sk_machine_xxxx
```

## WebSocket 连接

Slock Daemon 使用 WebSocket 连接 Server：

```text
wsUrl = serverUrl.replace(/^http/, "ws") + `/daemon/connect?key=${apiKey}`
```

也就是：

```text
https://api.slock.ai -> wss://api.slock.ai/daemon/connect?key=...
http://localhost:3000 -> ws://localhost:3000/daemon/connect?key=...
```

连接行为：

- 连接成功后重置 reconnect backoff。
- 收到任何 inbound message 都更新 watchdog。
- 非 `ping` 消息会进入 daemon message handler。
- 断线后按指数 backoff reconnect。
- 如果长时间没有 inbound traffic，会 terminate WebSocket 触发重连。

## Ready 消息

连接建立后，Slock Daemon 发送：

```json
{
  "type": "ready",
  "capabilities": ["agent:start", "agent:stop", "agent:deliver", "workspace:files"],
  "runtimes": ["codex", "claude"],
  "runningAgents": [],
  "hostname": "host",
  "os": "linux x64",
  "daemonVersion": "0.57.5"
}
```

RaftBot 可以发送类似 ready，但 runtimes/capabilities 应表达自己是 bot daemon。例如：

```json
{
  "type": "ready",
  "capabilities": ["agent:start", "agent:stop", "agent:deliver"],
  "runtimes": ["raftbot"],
  "runningAgents": [],
  "hostname": "host",
  "os": "linux x64",
  "daemonVersion": "raftbot-prod-db-operator/0.1.0"
}
```

Server 如果目前强依赖 runtime name，需要新增或复用一个 runtime id，例如 `raftbot`。

## Server -> Daemon 消息

已观察到的 inbound message types：

- `agent:start`
- `agent:stop`
- `agent:reset-workspace`
- `agent:inbox:purge`
- `agent:deliver`
- `agent:runtime_profile:migration`
- `agent:runtime_profile:daemon_release_notice`
- `agent:workspace:list`
- `agent:workspace:read`
- `agent:skills:list`
- `agent:activity_probe`
- `machine:workspace:scan`
- `machine:workspace:delete`
- `machine:runtime_models:detect`
- `reminder.upsert`
- `reminder.cancel`
- `reminder.snapshot`
- `ping`
- `computer:restart`
- `computer:upgrade`

RaftBot MVP 只需要支持：

- `agent:start`
- `agent:stop`
- `agent:deliver`
- `ping`
- `machine:runtime_models:detect`

可选支持：

- `reminder.*`，用于程序化 reminder 与 Slock reminder cache 协作。
- `agent:activity_probe`，用于活动状态查询。

## agent:start

Slock Daemon 收到 `agent:start` 后会启动对应 LLM runtime。RaftBot 不需要启动 LLM，而是把这个 agentId 绑定到 bot handler。

建议处理：

```json
{
  "type": "agent:start",
  "agentId": "agent_uuid",
  "config": {
    "runtime": "raftbot",
    "model": null
  },
  "launchId": "launch_uuid"
}
```

RaftBot 收到后：

1. 保存 `agentId` / `launchId`。
2. 初始化 bot state。
3. 发送 `agent:status` active/running。
4. 可选发送 `agent:activity` 表示 ready。

## agent:deliver

这是消息投递的核心。

Daemon 收到形态：

```json
{
  "type": "agent:deliver",
  "agentId": "agent_uuid",
  "seq": 123,
  "deliveryId": "delivery_uuid",
  "message": {
    "message_id": "msg_uuid",
    "sender_name": "alice",
    "content": "/help",
    "seq": 123
  }
}
```

RaftBot 处理：

1. 用 `deliveryId` 或 `message.message_id` 做 idempotency。
2. 把 message 转成 bot event。
3. 运行 command router。
4. 处理成功后发送 ack。

Ack 形态：

```json
{
  "type": "agent:deliver:ack",
  "agentId": "agent_uuid",
  "seq": 123,
  "deliveryId": "delivery_uuid"
}
```

## Daemon -> Server 消息

已观察到 Slock Daemon 会发送：

- `ready`
- `pong`
- `agent:status`
- `agent:activity`
- `agent:deliver:ack`
- `agent:session`
- `agent:runtime_profile`
- `agent:runtime_profile:migration:ack`
- `agent:runtime_profile:migration_done`
- `agent:runtime_profile:daemon_release_notice:ack`
- `agent:workspace:file_tree`
- `agent:workspace:file_content`
- `agent:skills:list_result`
- `machine:workspace:scan_result`
- `machine:workspace:delete_result`
- `machine:runtime_models:result`
- `reminder.fire_attempt`
- `reminder.snapshot.request`

RaftBot MVP 需要发送：

- `ready`
- `pong`
- `agent:status`
- `agent:activity`
- `agent:deliver:ack`
- `machine:runtime_models:result`

## Runtime model detect

理想情况下，RaftBot 可以把 runtime id 映射成 bot package id：

```text
raftbot-prod-db-operator
```

收到：

```json
{
  "type": "machine:runtime_models:detect",
  "requestId": "req_123",
  "runtime": "raftbot-prod-db-operator"
}
```

返回：

```json
{
  "type": "machine:runtime_models:result",
  "requestId": "req_123",
  "models": [
    {
      "id": "default",
      "label": "Production Database Operator",
      "verified": true
    }
  ],
  "default": "default"
}
```

验证结果：Server 会调用这个 detect，并且 UI 能显示 daemon 返回的 model。若 runtime 仍无法选择，问题在 runtime installed/available gating，不在 model detect 链路。

当前绕过方式是上报所有 server 已知 runtime：

```json
{
  "type": "ready",
  "runtimes": ["claude", "codex", "antigravity", "kimi", "copilot", "cursor", "gemini", "opencode", "pi"]
}
```

然后对任意 `machine:runtime_models:detect` 返回 bot model：

```json
{
  "type": "machine:runtime_models:result",
  "requestId": "req_123",
  "models": [
    {
      "id": "prod-db-operator",
      "label": "Production Database Operator",
      "verified": true
    }
  ],
  "default": "prod-db-operator"
}
```

## 发送聊天消息

Slock Daemon 原本不是直接“发 chat message”的组件；它负责运行 Agent，并给 Agent 注入 `slock` CLI 环境。Agent 再通过 agent credential 调用 `slock message send`。

Daemon 代码里有 runner credential mint：

```text
POST /internal/computer/runners/<agentId>/credentials
Authorization: Bearer <daemon api key>
```

返回应包含 `sk_agent_...`。Slock Daemon 把这个 credential 注入给 Agent process。

RaftBot 有两种实现路径：

1. **兼容路径**：RaftBot 收到 `agent:start` 后，调用同样的 runner credential mint endpoint，拿到 bot agent credential，然后通过现有 Agent API/CLI 发送消息。
2. **协议扩展路径**：Server 支持 daemon 直接发送 `agent:message:send` 之类的 WebSocket outbound message，由 Server 代表该 agent 发消息。

MVP 建议先走兼容路径，因为它最大化复用现有 server 能力。

## 与 Bot REST API 的区别

不要把 `npx raftbot-xxxx --server-url --api-key` 理解为：

```text
GET /bot-api/v1/events
POST /bot-api/v1/messages
```

更准确的理解是：

```text
RaftBot == Slock Daemon-compatible process
RaftBot connects to /daemon/connect?key=...
Slock Server sends agent:start / agent:deliver
RaftBot routes delivery to deterministic bot code
```

未来如果需要对外提供 Bot REST API，也可以作为 daemon protocol 之上的 facade，但不是当前优先方向。

## 推荐 MVP

1. 实现 `RaftDaemonConnection`：
   - 解析 `--server-url` / `--api-key`
   - WebSocket 连接 `/daemon/connect?key=...`
   - reconnect/backoff/watchdog
2. 发送 `ready`：
   - `runtimes: ["raftbot"]`
   - `capabilities: ["agent:start", "agent:stop", "agent:deliver"]`
3. 处理 `agent:start`：
   - 绑定 agentId 和 launchId
   - 初始化 bot handler
   - mint runner credential 或准备消息发送能力
4. 处理 `agent:deliver`：
   - 转成 bot message event
   - command router
   - `agent:deliver:ack`
5. 实现 bot context：
   - `sendMessage(target, text)`
   - `createApproval(...)`
   - `scheduleReminder(...)`
6. 实现两个 demo：
   - Production Database Operator
   - Programmatic Reminder Bot
