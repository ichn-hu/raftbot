import assert from "node:assert/strict";
import test from "node:test";
import { AgentApiClient } from "./agent-api.js";

test("attachment flow uses runner agent-api endpoints and send attachmentIds", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/internal/computer/runners/agent-123/credentials")) {
      return jsonResponse({
        apiKey: "sk_agent_test",
        credentialId: "cred-123"
      });
    }
    if (url.endsWith("/internal/agent-api/resolve-channel")) {
      assert.equal(init.headers.Authorization, "Bearer sk_agent_test");
      assert.equal(init.headers["X-Agent-Id"], "agent-123");
      assert.deepEqual(JSON.parse(init.body), { target: "#raftbot-devs:abcd1234" });
      return jsonResponse({ channelId: "channel-123" });
    }
    if (url.endsWith("/internal/agent-api/upload")) {
      assert.equal(init.headers.Authorization, "Bearer sk_agent_test");
      assert.equal(init.headers["X-Agent-Id"], "agent-123");
      assert.ok(init.body instanceof FormData);
      return jsonResponse({
        id: "attachment-123",
        filename: "board.html",
        sizeBytes: 42
      });
    }
    if (url.endsWith("/internal/agent-api/send")) {
      assert.equal(init.headers.Authorization, "Bearer sk_agent_test");
      assert.equal(init.headers["X-Agent-Id"], "agent-123");
      assert.deepEqual(JSON.parse(init.body), {
        target: "#raftbot-devs:abcd1234",
        content: "Board snapshot attached.",
        draftReholdCount: 0,
        attachmentIds: ["attachment-123"],
        seenUpToSeq: 10
      });
      return jsonResponse({ messageId: "message-123" });
    }

    throw new Error(`unexpected fetch url: ${url}`);
  };

  try {
    const client = new AgentApiClient({
      serverUrl: "https://api.slock.test",
      apiKey: "sk_machine_test"
    });
    const attachment = await client.uploadAttachment("agent-123", "#raftbot-devs:abcd1234", {
      filename: "board.html",
      mimeType: "text/html",
      bytes: new TextEncoder().encode("<html></html>")
    });

    assert.equal(attachment.id, "attachment-123");
    await client.sendMessage("agent-123", "#raftbot-devs:abcd1234", "Board snapshot attached.", {
      attachmentIds: [attachment.id],
      seenUpToSeq: 10
    });
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
      "/internal/computer/runners/agent-123/credentials",
      "/internal/agent-api/resolve-channel",
      "/internal/agent-api/upload",
      "/internal/agent-api/send"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
