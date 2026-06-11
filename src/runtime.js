import { DaemonConnection, readyMessage } from "./daemon-connection.js";

export function createBot() {
  const commands = new Map();
  let activeAgentId = null;
  let connection = null;

  const bot = {
    command(name, handler) {
      commands.set(normalizeCommand(name), handler);
      return bot;
    },

    async start(options) {
      connection = new DaemonConnection({
        serverUrl: options.serverUrl,
        apiKey: options.apiKey,
        onOpen: () => {
          connection.send(readyMessage({ daemonVersion: options.daemonVersion }));
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
        connection.send({
          type: "agent:activity",
          agentId: msg.agentId,
          activity: "message",
          detail: text,
          launchId: msg.launchId
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
  }

  return bot;
}

function normalizeCommand(name) {
  return name.replace(/^\//, "").trim().toLowerCase();
}

function normalizeMessageEvent(msg) {
  const message = msg.message ?? {};
  return {
    id: message.message_id ?? "",
    target: message.target ?? message.channel_name ?? "",
    sender: message.sender_name ? `@${message.sender_name}` : "",
    text: message.content ?? ""
  };
}

export function parseSlashCommand(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  const [rawName, ...args] = trimmed.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  if (!name) return null;
  return { name, args };
}
