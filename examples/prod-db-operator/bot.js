import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createBot } from "../../src/index.js";
import { createDatabaseAdapter, describeDatabaseTarget } from "./db-adapters.js";
import { classifySql } from "./sql-utils.js";
import { createResultResponse } from "./result-renderer.js";

const REQUESTS_KEY = "prodDbOperator.requests";
const CONFIG_KEY = "prodDbOperator.config";

export function createProdDbOperatorBot(options = {}) {
  const defaults = normalizeDefaults(options);
  const adapters = new Map();

  const bot = createBot({
    modelId: "prod-db-operator",
    runtimeLabel: "Production Database Operator"
  });

  bot.onStart(async (ctx) => {
    await ensureConfig(ctx);
  });

  bot.onStop(async (ctx) => {
    await closeAdapter(ctx.agentId);
  });

  bot.command("help", async (ctx) => {
    const config = await getConfig(ctx);
    await ctx.reply([
      "Production Database Operator commands:",
      "/sql <statement> - run read-only SQL or request approval for write SQL",
      "/approve <requestId> - approve and execute a pending write request",
      "/reject <requestId> - reject a pending write request",
      "/dm <requestId> @manager [@manager...] - force DM reminder to specific managers",
      "/status <requestId> - show request status",
      "",
      "DM configuration commands:",
      "/config show",
      "/config db sqlite [path]",
      "/config db pg <databaseUrl>",
      "/config db mysql <databaseUrl>",
      "/config manager add @manager [@manager...]",
      "/config manager remove @manager [@manager...]",
      "",
      `Target: ${describeDatabaseTarget(config)}`,
      `Managers: ${config.managers.length > 0 ? config.managers.join(", ") : "not configured; write SQL cannot be approved"}`
    ].join("\n"));
  });

  bot.command("config", async (ctx) => {
    await handleConfig(ctx);
  });

  bot.command("sql", async (ctx) => {
    const sql = ctx.args.join(" ").trim();
    if (!sql) {
      await ctx.reply("Usage: /sql <statement>");
      return;
    }

    const config = await getConfig(ctx);
    const classification = classifySql(sql, { driver: config.driver });
    if (classification.statements.length === 0) {
      await ctx.reply("No SQL statement found.");
      return;
    }

    if (classification.kind === "read") {
      await runReadOnlySql(ctx, sql, classification, config);
      return;
    }

    await createApprovalRequest(ctx, sql, classification, config);
  });

  bot.command("approve", async (ctx) => {
    await decide(ctx, "approved");
  });

  bot.command("reject", async (ctx) => {
    await decide(ctx, "rejected");
  });

  bot.command("dm", async (ctx) => {
    const request = await getRequest(ctx, ctx.args[0]);
    if (!request) return;
    if (request.status !== "pending") {
      await ctx.reply(`Request ${request.id} is ${request.status}; no DM reminder sent.`);
      return;
    }
    const config = await getConfig(ctx);
    const targets = splitHandles(ctx.args.slice(1).join(","));
    if (targets.length === 0) {
      await ctx.reply(`Usage: /dm ${request.id} @manager [@manager...]`);
      return;
    }
    const invalid = targets.filter((manager) => !config.managers.includes(manager));
    if (invalid.length > 0) {
      await ctx.reply(`Not configured as manager: ${invalid.join(", ")}`);
      return;
    }
    await notifyManagers(ctx, request, config, { forceDm: true, dmManagers: targets });
    await ctx.reply(`DM reminder sent to ${targets.join(", ")} for ${request.id}.`);
  });

  bot.command("status", async (ctx) => {
    const request = await getRequest(ctx, ctx.args[0]);
    if (!request) return;
    await ctx.reply(formatRequestStatus(request));
  });

  return bot;

  async function handleConfig(ctx) {
    if (ctx.event.surface.kind !== "dm") {
      await ctx.reply("Configuration changes must be made in DM with this bot.");
      return;
    }
    const config = await getConfig(ctx);
    if (!canManage(ctx.event.sender, config)) {
      await ctx.reply(`${ctx.event.sender} is not allowed to configure this bot.`);
      return;
    }

    const [section, action, ...rest] = ctx.args;
    if (!section || section === "show") {
      await ctx.reply(formatConfig(config));
      return;
    }
    if (section === "db") {
      await configureDb(ctx, action, rest);
      return;
    }
    if (section === "manager") {
      await configureManagers(ctx, action, rest);
      return;
    }
    await ctx.reply("Usage: /config show | /config db <sqlite|pg|mysql> ... | /config manager <add|remove> @manager...");
  }

  async function configureDb(ctx, driver, args) {
    const normalizedDriver = normalizeDriver(driver);
    if (!normalizedDriver) {
      await ctx.reply("Usage: /config db sqlite [path] | /config db pg <databaseUrl> | /config db mysql <databaseUrl>");
      return;
    }
    if (normalizedDriver !== "sqlite" && args.length === 0) {
      await ctx.reply(`Usage: /config db ${normalizedDriver} <databaseUrl>`);
      return;
    }
    const current = await getConfig(ctx);
    const next = {
      ...current,
      driver: normalizedDriver,
      databaseUrl: normalizedDriver === "sqlite" ? "" : args.join(" ").trim(),
      sqlitePath: normalizedDriver === "sqlite" ? args.join(" ").trim() : ""
    };
    await ctx.state.set(CONFIG_KEY, next);
    await closeAdapter(ctx.agentId);
    await writeAudit(ctx, { type: "config_db_updated", actor: ctx.event.sender, config: redactConfig(next) });
    await ctx.reply(`Database target updated: ${describeDatabaseTarget(next)}`);
  }

  async function configureManagers(ctx, action, args) {
    if (action !== "add" && action !== "remove") {
      await ctx.reply("Usage: /config manager add @manager... | /config manager remove @manager...");
      return;
    }
    const handles = splitHandles(args.join(","));
    if (handles.length === 0) {
      await ctx.reply("Provide at least one manager handle.");
      return;
    }
    const current = await getConfig(ctx);
    const managers = new Set(current.managers);
    for (const handle of handles) {
      if (action === "add") managers.add(handle);
      else managers.delete(handle);
    }
    const next = { ...current, managers: [...managers].sort() };
    await ctx.state.set(CONFIG_KEY, next);
    await writeAudit(ctx, { type: "config_managers_updated", actor: ctx.event.sender, action, handles, managers: next.managers });
    await ctx.reply(`Managers: ${next.managers.length > 0 ? next.managers.join(", ") : "none"}`);
  }

  async function runReadOnlySql(ctx, sql, classification, config) {
    const startedAt = new Date().toISOString();
    try {
      const adapter = await getAdapter(ctx, config);
      const result = await adapter.query(classification.statements, { maxRows: config.maxRows + 1 });
      const response = createResultResponse(result.results, {
        baseName: `query-${Date.now().toString(36)}`,
        inlineRows: config.inlineRows,
        pageRows: config.pageRows,
        maxRows: config.maxRows
      });
      await writeAudit(ctx, {
        type: "read_query",
        requester: ctx.event.sender,
        target: redactConfig(config),
        sql,
        statementCount: classification.statements.length,
        startedAt,
        completedAt: new Date().toISOString(),
        rowCount: result.results.reduce((sum, item) => sum + item.rows.length, 0),
        truncated: response.truncated
      });
      await ctx.reply(response.message);
    } catch (err) {
      await writeAudit(ctx, {
        type: "read_query_failed",
        requester: ctx.event.sender,
        target: redactConfig(config),
        sql,
        statementCount: classification.statements.length,
        startedAt,
        failedAt: new Date().toISOString(),
        error: errorMessage(err)
      });
      await ctx.reply(formatSqlError("Read-only query failed", err, config));
    }
  }

  async function createApprovalRequest(ctx, sql, classification, config) {
    if (config.managers.length === 0) {
      await ctx.reply("Write SQL requires manager approval, but no managers are configured for this bot instance.");
      await writeAudit(ctx, {
        type: "approval_unavailable",
        requester: ctx.event.sender,
        target: redactConfig(config),
        sql,
        statementCount: classification.statements.length,
        risks: classification.risks,
        parseError: classification.parseError
      });
      return;
    }
    const request = {
      id: createRequestId(),
      sql,
      statements: classification.statements,
      requester: ctx.event.sender,
      status: "pending",
      risks: classification.risks,
      parseError: classification.parseError,
      target: ctx.event.replyTarget,
      db: redactConfig(config),
      createdAt: new Date().toISOString()
    };
    await saveRequest(ctx, request);
    await writeAudit(ctx, { type: "approval_requested", request });
    await notifyManagers(ctx, request, config);
  }

  async function decide(ctx, decision) {
    const request = await getRequest(ctx, ctx.args[0]);
    if (!request) return;
    const config = await getConfig(ctx);
    if (request.status !== "pending") {
      await ctx.reply(`Request ${request.id} is already ${request.status}.`);
      return;
    }
    if (!canManage(ctx.event.sender, config)) {
      await ctx.reply(`${ctx.event.sender} is not allowed to decide SQL request ${request.id}.`);
      return;
    }
    if (ctx.event.sender === request.requester) {
      await ctx.reply("Requester cannot approve or reject their own SQL request.");
      return;
    }

    if (decision === "rejected") {
      request.status = "rejected";
      request.decidedBy = ctx.event.sender;
      request.decidedAt = new Date().toISOString();
      await saveRequest(ctx, request);
      await writeAudit(ctx, { type: "approval_rejected", request });
      await ctx.reply(`SQL request ${request.id} rejected by ${ctx.event.sender}.`);
      return;
    }

    await executeApprovedWrite(ctx, request, config);
  }

  async function executeApprovedWrite(ctx, request, config) {
    request.status = "executing";
    request.decidedBy = ctx.event.sender;
    request.decidedAt = new Date().toISOString();
    await saveRequest(ctx, request);
    await writeAudit(ctx, { type: "approval_approved", request });

    try {
      const adapter = await getAdapter(ctx, config);
      const execution = await adapter.executeTransaction(request.statements);
      request.status = "executed";
      request.executedAt = new Date().toISOString();
      request.execution = execution;
      await saveRequest(ctx, request);
      await writeAudit(ctx, { type: "write_executed", request });
      await ctx.reply([
        `SQL request ${request.id} approved by ${ctx.event.sender} and committed.`,
        `Statements: ${request.statements.length}`,
        `Affected rows: ${execution.affectedRows}`
      ].join("\n"));
    } catch (err) {
      request.status = "rolled_back_due_to_error";
      request.error = err instanceof Error ? err.message : String(err);
      request.failedAt = new Date().toISOString();
      await saveRequest(ctx, request);
      await writeAudit(ctx, { type: "write_rolled_back", request });
      await ctx.reply([
        `SQL request ${request.id} failed and was rolled back.`,
        "",
        formatSqlError("Write transaction failed", err, config, { transactionRolledBack: true })
      ].join("\n"));
    }
  }

  async function notifyManagers(ctx, request, config, options = {}) {
    const managerLine = config.managers.length > 0 ? config.managers.join(" ") : "Managers";
    const message = [
      `${managerLine} SQL approval required.`,
      "",
      formatApprovalSummary(request),
      "",
      `Approve: /approve ${request.id}`,
      `Reject: /reject ${request.id}`,
      `Force DM reminder: /dm ${request.id} @manager [@manager...]`
    ].join("\n");
    if (!options.forceDm) await ctx.reply(message);
    if (options.forceDm) {
      const managers = options.dmManagers ?? [];
      await Promise.all(managers.map((manager) => ctx.send(`dm:${manager}`, [
        "SQL approval reminder.",
        "",
        formatApprovalSummary(request),
        "",
        `Original thread: ${request.target}`,
        `Approve in the original thread with: /approve ${request.id}`
      ].join("\n"))));
    }
  }

  async function getAdapter(ctx, config) {
    const key = adapterKey(config);
    const existing = adapters.get(ctx.agentId);
    if (existing?.key === key) return existing.adapter;
    await existing?.adapter?.close?.();
    const adapter = await createDatabaseAdapter(resolveTargetConfig(ctx, config));
    adapters.set(ctx.agentId, { key, adapter });
    return adapter;
  }

  async function closeAdapter(agentId) {
    const existing = adapters.get(agentId);
    adapters.delete(agentId);
    await existing?.adapter?.close?.();
  }

  async function ensureConfig(ctx) {
    const existing = await ctx.state.get(CONFIG_KEY, null);
    if (existing) return existing;
    const creator = handleFromProfile(ctx.agent.creator);
    const managers = defaults.managers.length > 0 ? defaults.managers : creator ? [creator] : [];
    const initial = { ...defaults, managers };
    await ctx.state.set(CONFIG_KEY, initial);
    await writeAudit(ctx, { type: "config_initialized", config: redactConfig(initial), creator });
    return initial;
  }

  async function getConfig(ctx) {
    const stored = await ensureConfig(ctx);
    return resolveTargetConfig(ctx, { ...defaults, ...stored, managers: splitHandles(stored.managers ?? defaults.managers) });
  }

  async function getRequest(ctx, id) {
    if (!id) {
      await ctx.reply("Usage: command requires <requestId>");
      return null;
    }
    const requests = await loadRequests(ctx);
    const request = requests[id];
    if (!request) {
      await ctx.reply(`Unknown SQL request: ${id}`);
      return null;
    }
    return request;
  }

  async function saveRequest(ctx, request) {
    const requests = await loadRequests(ctx);
    requests[request.id] = request;
    await ctx.state.set(REQUESTS_KEY, requests);
  }

  async function loadRequests(ctx) {
    return ctx.state.get(REQUESTS_KEY, {});
  }

  function canManage(sender, config) {
    return config.managers.includes(sender);
  }

  async function writeAudit(ctx, entry) {
    const auditPath = defaults.auditLog || path.join(ctx.workspace.path, "prod-db-operator-audit.jsonl");
    await mkdir(path.dirname(auditPath), { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ ...entry, recordedAt: new Date().toISOString() })}\n`);
  }
}

function normalizeDefaults(options) {
  return {
    driver: normalizeDriver(options.dbDriver || options.driver || process.env.PROD_DB_DRIVER) ?? "sqlite",
    databaseUrl: options.databaseUrl || options.dbUrl || process.env.DATABASE_URL || "",
    sqlitePath: options.sqlitePath || process.env.PROD_DB_SQLITE_PATH || "",
    managers: splitHandles(options.managers || process.env.PROD_DB_MANAGERS || ""),
    auditLog: options.auditLog || process.env.PROD_DB_AUDIT_LOG || "",
    inlineRows: parsePositiveInt(options.inlineRows, 20),
    pageRows: parsePositiveInt(options.pageRows, 500),
    maxRows: parsePositiveInt(options.maxRows, 2_000)
  };
}

function resolveTargetConfig(ctx, config) {
  const sqlitePath = config.driver === "sqlite" ? config.sqlitePath || path.join(ctx.workspace.path, "prod-db-operator.sqlite") : "";
  return { ...config, sqlitePath };
}

function normalizeDriver(value) {
  const driver = String(value ?? "").trim().toLowerCase();
  if (driver === "postgres" || driver === "postgresql") return "pg";
  if (driver === "mysql2") return "mysql";
  if (driver === "pg" || driver === "mysql" || driver === "sqlite") return driver;
  return null;
}

function splitHandles(value = "") {
  const items = Array.isArray(value) ? value : String(value).split(/[,\s]+/);
  return [...new Set(items.map((item) => item.trim()).filter(Boolean).map((item) => item.startsWith("@") ? item : `@${item}`))].sort();
}

function parsePositiveInt(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function createRequestId() {
  return `sql_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function handleFromProfile(profile) {
  return profile?.name ? `@${profile.name}` : null;
}

function adapterKey(config) {
  return JSON.stringify({
    driver: config.driver,
    databaseUrl: config.databaseUrl,
    sqlitePath: config.sqlitePath
  });
}

function redactConfig(config) {
  return {
    driver: config.driver,
    databaseUrl: config.databaseUrl ? redactUrl(config.databaseUrl) : "",
    sqlitePath: config.sqlitePath,
    managers: config.managers,
    inlineRows: config.inlineRows,
    pageRows: config.pageRows,
    maxRows: config.maxRows
  };
}

function redactUrl(value) {
  return String(value).replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:***@");
}

function formatConfig(config) {
  const redacted = redactConfig(config);
  return [
    "Production Database Operator configuration:",
    `Driver: ${redacted.driver}`,
    `Database URL: ${redacted.databaseUrl || "(none)"}`,
    `SQLite path: ${redacted.sqlitePath || "(workspace default)"}`,
    `Managers: ${redacted.managers.length > 0 ? redacted.managers.join(", ") : "none"}`,
    `Inline rows: ${redacted.inlineRows}`,
    `Page rows: ${redacted.pageRows}`,
    `Max rows: ${redacted.maxRows}`
  ].join("\n");
}

function formatApprovalSummary(request) {
  return [
    `Request ID: ${request.id}`,
    `Requester: ${request.requester}`,
    `Database: ${request.db ? describeRedactedTarget(request.db) : "current target"}`,
    `Statements: ${request.statements.length}`,
    `Risks: ${request.risks.length > 0 ? request.risks.join(", ") : "none detected"}`,
    request.parseError ? `Parse note: SQL parser could not prove this request is read-only, so approval is required.` : null,
    "",
    "SQL:",
    "```sql",
    request.sql,
    "```"
  ].filter(Boolean).join("\n");
}

function describeRedactedTarget(config) {
  if (config.driver === "sqlite") return `sqlite:${config.sqlitePath || "(workspace default)"}`;
  return `${config.driver}:${config.databaseUrl || "(no url)"}`;
}

function formatRequestStatus(request) {
  return [
    `Request ID: ${request.id}`,
    `Status: ${request.status}`,
    `Requester: ${request.requester}`,
    `Created: ${request.createdAt}`,
    request.db ? `Database: ${describeRedactedTarget(request.db)}` : null,
    request.decidedBy ? `Decided by: ${request.decidedBy}` : null,
    request.executedAt ? `Executed: ${request.executedAt}` : null,
    request.error ? `Error: ${request.error}` : null
  ].filter(Boolean).join("\n");
}

function formatSqlError(title, err, config, options = {}) {
  const lines = [
    title,
    `Database: ${describeRedactedTarget(redactConfig(config))}`,
    `Error: ${errorMessage(err)}`
  ];
  if (options.transactionRolledBack) {
    lines.push("", "No changes were committed for this failed write transaction.");
  }
  return lines.join("\n");
}

function errorMessage(err) {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim().slice(0, 1_000) || "Unknown database error";
}
