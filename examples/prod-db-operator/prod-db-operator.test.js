import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProdDbOperatorBot, formatSqlParseError, resolveTargetConfig, snapshotExecutionTarget } from "./bot.js";
import { createDatabaseAdapter, readStatementForExecution } from "./db-adapters.js";
import { createResultResponse } from "./result-renderer.js";
import { classifySql } from "./sql-utils.js";

test("classifies read-only and write SQL", () => {
  assert.equal(classifySql("select 1", { driver: "pg" }).kind, "read");
  assert.equal(classifySql("select * into new_table from users", { driver: "pg" }).kind, "write");
  assert.equal(classifySql("with changed as (update users set name = 'a' returning *) select * from changed", { driver: "pg" }).kind, "write");
  assert.equal(classifySql("select * from users for update", { driver: "pg" }).kind, "write");
  assert.deepEqual(classifySql("delete from users", { driver: "mysql" }).risks, ["delete_without_where"]);
});

test("records parser failures so command handling can return a parse error", () => {
  const classification = classifySql("select", { driver: "sqlite" });
  assert.equal(classification.kind, "write");
  assert.deepEqual(classification.risks, ["parse_error"]);
  assert.ok(classification.parseError);

  const message = formatSqlParseError(classification, {
    driver: "sqlite",
    sqlitePath: "/tmp/app.sqlite",
    databaseUrl: ""
  });
  assert.match(message, /SQL parse error/);
  assert.match(message, /not sent for approval/);
  assert.match(message, /sqlite:\/tmp\/app\.sqlite/);
});

test("/sql parse errors return an error instead of opening approval", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raftbot-prod-db-test-"));
  try {
    const bot = createProdDbOperatorBot();
    const handler = getCommandHandler(bot, "sql");
    const stateValues = new Map();
    const replies = [];
    const ctx = {
      args: ["select"],
      agentId: "agent-1",
      agent: { creator: { name: "ichnhu" } },
      workspace: { path: dir },
      event: {
        sender: "@ichnhu",
        replyTarget: "#raftbot-devs:ffe898da",
        surface: { kind: "thread" }
      },
      state: {
        async get(key, fallback) {
          return stateValues.has(key) ? stateValues.get(key) : fallback;
        },
        async set(key, value) {
          stateValues.set(key, value);
        }
      },
      async reply(message) {
        replies.push(message);
      }
    };

    await handler(ctx);

    assert.equal(replies.length, 1);
    assert.match(replies[0], /SQL parse error/);
    assert.match(replies[0], /not sent for approval/);
    assert.equal(stateValues.has("prodDbOperator.requests"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("DM-origin write requests DM managers and approval notifies original context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raftbot-prod-db-test-"));
  try {
    const bot = createProdDbOperatorBot({
      managers: "@manager",
      auditLog: path.join(dir, "audit.jsonl")
    });
    const stateValues = new Map();
    const requesterReplies = [];
    const requesterSends = [];
    const requesterCtx = createCommandContext({
      args: [
        "create table approvals (id integer primary key, name text);",
        "insert into approvals (name) values ('ok')"
      ],
      dir,
      stateValues,
      sender: "@requester",
      replyTarget: "dm:@requester:req1",
      surfaceKind: "dm",
      replies: requesterReplies,
      sends: requesterSends
    });

    await getCommandHandler(bot, "sql")(requesterCtx);

    assert.equal(requesterReplies.length, 1);
    assert.match(requesterReplies[0], /Managers notified by DM: @manager/);
    assert.equal(requesterSends.length, 1);
    assert.equal(requesterSends[0].target, "dm:@manager");
    assert.match(requesterSends[0].message, /Approve: \/approve sql_/);

    const requestId = Object.keys(stateValues.get("prodDbOperator.requests"))[0];
    const request = stateValues.get("prodDbOperator.requests")[requestId];
    assert.equal(request.target, "dm:@requester:req1");
    assert.equal(request.requesterSurface, "dm");

    const managerReplies = [];
    const managerSends = [];
    const managerCtx = createCommandContext({
      args: [requestId],
      dir,
      stateValues,
      sender: "@manager",
      replyTarget: "dm:@manager:approval",
      surfaceKind: "dm",
      replies: managerReplies,
      sends: managerSends
    });

    await getCommandHandler(bot, "approve")(managerCtx);

    assert.equal(managerReplies.length, 1);
    assert.match(managerReplies[0], /approved by @manager and committed/);
    assert.match(managerReplies[0], /Statements: 2/);
    assert.match(managerReplies[0], /Affected rows: 1/);
    assert.deepEqual(managerSends, [{
      target: "dm:@requester:req1",
      message: managerReplies[0]
    }]);
    assert.equal(stateValues.get("prodDbOperator.requests")[requestId].status, "executed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("thread-origin write requests keep manager approval in the original context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raftbot-prod-db-test-"));
  try {
    const bot = createProdDbOperatorBot({
      managers: "@manager",
      auditLog: path.join(dir, "audit.jsonl")
    });
    const stateValues = new Map();
    const replies = [];
    const sends = [];
    const ctx = createCommandContext({
      args: ["create table thread_approvals (id integer primary key)"],
      dir,
      stateValues,
      sender: "@requester",
      replyTarget: "#raftbot-devs:req1",
      surfaceKind: "thread",
      replies,
      sends
    });

    await getCommandHandler(bot, "sql")(ctx);

    assert.equal(replies.length, 1);
    assert.match(replies[0], /@manager SQL approval required/);
    assert.match(replies[0], /Force DM reminder/);
    assert.deepEqual(sends, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite adapter commits successful transaction and rolls back failed one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raftbot-prod-db-test-"));
  try {
    const adapter = await createDatabaseAdapter({ driver: "sqlite", sqlitePath: path.join(dir, "test.sqlite") });
    await adapter.executeTransaction([
      "create table users (id integer primary key, name text)",
      "insert into users (name) values ('Ada')"
    ]);
    await assert.rejects(() => adapter.executeTransaction([
      "insert into users (name) values ('Grace')",
      "insert into missing_table (name) values ('fail')"
    ]));
    const result = await adapter.query(["select name from users order by id"], { maxRows: 10 });
    assert.deepEqual(result.results[0].rows, [{ name: "Ada" }]);
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sqlite adapter enforces read row cap and reports truncation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raftbot-prod-db-test-"));
  try {
    const adapter = await createDatabaseAdapter({ driver: "sqlite", sqlitePath: path.join(dir, "test.sqlite") });
    await adapter.executeTransaction([
      "create table users (id integer primary key, name text)",
      "insert into users (name) values ('Ada'), ('Grace'), ('Linus'), ('Margaret')"
    ]);
    const result = await adapter.query(["select id, name from users order by id"], { maxRows: 2 });
    assert.equal(result.results[0].rows.length, 2);
    assert.deepEqual(result.results[0].rows.map((row) => row.name), ["Ada", "Grace"]);
    assert.equal(result.results[0].totalRows, 3);
    assert.equal(result.results[0].truncated, true);
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default sqlite adapter seeds demo data once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raftbot-prod-db-test-"));
  try {
    const sqlitePath = path.join(dir, "default.sqlite");
    const adapter = await createDatabaseAdapter({ driver: "sqlite", sqlitePath, seedDefaultData: true });
    const result = await adapter.query([
      "select name, plan from raftbot_demo_customers order by id"
    ], { maxRows: 10 });
    assert.deepEqual(result.results[0].rows, [
      { name: "Ada Lovelace", plan: "pro" },
      { name: "Grace Hopper", plan: "enterprise" },
      { name: "Katherine Johnson", plan: "starter" },
      { name: "Margaret Hamilton", plan: "pro" }
    ]);
    await adapter.close();

    const reopened = await createDatabaseAdapter({ driver: "sqlite", sqlitePath, seedDefaultData: true });
    const count = await reopened.query(["select count(*) as count from raftbot_demo_customers"], { maxRows: 10 });
    assert.deepEqual(count.results[0].rows, [{ count: 4 }]);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default sqlite seed marker survives real config resolution path", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raftbot-prod-db-test-"));
  try {
    const ctx = { workspace: { path: dir } };
    const storedConfig = { driver: "sqlite", sqlitePath: "", databaseUrl: "" };
    const resolvedFromGetConfig = resolveTargetConfig(ctx, storedConfig);
    assert.equal(resolvedFromGetConfig.seedDefaultData, true);
    assert.equal(resolvedFromGetConfig.sqlitePath, path.join(dir, "prod-db-operator.sqlite"));

    const resolvedFromGetAdapter = resolveTargetConfig(ctx, resolvedFromGetConfig);
    assert.equal(resolvedFromGetAdapter.seedDefaultData, true);
    assert.equal(resolvedFromGetAdapter.sqlitePath, path.join(dir, "prod-db-operator.sqlite"));

    const adapter = await createDatabaseAdapter(resolvedFromGetAdapter);
    const result = await adapter.query(["select count(*) as count from raftbot_demo_customers"], { maxRows: 10 });
    assert.deepEqual(result.results[0].rows, [{ count: 4 }]);
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit sqlite adapter does not seed demo data", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "raftbot-prod-db-test-"));
  try {
    const adapter = await createDatabaseAdapter({ driver: "sqlite", sqlitePath: path.join(dir, "explicit.sqlite") });
    await assert.rejects(
      () => adapter.query(["select count(*) as count from raftbot_demo_customers"], { maxRows: 10 }),
      /no such table/
    );
    await adapter.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read cap only wraps subquery-safe select statements", () => {
  assert.equal(
    readStatementForExecution("select * from users;", 10),
    "SELECT * FROM (select * from users) AS raftbot_read_cap LIMIT 11"
  );
  assert.equal(
    readStatementForExecution("/* leading */ with users_cte as (select * from users) select * from users_cte", 5),
    "SELECT * FROM (/* leading */ with users_cte as (select * from users) select * from users_cte) AS raftbot_read_cap LIMIT 6"
  );
  assert.equal(readStatementForExecution("show tables", 10), "show tables");
  assert.equal(readStatementForExecution("describe users", 10), "describe users");
  assert.equal(readStatementForExecution("explain select * from users", 10), "explain select * from users");
});

test("approval requests snapshot immutable execution target fields", () => {
  const config = {
    driver: "pg",
    databaseUrl: "postgres://app:secret@old.example/db",
    sqlitePath: "/tmp/old.sqlite",
    managers: ["@manager"],
    maxRows: 100
  };
  const snapshot = snapshotExecutionTarget(config);
  config.driver = "mysql";
  config.databaseUrl = "mysql://app:secret@new.example/db";
  config.sqlitePath = "/tmp/new.sqlite";

  assert.deepEqual(snapshot, {
    driver: "pg",
    databaseUrl: "postgres://app:secret@old.example/db",
    sqlitePath: "/tmp/old.sqlite",
    seedDefaultData: false
  });
});

test("approval target snapshot preserves default sqlite seed marker", () => {
  const dir = path.join(os.tmpdir(), "raftbot-prod-db-default");
  const ctx = { workspace: { path: dir } };
  const config = resolveTargetConfig(ctx, { driver: "sqlite", sqlitePath: "", databaseUrl: "" });
  const snapshot = snapshotExecutionTarget(config);

  assert.deepEqual(snapshot, {
    driver: "sqlite",
    databaseUrl: "",
    sqlitePath: path.join(dir, "prod-db-operator.sqlite"),
    seedDefaultData: true
  });
});

test("result renderer uses inline markdown for small results and attachments for larger results", () => {
  const small = createResultResponse([
    { statement: "select 1", rows: [{ id: 1, name: "Ada" }], totalRows: 1, truncated: false }
  ], { inlineRows: 2 });
  assert.match(small.message.text, /\| id \| name \|/);
  assert.equal(small.message.attachments.length, 0);

  const large = createResultResponse([
    {
      statement: "select * from users",
      rows: Array.from({ length: 3 }, (_, i) => ({ id: i + 1 })),
      totalRows: 3,
      truncated: false
    }
  ], { inlineRows: 1, pageRows: 2, maxRows: 10, baseName: "users" });
  assert.equal(large.message.attachments.length, 4);
  assert.deepEqual(large.message.attachments.map((item) => item.mimeType), ["text/csv", "text/html", "text/csv", "text/html"]);
});

function getCommandHandler(bot, name) {
  for (const symbol of Object.getOwnPropertySymbols(bot)) {
    const definition = bot[symbol];
    if (definition?.commands instanceof Map) {
      const handler = definition.commands.get(name);
      if (handler) return handler;
    }
  }
  throw new Error(`Command not found: ${name}`);
}

function createCommandContext(options) {
  const replies = options.replies ?? [];
  const sends = options.sends ?? [];
  return {
    args: options.args,
    agentId: "agent-1",
    agent: { creator: { name: "creator" } },
    workspace: { path: options.dir },
    event: {
      sender: options.sender,
      replyTarget: options.replyTarget,
      surface: { kind: options.surfaceKind }
    },
    state: {
      async get(key, fallback) {
        return options.stateValues.has(key) ? options.stateValues.get(key) : fallback;
      },
      async set(key, value) {
        options.stateValues.set(key, value);
      }
    },
    async reply(message) {
      replies.push(message);
    },
    async send(target, message) {
      sends.push({ target, message });
    }
  };
}
