import { appendFileSync } from "node:fs";
import { createBot } from "../../src/index.js";

export function createProdDbOperatorBot(options = {}) {
  const allowlist = new Set(split(options.sqlAllowlist));
  const managers = new Set(split(options.managers));
  const auditLog = options.auditLog ?? "./prod-db-operator-audit.jsonl";
  const approvals = new Map();

  const bot = createBot({
    modelId: "prod-db-operator",
    runtimeLabel: "Production Database Operator"
  });

  bot.command("help", async (ctx) => {
    await ctx.reply([
      "Production Database Operator commands:",
      "/sql <statement>",
      "/approve <requestId>",
      "/reject <requestId>"
    ].join("\n"));
  });

  bot.command("sql", async (ctx) => {
    const sql = ctx.args.join(" ").trim();
    if (!sql) {
      await ctx.reply("Usage: /sql <statement>");
      return;
    }

    if (allowlist.has(ctx.event.sender)) {
      const request = createRequest(ctx, sql, "approved", ctx.event.sender);
      executeSql(request);
      await ctx.reply(`SQL request ${request.id} executed in demo mode.`);
      return;
    }

    const request = createRequest(ctx, sql, "pending", null);
    approvals.set(request.id, request);
    writeAudit({ type: "approval_requested", request });
    await ctx.reply([
      "Production SQL approval required.",
      `Request ID: ${request.id}`,
      `Requester: ${request.requester}`,
      `SQL: ${request.sql}`,
      "",
      `Manager: /approve ${request.id} or /reject ${request.id}`
    ].join("\n"));
  });

  bot.command("approve", async (ctx) => {
    await decide(ctx, "approved");
  });

  bot.command("reject", async (ctx) => {
    await decide(ctx, "rejected");
  });

  return bot;

  function createRequest(ctx, sql, status, decidedBy) {
    const request = {
      id: `sql_${Date.now().toString(36)}`,
      requester: ctx.event.sender,
      sql,
      status,
      decidedBy,
      createdAt: new Date().toISOString()
    };
    writeAudit({ type: "request_created", request });
    return request;
  }

  async function decide(ctx, status) {
    if (managers.size > 0 && !managers.has(ctx.event.sender)) {
      await ctx.reply(`${ctx.event.sender} is not allowed to decide SQL requests.`);
      return;
    }
    const id = ctx.args[0];
    const request = approvals.get(id);
    if (!request) {
      await ctx.reply(`Unknown SQL request: ${id ?? "(missing id)"}`);
      return;
    }
    if (request.status !== "pending") {
      await ctx.reply(`SQL request ${id} is already ${request.status}.`);
      return;
    }
    request.status = status;
    request.decidedBy = ctx.event.sender;
    request.decidedAt = new Date().toISOString();
    writeAudit({ type: "request_decided", request });
    if (status === "approved") executeSql(request);
    await ctx.reply(`SQL request ${id} ${status} by ${ctx.event.sender}.`);
  }

  function executeSql(request) {
    writeAudit({
      type: "sql_execute_demo",
      requestId: request.id,
      sql: request.sql,
      executedAt: new Date().toISOString()
    });
  }

  function writeAudit(entry) {
    appendFileSync(auditLog, `${JSON.stringify(entry)}\n`);
  }
}

function split(value = "") {
  return typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}
