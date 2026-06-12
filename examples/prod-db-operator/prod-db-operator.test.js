import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { snapshotExecutionTarget } from "./bot.js";
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

test("fails closed when SQL cannot be parsed as read-only", () => {
  const classification = classifySql("pragma table_info(users)", { driver: "sqlite" });
  assert.equal(classification.kind, "write");
  assert.deepEqual(classification.risks, ["parse_error"]);
  assert.ok(classification.parseError);
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
    sqlitePath: "/tmp/old.sqlite"
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
