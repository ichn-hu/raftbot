const RUNNER_SCOPES = ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge"];
import { log } from "./logger.js";

export class AgentApiClient {
  constructor(options) {
    this.serverUrl = options.serverUrl;
    this.machineApiKey = options.apiKey;
    this.agentCredentials = new Map();
  }

  async sendMessage(agentId, target, content, options = {}) {
    const credential = await this.getAgentCredential(agentId);
    const attachmentIds = normalizeAttachmentIds(options.attachmentIds);
    log("agent_api.send.start", {
      agentId,
      target,
      seenUpToSeq: options.seenUpToSeq,
      contentLength: content.length,
      attachmentCount: attachmentIds.length
    });
    const body = {
      target,
      content,
      draftReholdCount: 0,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(Number.isInteger(options.seenUpToSeq) && options.seenUpToSeq > 0 ? { seenUpToSeq: options.seenUpToSeq } : {})
    };
    const first = await this.postSend(agentId, credential, body);
    if (first?.state !== "held") {
      log("agent_api.send.ok", { agentId, target, messageId: first.messageId });
      return first;
    }
    log("agent_api.send.held", { agentId, target, seenUpToSeq: first.seenUpToSeq });
    const retry = await this.postSend(agentId, credential, {
      target,
      content,
      draftReholdCount: 1,
      sendDraft: true,
      continueAnyway: true,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(Number.isInteger(first.seenUpToSeq) && first.seenUpToSeq > 0 ? { seenUpToSeq: first.seenUpToSeq } : {})
    });
    if (retry?.state === "held") {
      log("agent_api.send.rehold", { agentId, target, seenUpToSeq: retry.seenUpToSeq });
      throw new Error(`send_message_held: ${JSON.stringify(retry).slice(0, 500)}`);
    }
    log("agent_api.send.ok", { agentId, target, messageId: retry.messageId, freshnessRetry: true });
    return retry;
  }

  async uploadAttachment(agentId, target, input) {
    const credential = await this.getAgentCredential(agentId);
    const filename = input.filename ?? "attachment";
    const mimeType = input.mimeType ?? "application/octet-stream";
    const bytes = input.bytes instanceof Uint8Array ? input.bytes : Uint8Array.from(input.bytes ?? []);
    if (bytes.byteLength === 0) {
      throw new Error("attachment_upload_failed: empty attachment bytes");
    }

    const channelId = await this.resolveChannel(agentId, credential, target);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType }), filename);
    form.append("channelId", channelId);
    if (input.mimeType) form.append("mimeType", mimeType);

    log("agent_api.attachment.upload.start", {
      agentId,
      target,
      channelId,
      filename,
      mimeType,
      size: bytes.byteLength
    });
    const res = await fetch(new URL(`/internal/agent/${encodeURIComponent(agentId)}/upload`, this.serverUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        "X-Agent-Id": agentId,
        "X-Slock-Client": "raftbot"
      },
      body: form
    });
    if (!res.ok) {
      const detail = await safeErrorDetail(res);
      log("agent_api.attachment.upload.failed", { agentId, target, status: res.status, detail });
      throw new Error(`attachment_upload_failed: HTTP ${res.status} ${detail}`);
    }
    const body = await res.json().catch(() => ({}));
    if (typeof body.id !== "string" || !body.id) {
      throw new Error(`attachment_upload_failed: invalid upload response ${JSON.stringify(body).slice(0, 300)}`);
    }
    log("agent_api.attachment.upload.ok", { agentId, target, attachmentId: body.id });
    return body;
  }

  async resolveChannel(agentId, credential, target) {
    log("agent_api.resolve_channel.start", { agentId, target });
    const res = await fetch(new URL(`/internal/agent/${encodeURIComponent(agentId)}/resolve-channel`, this.serverUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        "Content-Type": "application/json",
        "X-Agent-Id": agentId,
        "X-Slock-Client": "raftbot"
      },
      body: JSON.stringify({ target })
    });
    if (!res.ok) {
      const detail = await safeErrorDetail(res);
      log("agent_api.resolve_channel.failed", { agentId, target, status: res.status, detail });
      throw new Error(`resolve_channel_failed: HTTP ${res.status} ${detail}`);
    }
    const body = await res.json().catch(() => ({}));
    if (typeof body.channelId !== "string" || !body.channelId) {
      throw new Error(`resolve_channel_failed: invalid response ${JSON.stringify(body).slice(0, 300)}`);
    }
    log("agent_api.resolve_channel.ok", { agentId, target, channelId: body.channelId });
    return body.channelId;
  }

  async postSend(agentId, credential, body) {
    const res = await fetch(new URL("/internal/agent-api/send", this.serverUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        "Content-Type": "application/json",
        "X-Agent-Id": agentId,
        "X-Slock-Client": "raftbot"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = await safeErrorDetail(res);
      log("agent_api.send.failed", { agentId, target: body.target, status: res.status, detail });
      throw new Error(`send_message_failed: HTTP ${res.status} ${detail}`);
    }
    return res.json().catch(() => ({}));
  }

  async updateProfile(agentId, input) {
    const body = {};
    if (typeof input.description === "string") body.description = input.description;
    if (typeof input.displayName === "string") body.displayName = input.displayName;
    if (typeof input.avatarUrl === "string") body.avatarUrl = input.avatarUrl;
    if (Object.keys(body).length === 0) {
      throw new Error("profile_update_failed: no profile fields provided");
    }
    log("agent_api.profile.update.start", { agentId, fields: Object.keys(body) });
    const res = await fetch(new URL(`/internal/agent/${encodeURIComponent(agentId)}/profile`, this.serverUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.machineApiKey}`,
        "Content-Type": "application/json",
        "X-Agent-Id": agentId,
        "X-Slock-Client": "raftbot"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const detail = await safeErrorDetail(res);
      log("agent_api.profile.update.failed", { agentId, status: res.status, detail });
      throw new Error(`profile_update_failed: HTTP ${res.status} ${detail}`);
    }
    const profile = await res.json();
    log("agent_api.profile.update.ok", { agentId });
    return profile;
  }

  async updateAvatar(agentId, input) {
    const filename = input.filename ?? "avatar.png";
    const mimeType = input.mimeType ?? "image/png";
    const bytes = input.bytes instanceof Uint8Array ? input.bytes : Uint8Array.from(input.bytes ?? []);
    if (bytes.byteLength === 0) {
      throw new Error("avatar_update_failed: empty avatar bytes");
    }
    const form = new FormData();
    form.append("avatar", new Blob([bytes], { type: mimeType }), filename);
    log("agent_api.avatar.update.start", { agentId, filename, mimeType, size: bytes.byteLength });
    const res = await fetch(new URL(`/internal/agent/${encodeURIComponent(agentId)}/profile/avatar`, this.serverUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.machineApiKey}`,
        "X-Agent-Id": agentId,
        "X-Slock-Client": "raftbot"
      },
      body: form
    });
    if (!res.ok) {
      const detail = await safeErrorDetail(res);
      log("agent_api.avatar.update.failed", { agentId, status: res.status, detail });
      throw new Error(`avatar_update_failed: HTTP ${res.status} ${detail}`);
    }
    const profile = await res.json();
    log("agent_api.avatar.update.ok", { agentId });
    return profile;
  }

  async getAgentCredential(agentId) {
    const cached = this.agentCredentials.get(agentId);
    if (cached) {
      log("agent_api.credential.cached", { agentId });
      return cached;
    }
    log("agent_api.credential.mint.start", { agentId });
    const res = await fetch(new URL(`/internal/computer/runners/${encodeURIComponent(agentId)}/credentials`, this.serverUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.machineApiKey}`,
        "Content-Type": "application/json",
        "X-Slock-Client": "raftbot"
      },
      body: JSON.stringify({
        scopes: RUNNER_SCOPES,
        name: `raftbot:${agentId.slice(0, 8)}`
      })
    });
    if (!res.ok) {
      const detail = await safeErrorDetail(res);
      log("agent_api.credential.mint.failed", { agentId, status: res.status, detail });
      throw new Error(`runner_credential_mint_failed: HTTP ${res.status} ${detail}`);
    }
    const body = await res.json();
    if (typeof body.apiKey !== "string" || !body.apiKey.startsWith("sk_agent_")) {
      throw new Error("runner_credential_mint_failed: invalid credential payload");
    }
    const credential = {
      apiKey: body.apiKey,
      credentialId: typeof body.credentialId === "string" ? body.credentialId : null
    };
    this.agentCredentials.set(agentId, credential);
    log("agent_api.credential.mint.ok", { agentId, credentialId: credential.credentialId });
    return credential;
  }

  async getAgentProfile(agentId) {
    const res = await fetch(new URL(`/internal/agent/${encodeURIComponent(agentId)}/profile`, this.serverUrl), {
      headers: {
        Authorization: `Bearer ${this.machineApiKey}`,
        "X-Agent-Id": agentId,
        "X-Slock-Client": "raftbot"
      }
    });
    if (!res.ok) {
      const detail = await safeErrorDetail(res);
      log("agent_api.profile.failed", { agentId, status: res.status, detail });
      throw new Error(`agent_profile_failed: HTTP ${res.status} ${detail}`);
    }
    const body = await res.json();
    log("agent_api.profile.ok", { agentId, name: body.name, displayName: body.displayName });
    return {
      name: typeof body.name === "string" ? body.name : "",
      displayName: typeof body.displayName === "string" ? body.displayName : ""
    };
  }
}

async function safeErrorDetail(res) {
  const text = await res.text().catch(() => "");
  return text.slice(0, 300);
}

function normalizeAttachmentIds(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.length > 0);
}
