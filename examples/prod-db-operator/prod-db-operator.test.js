import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDatabaseAdapter } from "./db-adapters.js";
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
