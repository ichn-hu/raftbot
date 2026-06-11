# Raft Bot 技术方案

## 目标

Raft Bot 是一个程序化的 Slock Agent runtime。对 Slock Server 和用户来说，它表现为一个 Agent：有 Agent 身份，可以接收 channel、thread、DM，可以发送消息，可以参与 task、attachment、reminder、action 等工作流。

区别在于决策方式：普通 Agent 的行为由 LLM turn 决定；Raft Bot 的行为由确定性的程序代码决定。它更适合高频、可审计、可审批、可重复执行的工作流。

## Repo 定位

`raftbot` repo 的定位不是某一个具体 bot，而是 RaftBot 开发框架。

目标是提供一个类似 Slack/Telegram Bot SDK 的开发体验，让开发者可以轻松写出 Slock 上的程序化 bot。开发者应该只关心：

- 定义 command。
- 处理 message/event。
- 调用 `ctx.reply()`、`ctx.createTask()`、`ctx.uploadAttachment()` 等 high-level API。
- 持久化业务状态。
- 实现业务 policy。

开发者不应该直接关心：

- WebSocket 如何连接 Slock Server。
- `/daemon/connect?key=...` 怎么握手。
- `agent:start` / `agent:deliver` / `agent:deliver:ack` 的内部协议细节。
- runner credential 如何 mint。
- reconnect/watchdog/machine lock 如何处理。

这个 repo 应包含：

- framework core：daemon-compatible transport、runtime、command router、context API。
- example bots：基于 framework 实现的 demo bot。
- docs：技术方案、协议逆向、example 说明。

当前 PR 中的 example：

- `examples/prod-db-operator`：Production Database Operator demo。

## 预期上线方式

目标用户体验：

```bash
npx raftbot-prod-db-operator \
  --server-url https://api.slock.ai \
  --api-key sk_machine_xxxx
```

这里的 `--server-url` 和 `--api-key` 应该按 Slock Daemon 的语义理解，而不是一个新的 Bot REST API。

也就是说，RaftBot 伪装成一个 Slock Daemon：

```text
RaftBot process --daemon protocol--> Slock Server
```

用户或 server admin 在 Slock 里添加一个 Agent，这个 Agent 就是 bot identity。然后 RaftBot 使用 daemon key 连接到 Slock Server。Server 把这个 bot Agent 的 start/deliver 事件发给 RaftBot；RaftBot 不再启动 Claude/Codex 等 LLM runtime，而是把事件交给程序化 bot handler。

## 与 Slock Daemon 的关系

当前 Slock Daemon 的启动方式是：

```bash
slock-daemon --server-url <url> --api-key <key>
```

发布包中的 daemon 代码显示：

- CLI 参数只解析 `--server-url` 和 `--api-key`。
- daemon 使用 WebSocket 连接：

```text
<server-url with ws scheme>/daemon/connect?key=<apiKey>
```

- 连接成功后 daemon 发送 `ready`。
- Server 通过 WebSocket 下发 `agent:start`、`agent:deliver`、`agent:stop`、`reminder.*`、`machine:*` 等消息。
- Daemon 通过 WebSocket 回传 `agent:status`、`agent:activity`、`agent:deliver:ack`、`agent:session`、`pong` 等消息。

RaftBot 应该复用这套连接方式。它可以是一个“特殊 daemon”：只服务一个程序化 bot，不负责管理通用 LLM runtime。

## Daemon 模型

Phase 1 先支持一个 bot 一个 daemon：

```text
one npm package process = one daemon connection = one bot Agent identity
```

这样部署、日志、权限、状态、故障隔离都最简单。如果 Production Database Operator 挂了，只影响这个 operator bot；Reminder Bot 或其他 workflow bot 作为独立进程运行。

未来可以支持：

- 一个 daemon 运行多个不同 bot。
- bot package 和 command manifest 热更新。
- marketplace 管理安装、升级、回滚。
- Slock-hosted bot runner，让用户从 marketplace 安装后无需手动运行 `npx`。

## Runtime 与 Bot 的映射

Phase 1 可以把 Slock runtime 理解成 bot package：

```text
runtime id = raftbot-prod-db-operator
model id = default
```

RaftBot daemon 在 `ready.runtimes` 中上报具体 bot runtime id，而不是泛化的 `raftbot`：

```json
{
  "type": "ready",
  "runtimes": ["raftbot-prod-db-operator"]
}
```

当 Server 下发 `machine:runtime_models:detect` 时，daemon 返回该 bot 的默认 model：

```json
{
  "type": "machine:runtime_models:result",
  "requestId": "req",
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

实际验证中，model list 可以由 daemon 提供；如果 Agent 创建页仍无法 select runtime，说明 UI/server 还有 installed/available runtime gating。短期可给 bot runtime 加 installed/available flag 绕过；长期应由 marketplace install 写入这个状态。

## MVP Transport

MVP 采用 Slock Daemon-compatible transport：

1. 用户或 server admin 在 Slock 内添加一个 bot Agent。
2. Slock 提供可用于 daemon 连接的 API key。
3. operator 运行 `npx raftbot-xxxx --server-url <url> --api-key <key>`。
4. RaftBot 连接 WebSocket：`/daemon/connect?key=<apiKey>`。
5. RaftBot 发送 `ready`，声明自己支持 bot runtime 能力。
6. Server 下发 `agent:start` 后，RaftBot 将该 agent 绑定到本 bot handler。
7. Server 下发 `agent:deliver` 后，RaftBot 解析消息并运行 command router。
8. RaftBot 对 delivery 发送 `agent:deliver:ack`。
9. RaftBot 需要回复用户时，通过 daemon 协议或 runner credential 调用 Slock 的消息发送能力。

这个模型的关键点是：RaftBot 不是一个外部 chat bot webhook，而是 Slock Server 眼里的一个 daemon。

## Bot Runtime 边界

RaftBot 内部可以抽象为：

```ts
interface RaftBot {
  manifest: BotManifest;
  onStart(ctx: BotContext): Promise<void>;
  onMessage(event: BotMessageEvent, ctx: BotContext): Promise<void>;
  onStop?(ctx: BotContext): Promise<void>;
}
```

Daemon-compatible transport 负责：

- 建立 WebSocket。
- 发送 `ready`。
- 处理 `agent:start` / `agent:stop`。
- 处理 `agent:deliver`，并 ack。
- 向 bot handler 提供 `sendMessage`、`createTask`、`uploadAttachment` 等能力。

Bot handler 只关心业务逻辑：

- command router。
- policy check。
- approval workflow。
- reminder predicate。
- audit state。

## Bot Framework 能力

框架应提供：

- Identity：一个 bot daemon 对应一个 Slock Agent identity。
- Listener registry：监听 `#channel`、`#channel:thread`、`dm:@user` 等 target。
- Command router：解析 `/help`、`/sql <statement>`、`/approve <id>` 等 slash-style command。
- Event filter：忽略 system message，忽略 bot 自己发送的消息，支持 channel/user allowlist。
- State store：文件、SQLite、Postgres adapter，用于 cursor、approval、idempotency key、audit history。
- Workflow primitives：approval request、timeout reminder、task mirror、thread reply、attachment handling。
- Policy hooks：谁可以调用 command，谁可以审批，请求人是否允许自批。

## Agent-authored Bot

Raft Bot 本身也可以由 Agent 来实现和维护。

典型闭环：

1. 人提出需求，例如“实现一个 Production Database Operator Bot”。
2. Agent 编写 bot 代码、测试、提交 PR。
3. bot 作为确定性 daemon 运行，处理稳定、高频、可审计的动作。
4. bot 遇到复杂异常或未知 case 时，把上下文交回 Agent。
5. Agent 继续迭代 bot，再发布到 marketplace。

这样 Slock 内会同时存在两类协作者：

- LLM Agent：负责理解、设计、开发、处理复杂异常。
- Deterministic Bot：负责稳定执行程序化 workflow。

两者共享同一套 Slock 表面：channel、thread、DM、task、approval、attachment、reminder。

## 示例一：Production Database Operator Bot

场景：用户希望 Agent 操作 Production Database，但写 SQL 需要可审计、可审批。

命令：

- `/sql <statement>`：提交 production DB 写入请求。
- `/approve <id>`：manager 审批执行。
- `/reject <id>`：manager 拒绝执行。
- `/help`：查看帮助。

流程：

1. 用户或 Agent 发送 `/sql update users set plan = 'pro' where id = 'u_123'`。
2. Slock Server 将消息作为 `agent:deliver` 发给 RaftBot daemon。
3. RaftBot ack delivery，并把 message event 交给 DB Operator handler。
4. Bot 检查 policy：
   - sender 在 SQL allowlist 内：直接执行，并把结果写回 thread。
   - sender 不在 allowlist 内：创建 approval record，并在 DM 或原 thread 里 @manager 审批。
5. manager 回复 `/approve <id>` 或 `/reject <id>`。
6. 如果审批通过，bot 执行 DB adapter，并把执行结果写回原 thread。

DB 执行应该放在 adapter 后面：

```ts
interface SqlExecutor {
  explain(sql: string): Promise<SqlPlan>;
  execute(sql: string, approval: ApprovalRecord): Promise<SqlResult>;
}
```

生产控制要求：

- 默认只允许配置过的 write verb，或要求显式 `--write` flag。
- manager 审批前先执行 `EXPLAIN` 或 dry-run。
- DB credential 绑定 bot instance，不允许任意用户输入 credential。
- 非白名单 sender 必须 manager approval。
- 记录 requester、approver、SQL、timestamp、target、execution result。
- 对危险表支持双人审批。

示例运行方式：

```bash
npx raftbot-prod-db-operator \
  --server-url https://api.slock.ai \
  --api-key sk_machine_xxxx \
  --sql-allowlist "@Alice,@Bob" \
  --managers "@ichnhu" \
  --manager-target "dm:@ichnhu"
```

## 示例二：Programmatic Reminder Bot

Slock 当前 reminder 偏时间触发；Raft Bot Reminder 可以支持任意程序化规则，因为 bot 自己拥有检测循环。

命令示例：

- `/remind in 10m review deploy result`
- `/remind at 2026-06-11T16:00:00Z run settlement check`
- 未来：`/remind when job nightly_import failed for 3 runs`
- 未来：`/remind when BTC drawdown > 8% and volume spike`

实现模型：

1. command handler 解析 rule 并保存 reminder record。
2. scheduler loop 周期性评估 due reminders 和 predicate。
3. rule 命中后，bot 向目标 channel/thread/DM 发送提醒，并标记 fired。
4. 复杂规则通过 predicate adapter 实现，例如轮询 DB、queue、metrics、CI、webhook。

这使 reminder 成为 bot/plugin 能力，而不只是 Slock Server 内置的固定时间能力。

## Slash Command 语义

MVP 阶段，slash command 可以先是普通 Slock message，首 token 以 `/` 开头。这不需要 UI/server 改动，channel、thread、DM 都能工作。

后续可以加入 native command manifest：

- bot 发布 command manifest：command 名称、参数 schema、help text、scopes。
- Slock UI 支持 `/help`、`/sql` 等 autocomplete。
- Server 投递 structured command event 给 bot，同时在 chat 中保留可审计记录。

## 可靠性

- 使用 delivery id/message id 作为 idempotency key。
- 对每个 `agent:deliver` 处理成功后发送 `agent:deliver:ack`。
- 保存 outbound send result，避免 restart 后重复回复。
- Phase 1 每个 bot daemon 使用 machine lock，保证同一 daemon key 只有一个 active process。
- WebSocket 断线后按 Slock Daemon 的 reconnect/backoff 逻辑恢复。

## 安全性

- daemon API key 等价于 machine key，需要同等级保护。
- bot membership/scopes 只授予必要 channel、DM、task、attachment 权限。
- command permission 必须在 bot code 内强制校验，不能只依赖 UI。
- approval decision 和 execution result 必须 append-only audit。
- 禁止把任意 shell execution 暴露为 bot command。

## Marketplace 方向

未来 Raft Bot Marketplace 中的 bot package 应包含：

- manifest：name、description、version、commands、required scopes、event subscriptions。
- install schema：需要配置的 env/secrets，例如 DB DSN、manager target、allowlists。
- runtime package：npm package 或 Slock-hosted runtime bundle。
- permission request：channel、DM、task、attachment、external network/secrets。
- audit contract：决策和执行记录写到哪里。

安装流程：

1. server admin 从 marketplace 选择 bot。
2. Slock 创建或关联一个 Agent identity。
3. admin 审批 scopes，并配置 secrets/policies。
4. Slock 为该 bot daemon 生成 daemon-compatible API key。
5. operator 手动运行 `npx <package> --server-url <url> --api-key <key>`，或由 Slock-hosted runner 自动运行。
6. Slock 根据 command manifest 暴露 native slash commands。

这个方向会让 Raft Bot 成为 Slock-native 的程序化 CLI 层：不是所有操作都由 LLM Agent 即时推理，而是由可复用、可审计、可安装的 bot package 承载确定性 workflow。

## Slack 和 Telegram 参考

Slack 的成熟模型：

- Events API 通过 HTTP callback 或 Socket Mode 给 app/bot 投递事件。
- Slash command 从 composer 触发，向 app 投递结构化 payload。
- App 声明 scopes，并安装到 workspace。
- App directory/marketplace 支持发现、安装、权限审查、更新。

Telegram 的成熟模型：

- Bot 通过 `getUpdates` long polling 或 webhook 接收 update。
- Update 是 JSON object，并带有递增 offset。
- 发送消息是简单 API call，例如 `sendMessage`。
- Bot commands 可声明，客户端可以展示 command help/autocomplete。

Raft Bot 不直接照搬 Slack/Telegram 的 HTTP webhook 模型，而是借鉴它们的产品抽象：bot install、command manifest、scope approval、marketplace。底层 transport 则优先复用 Slock Daemon 协议。

官方参考：

- Slack Events API: https://docs.slack.dev/apis/events-api/
- Slack slash commands: https://docs.slack.dev/interactivity/implementing-slash-commands
- Telegram Bot API updates: https://core.telegram.org/bots/api#getting-updates

## 推荐里程碑

1. Daemon-compatible RaftBot transport：WebSocket `/daemon/connect?key=...`。
2. 处理 `ready`、`agent:start`、`agent:deliver`、`agent:deliver:ack`、`machine:runtime_models:detect`。
3. Bot SDK：command router、state store、policy hooks。
4. Production Database Operator demo。
5. Programmatic Reminder demo。
6. Bot manifest 和 native `/help` generation。
7. Marketplace install schema 和 scope approval。
8. Multi-bot daemon、hot update、Slock-hosted runner。
