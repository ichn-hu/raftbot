const RUNNER_SCOPES = ["send", "read", "mentions", "tasks", "reactions", "server", "channels", "knowledge"];

export class AgentApiClient {
  constructor(options) {
    this.serverUrl = options.serverUrl;
    this.machineApiKey = options.apiKey;
    this.agentCredentials = new Map();
  }

  async sendMessage(agentId, target, content) {
    const credential = await this.getAgentCredential(agentId);
    const res = await fetch(new URL("/internal/agent-api/send", this.serverUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        "Content-Type": "application/json",
        "X-Agent-Id": agentId,
        "X-Slock-Client": "raftbot"
      },
      body: JSON.stringify({
        target,
        content,
        draftReholdCount: 0
      })
    });
    if (!res.ok) {
      const detail = await safeErrorDetail(res);
      throw new Error(`send_message_failed: HTTP ${res.status} ${detail}`);
    }
    return res.json().catch(() => ({}));
  }

  async getAgentCredential(agentId) {
    const cached = this.agentCredentials.get(agentId);
    if (cached) return cached;
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
    return credential;
  }
}

async function safeErrorDetail(res) {
  const text = await res.text().catch(() => "");
  return text.slice(0, 300);
}
