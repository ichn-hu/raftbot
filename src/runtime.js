import { DaemonConnection, readyMessage } from "./daemon-connection.js";
import { AgentApiClient } from "./agent-api.js";
import { log } from "./logger.js";
import { JsonStateStore } from "./state-store.js";

export function createBot() {
  const commands = new Map();
  const messageHandlers = new Set();
  const startHandlers = new Set();
  const stopHandlers = new Set();
  const scheduledJobs = [];
  const agents = new Map();
  let connection = null;
  let agentApi = null;
  let runtimeLabel = "RaftBot";
  let modelId = "default";
  let botOptions = {};
  let stateStore = null;

  const bot = {
    command(name, handler) {
      commands.set(normalizeCommand(name), handler);
      return bot;
    },

    onMessage(handler) {
      messageHandlers.add(handler);
      return bot;
    },

    onStart(handler) {
      startHandlers.add(handler);
      return bot;
    },

    onStop(handler) {
      stopHandlers.add(handler);
      return bot;
    },

    every(interval, handler, options = {}) {
      scheduledJobs.push({
        intervalMs: parseIntervalMs(interval),
        handler,
        immediate: options.immediate !== false
      });
      return bot;
    },

    async start(options) {
      botOptions = options;
      runtimeLabel = options.runtimeLabel ?? options.runtimeId ?? "RaftBot";
      modelId = options.modelId ?? "default";
      stateStore = new JsonStateStore(resolveWorkspaceRoot(options));
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
        {
          if (!acceptsAgentStart(msg.config)) {
            log("agent.start.ignored", {
              agentId: msg.agentId,
              runtime: msg.config?.runtime,
              model: msg.config?.model,
              expectedModel: modelId
            });
            connection.send({ type: "agent:status", agentId: msg.agentId, status: "inactive", launchId: msg.launchId });
            sendActivity(msg.agentId, "offline", "RaftBot model mismatch", msg.launchId);
            break;
          }
          const profile = await loadAgentProfile(msg.agentId);
          const mentionNames = buildMentionNames(profile, botOptions);
          log("agent.start", {
            agentId: msg.agentId,
            launchId: msg.launchId,
            runtime: msg.config?.runtime,
            model: msg.config?.model,
            profileName: profile?.name,
            displayName: profile?.displayName,
            mentionNames
          });
          agents.set(msg.agentId, {
            launchId: msg.launchId,
            activity: "online",
            detail: "RaftBot ready",
            clientSeq: 1,
            profile,
            mentionNames,
            workspacePath: stateStore.forAgent(msg.agentId).workspacePath,
            jobs: []
          });
          connection.send({ type: "agent:status", agentId: msg.agentId, status: "active", launchId: msg.launchId });
          sendActivity(msg.agentId, "online", "RaftBot ready", msg.launchId);
          await runStartHandlers(msg.agentId);
          startScheduledJobs(msg.agentId);
          break;
        }
      case "agent:stop":
        log("agent.stop", { agentId: msg.agentId, launchId: msg.launchId });
        await runStopHandlers(msg.agentId);
        stopScheduledJobs(msg.agentId);
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
          parentChannelName: msg.message?.parent_channel_name,
          serverMention: msg.message?.mention ?? msg.message?.mentioned ?? msg.message?.is_mention,
          textPrefix: String(msg.message?.content ?? "").slice(0, 80)
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
    const event = normalizeMessageEvent(msg, botOptions, agents.get(msg.agentId));
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
      ...createAgentContext(msg.agentId),
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

  function createAgentContext(agentId) {
    const state = stateStore.forAgent(agentId);
    return {
      agentId,
      workspace: {
        path: state.workspacePath
      },
      state,
      profile: {
        get: () => agentApi.getAgentProfile(agentId),
        update: (input) => agentApi.updateProfile(agentId, input),
        setAvatar: (input) => agentApi.updateAvatar(agentId, input)
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

  async function loadAgentProfile(agentId) {
    try {
      return await agentApi.getAgentProfile(agentId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log("agent.profile.unavailable", { agentId, detail });
      return null;
    }
  }

  function acceptsAgentStart(config) {
    if (botOptions.acceptAllModels === true) return true;
    if (!modelId || modelId === "default") return true;
    return config?.model === modelId;
  }

  async function runStartHandlers(agentId) {
    const ctx = createAgentContext(agentId);
    for (const handler of startHandlers) {
      await runLifecycleHandler("start", agentId, handler, ctx);
    }
  }

  async function runStopHandlers(agentId) {
    const ctx = createAgentContext(agentId);
    for (const handler of stopHandlers) {
      await runLifecycleHandler("stop", agentId, handler, ctx);
    }
  }

  async function runLifecycleHandler(kind, agentId, handler, ctx) {
    try {
      log(`agent.${kind}.handler.start`, { agentId });
      await handler(ctx);
      log(`agent.${kind}.handler.ok`, { agentId });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log(`agent.${kind}.handler.failed`, { agentId, detail });
      sendActivity(agentId, "error", detail);
    }
  }

  function startScheduledJobs(agentId) {
    const state = agents.get(agentId);
    if (!state || scheduledJobs.length === 0) return;
    for (const job of scheduledJobs) {
      const runner = createScheduledRunner(agentId, job);
      const timer = setInterval(runner, job.intervalMs);
      timer.unref?.();
      state.jobs.push(timer);
      if (job.immediate) void runner();
    }
  }

  function stopScheduledJobs(agentId) {
    const state = agents.get(agentId);
    if (!state) return;
    for (const timer of state.jobs ?? []) clearInterval(timer);
    state.jobs = [];
  }

  function createScheduledRunner(agentId, job) {
    let running = false;
    return async () => {
      if (running || !agents.has(agentId)) return;
      running = true;
      try {
        log("agent.job.start", { agentId, intervalMs: job.intervalMs });
        await job.handler(createAgentContext(agentId));
        log("agent.job.ok", { agentId, intervalMs: job.intervalMs });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log("agent.job.failed", { agentId, intervalMs: job.intervalMs, detail });
        sendActivity(agentId, "error", detail);
      } finally {
        running = false;
      }
    };
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

function resolveWorkspaceRoot(options) {
  return options.workspaceRoot || process.env.RAFTBOT_WORKSPACE_ROOT || ".raftbot/agents";
}

function parseIntervalMs(interval) {
  if (typeof interval === "number" && Number.isFinite(interval) && interval > 0) return interval;
  const match = String(interval).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!match) {
    throw new Error(`Invalid interval "${interval}". Use a positive number of ms or strings like 30s, 1m, 2h.`);
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  const ms = value * multiplier;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`Invalid interval "${interval}".`);
  }
  return ms;
}

function normalizeMessageEvent(msg, options = {}, agentState = null) {
  const message = msg.message ?? {};
  const target = formatTarget(message);
  const surface = formatSurface(message, target);
  const addressing = detectAddressing(message, agentState, options);
  return {
    id: message.message_id ?? "",
    target,
    replyTarget: formatReplyTarget(message),
    surface,
    mentioned: addressing.mentioned,
    mentionedName: addressing.mentionedName,
    addressed: isAddressed(surface, addressing.mentioned, options),
    sender: message.sender_name ? `@${message.sender_name}` : "",
    text: message.content ?? "",
    commandText: stripAddressingPrefix(message.content ?? "", addressing.stripLeadingMention)
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

function detectAddressing(message, agentState, options = {}) {
  const serverMention = message.mention === true || message.mentioned === true || message.is_mention === true;
  const leadingMention = parseLeadingMention(message.content);
  const mentionNames = agentState?.mentionNames?.length ? agentState.mentionNames : buildMentionNames(null, options);
  const leadingMatches = leadingMention ? mentionNames.includes(normalizeMentionName(leadingMention.name)) : false;
  return {
    mentioned: serverMention || leadingMatches,
    mentionedName: leadingMention?.name ?? null,
    stripLeadingMention: serverMention || leadingMatches
  };
}

function isAddressed(surface, mentioned, options = {}) {
  if (surface.kind === "dm" || surface.kind === "thread") return true;
  if (mentioned) return true;
  return options.ambientChannelCommands === true;
}

function stripAddressingPrefix(text, stripLeadingMention) {
  const trimmed = String(text ?? "").trim();
  if (!stripLeadingMention) return trimmed;
  return trimmed.replace(/^@\S+\s+/, "").trim();
}

function parseLeadingMention(text) {
  const match = String(text ?? "").trim().match(/^@(\S+)\s+([\s\S]*)$/);
  if (!match) return null;
  return { name: match[1], rest: match[2] };
}

function buildMentionNames(profile, options = {}) {
  const names = new Set();
  addMentionName(names, profile?.name);
  addMentionName(names, profile?.displayName);
  for (const name of parseListOption(options.botHandles ?? options.botHandle)) {
    addMentionName(names, name);
  }
  return [...names];
}

function addMentionName(names, value) {
  const normalized = normalizeMentionName(value);
  if (normalized) names.add(normalized);
}

function normalizeMentionName(value) {
  return String(value ?? "").trim().replace(/^@/, "").toLowerCase();
}

function parseListOption(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

export function parseSlashCommand(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  const [rawName, ...args] = trimmed.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  if (!name) return null;
  return { name, args };
}
