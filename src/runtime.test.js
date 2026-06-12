import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMessageEvent, parseSlashCommand } from "./runtime.js";

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
