import assert from "node:assert/strict";
import test from "node:test";
import {
  createStartWakeDelivery,
  formatUnrecognizedDmFallback,
  normalizeMessageEvent,
  parseSlashCommand,
  shouldSendDmUnrecognizedFallback
} from "./runtime.js";
import { readyMessage } from "./daemon-connection.js";

test("DM messages are addressed slash commands without a bot mention", () => {
  const event = normalizeMessageEvent({
    message: {
      message_id: "msg-1",
      channel_type: "dm",
      channel_name: "ichnhu",
      sender_name: "ichnhu",
      content: "/config show"
    }
  });

  assert.equal(event.surface.kind, "dm");
  assert.equal(event.addressed, true);
  assert.equal(event.commandText, "/config show");
  assert.deepEqual(parseSlashCommand(event.commandText), { name: "config", args: ["show"] });
});

test("DM surface can be inferred from target or direct-message channel type", () => {
  for (const channelType of ["direct", "direct_message", ""]) {
    const event = normalizeMessageEvent({
      message: {
        message_id: "msg-1",
        target: "dm:@ichnhu",
        channel_type: channelType,
        channel_name: "ichnhu",
        sender_name: "ichnhu",
        content: "/sql select 1"
      }
    });

    assert.equal(event.surface.kind, "dm");
    assert.equal(event.addressed, true);
    assert.deepEqual(parseSlashCommand(event.commandText), { name: "sql", args: ["select", "1"] });
  }
});

test("DM unrecognized messages fall back to help", () => {
  const dmEvent = normalizeMessageEvent({
    message: {
      message_id: "msg-1",
      channel_type: "dm",
      channel_name: "ichnhu",
      sender_name: "ichnhu",
      content: "hello"
    }
  });

  assert.equal(shouldSendDmUnrecognizedFallback(dmEvent, null, null), true);
  assert.equal(
    shouldSendDmUnrecognizedFallback(dmEvent, { name: "wat", args: [] }, null),
    true
  );
  assert.equal(
    shouldSendDmUnrecognizedFallback(dmEvent, { name: "help", args: [] }, () => {}),
    false
  );
  assert.equal(shouldSendDmUnrecognizedFallback(dmEvent, null, null, true), false);
  assert.match(formatUnrecognizedDmFallback({ hasHelp: true }), /Showing \/help/);
});

test("channel messages do not get DM unrecognized fallback", () => {
  const channelEvent = normalizeMessageEvent({
    message: {
      message_id: "msg-1",
      channel_type: "channel",
      channel_name: "raftbot-devs",
      sender_name: "ichnhu",
      content: "/wat"
    }
  });

  assert.equal(
    shouldSendDmUnrecognizedFallback(channelEvent, { name: "wat", args: [] }, null),
    false
  );
});

test("ready message reports currently running agents", () => {
  const ready = readyMessage({
    runtimes: ["claude", "codex"],
    runningAgents: ["agent-a", "agent-b"]
  });

  assert.deepEqual(ready.runtimes, ["claude", "codex"]);
  assert.deepEqual(ready.runningAgents, ["agent-a", "agent-b"]);
});

test("agent start wake messages normalize to local delivery without requiring ack", () => {
  const delivery = createStartWakeDelivery({
    agentId: "agent-a",
    launchId: "launch-1",
    wakeMessageTransient: true,
    wakeMessage: {
      message_id: "msg-1",
      seq: 123,
      channel_type: "dm",
      channel_name: "ichnhu",
      sender_name: "ichnhu",
      content: "/help"
    }
  });

  assert.equal(delivery.type, "agent:deliver");
  assert.equal(delivery.agentId, "agent-a");
  assert.equal(delivery.launchId, "launch-1");
  assert.equal(delivery.seq, 123);
  assert.equal(delivery.transient, true);
  assert.equal(delivery.message.message_id, "msg-1");
});
