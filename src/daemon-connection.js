import WebSocket from "ws";
import os from "node:os";

export class DaemonConnection {
  constructor(options) {
    this.serverUrl = options.serverUrl;
    this.apiKey = options.apiKey;
    this.onMessage = options.onMessage;
    this.onOpen = options.onOpen ?? (() => {});
    this.onClose = options.onClose ?? (() => {});
    this.ws = null;
    this.shouldConnect = false;
    this.reconnectDelayMs = 1000;
  }

  connect() {
    this.shouldConnect = true;
    this.open();
  }

  close() {
    this.shouldConnect = false;
    this.ws?.close();
  }

  send(message) {
    const payload = JSON.stringify(message);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    }
  }

  open() {
    if (!this.shouldConnect) return;
    const wsUrl = this.serverUrl.replace(/^http/, "ws") + `/daemon/connect?key=${encodeURIComponent(this.apiKey)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on("open", () => {
      console.error(`[raftbot] connected to ${this.serverUrl}`);
      this.reconnectDelayMs = 1000;
      this.onOpen();
    });

    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type !== "ping") console.error(`[raftbot] received ${msg.type}`);
      this.onMessage(msg);
    });

    ws.on("close", () => {
      console.error("[raftbot] disconnected");
      this.onClose();
      if (!this.shouldConnect) return;
      const delay = this.reconnectDelayMs;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30000);
      setTimeout(() => this.open(), delay);
    });

    ws.on("error", () => {
      ws.close();
    });
  }
}

export function readyMessage(options = {}) {
  const runtimes = options.runtimes ?? [options.runtimeId ?? "raftbot"];
  return {
    type: "ready",
    capabilities: ["agent:start", "agent:stop", "agent:deliver"],
    runtimes,
    runningAgents: [],
    hostname: options.hostname ?? os.hostname(),
    os: options.os ?? `${os.platform()} ${os.arch()}`,
    daemonVersion: options.daemonVersion ?? "raftbot/0.0.0"
  };
}
