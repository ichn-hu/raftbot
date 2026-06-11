import { DaemonConnection, readyMessage } from "./daemon-connection.js";
import { AgentApiClient } from "./agent-api.js";

export function createBot() {
  const commands = new Map();
  const agents = new Map();
  let connection = null;
  let agentApi = null;
  let runtimeLabel = "RaftBot";
  let modelId = "default";

  const bot = {
    command(name, handler) {
      commands.set(normalizeCommand(name), handler);
      return bot;
    },

    async start(options) {
      runtimeLabel = options.runtimeLabel ?? options.runtimeId ?? "RaftBot";
      modelId = options.modelId ?? "default";
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
        agents.set(msg.agentId, {
          launchId: msg.launchId,
          activity: "online",
          detail: "RaftBot ready",
          clientSeq: 1
        });
        connection.send({ type: "agent:status", agentId: msg.agentId, status: "active", launchId: msg.launchId });
        sendActivity(msg.agentId, "online", "RaftBot ready", msg.launchId);
        break;
      case "agent:stop":
        agents.delete(msg.agentId);
        connection.send({ type: "agent:status", agentId: msg.agentId, status: "inactive", launchId: msg.launchId });
        break;
      case "agent:deliver":
        await handleDelivery(msg);
        break;
      case "agent:activity_probe":
        respondToActivityProbe(msg.agentId, msg.probeId);
        break;
      case "machine:runtime_models:detect":
        connection.send({
          type: "machine:runtime_models:result",
          requestId: msg.requestId,
          models: [{ id: modelId, label: runtimeLabel, verified: true }],
          default: modelId
        });
        break;
      default:
        break;
    }
  }

  async function handleDelivery(msg) {
    sendActivity(msg.agentId, "working", "Message received", msg.launchId);
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
    sendActivity(msg.agentId, "online", "Process idle", msg.launchId);
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

  function respondToActivityProbe(agentId, probeId) {
    const state = agents.get(agentId);
    if (!state) {
      connection.send({
        type: "agent:activity",
        agentId,
        activity: "offline",
        detail: "Agent not running",
        probeId
      });
      return;
    }
    connection.send({
      type: "agent:activity",
      agentId,
      activity: state.activity,
      detail: state.detail,
      launchId: state.launchId,
      probeId,
      clientSeq: state.clientSeq++
    });
  }

  function sendActivity(agentId, activity, detail, launchId) {
    const state = agents.get(agentId);
    if (state) {
      state.activity = activity;
      state.detail = detail;
      if (launchId) state.launchId = launchId;
    }
    connection.send({
      type: "agent:activity",
      agentId,
      activity,
      detail,
      launchId: launchId || state?.launchId || void 0,
      clientSeq: state ? state.clientSeq++ : void 0
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
