import { DaemonConnection, readyMessage } from "./daemon-connection.js";
import { AgentApiClient } from "./agent-api.js";

export function createBot() {
  const commands = new Map();
  let activeAgentId = null;
  let connection = null;
  let agentApi = null;
  let runtimeLabel = "RaftBot";

  const bot = {
    command(name, handler) {
      commands.set(normalizeCommand(name), handler);
      return bot;
    },

    async start(options) {
      runtimeLabel = options.runtimeLabel ?? options.runtimeId ?? "RaftBot";
      agentApi = new AgentApiClient({
        serverUrl: options.serverUrl,
        apiKey: options.apiKey
      });
      connection = new DaemonConnection({
        serverUrl: options.serverUrl,
        apiKey: options.apiKey,
        onOpen: () => {
          connection.send(readyMessage({
            daemonVersion: options.daemonVersion,
            runtimeId: options.runtimeId,
            runtimes: parseRuntimeIds(options)
          }));
        },
        onMessage: (msg) => {
          void handleDaemonMessage(msg);
        }
      });
      connection.connect();
    }
  };

  async function handleDaemonMessage(msg) {
    switch (msg.type) {
      case "ping":
        connection.send({ type: "pong" });
        break;
      case "agent:start":
        activeAgentId = msg.agentId;
        connection.send({ type: "agent:status", agentId: msg.agentId, status: "active", launchId: msg.launchId });
        connection.send({ type: "agent:activity", agentId: msg.agentId, activity: "online", detail: "RaftBot ready", launchId: msg.launchId });
        break;
      case "agent:stop":
        if (msg.agentId === activeAgentId) activeAgentId = null;
        connection.send({ type: "agent:status", agentId: msg.agentId, status: "inactive", launchId: msg.launchId });
        break;
      case "agent:deliver":
        await handleDelivery(msg);
        break;
      case "machine:runtime_models:detect":
        connection.send({
          type: "machine:runtime_models:result",
          requestId: msg.requestId,
          models: [{ id: options.modelId ?? "default", label: runtimeLabel, verified: true }],
          default: options.modelId ?? "default"
        });
        break;
      default:
        break;
    }
  }

  async function handleDelivery(msg) {
    const event = normalizeMessageEvent(msg);
    const parsed = parseSlashCommand(event.text);
    if (!parsed) {
      ackDelivery(msg);
      return;
    }
    const handler = commands.get(parsed.name);
    if (!handler) {
      ackDelivery(msg);
      return;
    }
    const ctx = createContext(msg, event, parsed);
    await handler(ctx);
    ackDelivery(msg);
  }

  function createContext(msg, event, parsed) {
    return {
      agentId: msg.agentId,
      event,
      command: parsed.name,
      args: parsed.args,
      async reply(text) {
        await agentApi.sendMessage(msg.agentId, event.replyTarget, text);
      }
    };
  }

  function ackDelivery(msg) {
    connection.send({
      type: "agent:deliver:ack",
      agentId: msg.agentId,
      seq: msg.seq > 0 ? msg.seq : msg.message?.seq ?? 0,
      deliveryId: msg.deliveryId
    });
  }

  return bot;
}

function normalizeCommand(name) {
  return name.replace(/^\//, "").trim().toLowerCase();
}

function parseRuntimeIds(options) {
  if (Array.isArray(options.runtimeIds) && options.runtimeIds.length > 0) return options.runtimeIds;
  if (typeof options.runtimeIds === "string" && options.runtimeIds.trim()) {
    return options.runtimeIds.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [options.runtimeId ?? "raftbot"];
}

function normalizeMessageEvent(msg) {
  const message = msg.message ?? {};
  return {
    id: message.message_id ?? "",
    target: formatTarget(message),
    replyTarget: formatReplyTarget(message),
    sender: message.sender_name ? `@${message.sender_name}` : "",
    text: message.content ?? ""
  };
}

function formatTarget(message) {
  if (message.target) return message.target;
  if (message.channel_type === "dm") return `dm:@${message.channel_name}`;
  if (message.channel_name) return `#${message.channel_name}`;
  return "";
}

function formatReplyTarget(message) {
  if (message.reply_target) return message.reply_target;
  if (message.thread_short_id && message.channel_name) {
    const base = message.channel_type === "dm" ? `dm:@${message.channel_name}` : `#${message.channel_name}`;
    return `${base}:${message.thread_short_id}`;
  }
  if (message.thread_id && message.channel_name) {
    const base = message.channel_type === "dm" ? `dm:@${message.channel_name}` : `#${message.channel_name}`;
    return `${base}:${String(message.thread_id).slice(0, 8)}`;
  }
  const base = formatTarget(message);
  return message.message_id && base && !base.includes(":") ? `${base}:${message.message_id.slice(0, 8)}` : base;
}

export function parseSlashCommand(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  const [rawName, ...args] = trimmed.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  if (!name) return null;
  return { name, args };
}
