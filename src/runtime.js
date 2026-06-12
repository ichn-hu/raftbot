import { DaemonConnection, readyMessage } from "./daemon-connection.js";
import { AgentApiClient } from "./agent-api.js";
import { log } from "./logger.js";

export function createBot() {
  const commands = new Map();
  const messageHandlers = new Set();
  const agents = new Map();
  let connection = null;
  let agentApi = null;
  let runtimeLabel = "RaftBot";
  let modelId = "default";
  let botOptions = {};

  const bot = {
    command(name, handler) {
      commands.set(normalizeCommand(name), handler);
      return bot;
    },

    onMessage(handler) {
      messageHandlers.add(handler);
      return bot;
    },

    async start(options) {
      botOptions = options;
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
        log("agent.start", {
          agentId: msg.agentId,
          launchId: msg.launchId,
          runtime: msg.config?.runtime,
          model: msg.config?.model
        });
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
        log("agent.stop", { agentId: msg.agentId, launchId: msg.launchId });
        agents.delete(msg.agentId);
        connection.send({ type: "agent:status", agentId: msg.agentId, status: "inactive", launchId: msg.launchId });
        break;
      case "agent:deliver":
        log("agent.deliver", {
          agentId: msg.agentId,
          seq: msg.seq,
          deliveryId: msg.deliveryId,
          messageId: msg.message?.message_id,
          sender: msg.message?.sender_name,
          channelType: msg.message?.channel_type,
          channelName: msg.message?.channel_name,
          parentChannelType: msg.message?.parent_channel_type,
          parentChannelName: msg.message?.parent_channel_name
        });
        await handleDelivery(msg);
        break;
      case "agent:workspace:list":
        log("agent.workspace.list", { agentId: msg.agentId, dirPath: msg.dirPath });
        connection.send({
          type: "agent:workspace:file_tree",
          agentId: msg.agentId,
          files: [],
          dirPath: msg.dirPath
        });
        break;
      case "agent:workspace:read":
        log("agent.workspace.read", { agentId: msg.agentId, path: msg.path, requestId: msg.requestId });
        connection.send({
          type: "agent:workspace:file_content",
          agentId: msg.agentId,
          requestId: msg.requestId,
          content: null,
          binary: false,
          size: 0
        });
        break;
      case "agent:activity_probe":
        respondToActivityProbe(msg.agentId, msg.probeId);
        break;
      case "agent:skills:list":
        log("agent.skills.list", { agentId: msg.agentId });
        connection.send({
          type: "agent:skills:list_result",
          agentId: msg.agentId,
          global: [],
          workspace: []
        });
        break;
      case "machine:runtime_models:detect":
        log("runtime.models.detect", { runtime: msg.runtime, requestId: msg.requestId, modelId, runtimeLabel });
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
    const event = normalizeMessageEvent(msg, botOptions);
    const parsed = parseSlashCommand(event.commandText);
    event.command = parsed;
    const ctx = createContext(msg, event, parsed);
    try {
      for (const messageHandler of messageHandlers) {
        await messageHandler(ctx);
      }
      if (!parsed) {
        log("command.skip", { reason: "not_slash", agentId: msg.agentId, messageId: event.id });
        sendActivity(msg.agentId, "online", "Process idle", msg.launchId);
        return;
      }
      if (!event.addressed) {
        log("command.skip", {
          reason: "not_addressed",
          command: parsed.name,
          agentId: msg.agentId,
          messageId: event.id,
          surface: event.surface.kind
        });
        sendActivity(msg.agentId, "online", "Process idle", msg.launchId);
        return;
      }
      const handler = commands.get(parsed.name);
      if (!handler) {
        log("command.skip", { reason: "unknown_command", command: parsed.name, agentId: msg.agentId, messageId: event.id });
        sendActivity(msg.agentId, "online", "Process idle", msg.launchId);
        return;
      }
      log("command.start", {
        command: parsed.name,
        agentId: msg.agentId,
        messageId: event.id,
        replyTarget: event.replyTarget,
        seenUpToSeq: msg.seq
      });
      await handler(ctx);
      log("command.ok", { command: parsed.name, agentId: msg.agentId, messageId: event.id });
      sendActivity(msg.agentId, "online", "Process idle", msg.launchId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log("command.failed", { command: parsed?.name ?? null, agentId: msg.agentId, messageId: event.id, detail });
      sendActivity(msg.agentId, "error", detail, msg.launchId);
    } finally {
      ackDelivery(msg);
    }
  }

  function createContext(msg, event, parsed) {
    return {
      agentId: msg.agentId,
      event,
      command: parsed?.name ?? null,
      args: parsed?.args ?? [],
      async reply(text) {
        log("ctx.reply", {
          agentId: msg.agentId,
          target: event.replyTarget,
          seenUpToSeq: msg.seq,
          contentLength: text.length
        });
        await agentApi.sendMessage(msg.agentId, event.replyTarget, text, {
          seenUpToSeq: msg.seq
        });
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
    log("agent.deliver.ack", {
      agentId: msg.agentId,
      seq: msg.seq > 0 ? msg.seq : msg.message?.seq ?? 0,
      deliveryId: msg.deliveryId
    });
  }

  function respondToActivityProbe(agentId, probeId) {
    const state = agents.get(agentId);
    if (!state) {
      log("agent.activity_probe", { agentId, probeId, activity: "offline" });
      connection.send({
        type: "agent:activity",
        agentId,
        activity: "offline",
        detail: "Agent not running",
        probeId
      });
      return;
    }
    log("agent.activity_probe", { agentId, probeId, activity: state.activity });
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

function normalizeMessageEvent(msg, options = {}) {
  const message = msg.message ?? {};
  const target = formatTarget(message);
  const surface = formatSurface(message, target);
  const mentioned = detectMention(message);
  return {
    id: message.message_id ?? "",
    target,
    replyTarget: formatReplyTarget(message),
    surface,
    mentioned,
    addressed: isAddressed(surface, mentioned, options),
    sender: message.sender_name ? `@${message.sender_name}` : "",
    text: message.content ?? "",
    commandText: stripAddressingPrefix(message.content ?? "", mentioned)
  };
}

function formatTarget(message) {
  if (message.target) return message.target;
  if (message.channel_type === "thread" && message.parent_channel_name) {
    const shortId = getMessageShortId(message.channel_name);
    if (message.parent_channel_type === "dm") return `dm:@${message.parent_channel_name}:${shortId}`;
    return `#${message.parent_channel_name}:${shortId}`;
  }
  if (message.channel_type === "dm") return `dm:@${message.channel_name}`;
  if (message.channel_name) return `#${message.channel_name}`;
  return "";
}

function formatReplyTarget(message) {
  if (message.reply_target) return message.reply_target;
  if (message.channel_type === "thread") return formatTarget(message);
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

function getMessageShortId(messageId) {
  const value = String(messageId ?? "");
  return value.startsWith("thread-") ? value.slice("thread-".length) : value.slice(0, 8);
}

function formatSurface(message, target) {
  if (message.channel_type === "thread") {
    return {
      kind: "thread",
      target,
      threadShortId: getMessageShortId(message.channel_name),
      parent: message.parent_channel_name ? {
        kind: message.parent_channel_type === "dm" ? "dm" : "channel",
        name: message.parent_channel_name
      } : null
    };
  }
  if (message.channel_type === "dm") {
    return { kind: "dm", target, name: message.channel_name ?? "" };
  }
  return { kind: "channel", target, name: message.channel_name ?? "" };
}

function detectMention(message) {
  return message.mention === true || message.mentioned === true || message.is_mention === true;
}

function isAddressed(surface, mentioned, options = {}) {
  if (surface.kind === "dm" || surface.kind === "thread") return true;
  if (mentioned) return true;
  return options.ambientChannelCommands === true;
}

function stripAddressingPrefix(text, mentioned) {
  const trimmed = String(text ?? "").trim();
  if (!mentioned) return trimmed;
  return trimmed.replace(/^@\S+\s+/, "").trim();
}

export function parseSlashCommand(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  const [rawName, ...args] = trimmed.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  if (!name) return null;
  return { name, args };
}
