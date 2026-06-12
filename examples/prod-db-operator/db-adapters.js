import { mkdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import mysql from "mysql2/promise";
import pg from "pg";

export async function createDatabaseAdapter(config) {
  if (config.driver === "sqlite") return new SqliteAdapter(config);
  if (config.driver === "pg" || config.driver === "postgres" || config.driver === "postgresql") return new PgAdapter(config);
  if (config.driver === "mysql" || config.driver === "mysql2") return new MySqlAdapter(config);
  throw new Error(`Unsupported database driver: ${config.driver}`);
}

export function describeDatabaseTarget(config) {
  if (config.driver === "sqlite") return `sqlite:${config.sqlitePath}`;
  if (config.driver === "mysql" || config.driver === "mysql2") return "mysql";
  if (config.driver === "pg" || config.driver === "postgres" || config.driver === "postgresql") return "postgres";
  return config.driver;
}

class PgAdapter {
  constructor(config) {
    if (!config.databaseUrl) throw new Error("PostgreSQL requires --database-url or DATABASE_URL");
    this.pool = new pg.Pool({ connectionString: config.databaseUrl });
  }

  async query(statements, options = {}) {
    const client = await this.pool.connect();
    try {
      const results = [];
      for (const statement of statements) {
        const result = await client.query(readStatementForExecution(statement, options.maxRows));
        results.push(normalizeRows(statement, result.rows ?? [], options.maxRows));
      }
      return { results };
    } finally {
      client.release();
    }
  }

  async executeTransaction(statements) {
    const client = await this.pool.connect();
    let affectedRows = 0;
    try {
      await client.query("BEGIN");
      for (const statement of statements) {
        const result = await client.query(statement);
        affectedRows += Number(result.rowCount ?? 0);
      }
      await client.query("COMMIT");
      return { affectedRows };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

class MySqlAdapter {
  constructor(config) {
    if (!config.databaseUrl) throw new Error("MySQL requires --database-url or DATABASE_URL");
    this.pool = mysql.createPool(config.databaseUrl);
  }

  async query(statements, options = {}) {
    const connection = await this.pool.getConnection();
    try {
      const results = [];
      for (const statement of statements) {
        const [rows] = await connection.query(readStatementForExecution(statement, options.maxRows));
        results.push(normalizeRows(statement, Array.isArray(rows) ? rows : [], options.maxRows));
      }
      return { results };
    } finally {
      connection.release();
    }
  }

  async executeTransaction(statements) {
    const connection = await this.pool.getConnection();
    let affectedRows = 0;
    try {
      await connection.beginTransaction();
      for (const statement of statements) {
        const [result] = await connection.query(statement);
        affectedRows += Number(result?.affectedRows ?? 0);
      }
      await connection.commit();
      return { affectedRows };
    } catch (err) {
      await connection.rollback().catch(() => {});
      throw err;
    } finally {
      connection.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

class SqliteAdapter {
  constructor(config) {
    this.config = config;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    await mkdir(path.dirname(this.config.sqlitePath), { recursive: true });
    this.db = new Database(this.config.sqlitePath);
    if (this.config.seedDefaultData) seedDefaultSqliteData(this.db);
    return this.db;
  }

  async query(statements, options = {}) {
    const db = await this.open();
    const results = statements.map((statement) => normalizeRows(
      statement,
      db.prepare(readStatementForExecution(statement, options.maxRows)).all(),
      options.maxRows
    ));
    return { results };
  }

  async executeTransaction(statements) {
    const db = await this.open();
    let affectedRows = 0;
    const run = db.transaction(() => {
      for (const statement of statements) {
        const result = db.prepare(statement).run();
        affectedRows += Number(result.changes ?? 0);
      }
    });
    run();
    return { affectedRows };
  }

  async close() {
    this.db?.close();
    this.db = null;
  }
}

function normalizeRows(statement, rows, maxRows = 2_000) {
  const cap = normalizedMaxRows(maxRows);
  const safeRows = rows.map((row) => row && typeof row === "object" ? { ...row } : { value: row });
  const truncated = safeRows.length > cap;
  return {
    statement,
    rows: truncated ? safeRows.slice(0, cap) : safeRows,
    totalRows: safeRows.length,
    truncated
  };
}

export function readStatementForExecution(statement, maxRows = 2_000) {
  const sql = stripTrailingSemicolons(statement);
  return supportsOuterLimit(sql) ? cappedReadStatement(sql, maxRows) : sql;
}

function cappedReadStatement(statement, maxRows = 2_000) {
  const cap = normalizedMaxRows(maxRows);
  const fetchRows = cap + 1;
  return `SELECT * FROM (${statement}) AS raftbot_read_cap LIMIT ${fetchRows}`;
}

function stripTrailingSemicolons(statement) {
  return String(statement ?? "").trim().replace(/;+$/, "").trim();
}

function supportsOuterLimit(statement) {
  const keyword = leadingKeyword(statement);
  return keyword === "select" || keyword === "with";
}

function leadingKeyword(statement) {
  let text = String(statement ?? "").trimStart();
  while (true) {
    if (text.startsWith("--")) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1).trimStart() : "";
      continue;
    }
    if (text.startsWith("/*")) {
      const close = text.indexOf("*/");
      text = close >= 0 ? text.slice(close + 2).trimStart() : "";
      continue;
    }
    break;
  }
  return text.match(/^([A-Za-z]+)/)?.[1]?.toLowerCase() ?? "";
}

function normalizedMaxRows(maxRows) {
  return Number.isInteger(maxRows) && maxRows > 0 ? maxRows : 2_000;
}

function seedDefaultSqliteData(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raftbot_demo_customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      plan TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS raftbot_demo_orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES raftbot_demo_customers(id),
      item TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS raftbot_demo_events (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES raftbot_demo_customers(id),
      event_type TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  const existing = db.prepare("SELECT COUNT(*) AS count FROM raftbot_demo_customers").get();
  if (Number(existing?.count ?? 0) > 0) return;
  const insertCustomer = db.prepare(`
    INSERT INTO raftbot_demo_customers (id, name, email, plan, created_at)
    VALUES (@id, @name, @email, @plan, @created_at)
  `);
  const insertOrder = db.prepare(`
    INSERT INTO raftbot_demo_orders (id, customer_id, item, amount_cents, status, created_at)
    VALUES (@id, @customer_id, @item, @amount_cents, @status, @created_at)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO raftbot_demo_events (id, customer_id, event_type, metadata_json, created_at)
    VALUES (@id, @customer_id, @event_type, @metadata_json, @created_at)
  `);
  const seed = db.transaction(() => {
    for (const row of [
      { id: 1, name: "Ada Lovelace", email: "ada@example.test", plan: "pro", created_at: "2026-01-04T09:15:00Z" },
      { id: 2, name: "Grace Hopper", email: "grace@example.test", plan: "enterprise", created_at: "2026-01-12T11:30:00Z" },
      { id: 3, name: "Katherine Johnson", email: "katherine@example.test", plan: "starter", created_at: "2026-02-02T16:45:00Z" },
      { id: 4, name: "Margaret Hamilton", email: "margaret@example.test", plan: "pro", created_at: "2026-02-18T14:20:00Z" }
    ]) insertCustomer.run(row);
    for (const row of [
      { id: 101, customer_id: 1, item: "compute credits", amount_cents: 12500, status: "paid", created_at: "2026-03-01T10:00:00Z" },
      { id: 102, customer_id: 1, item: "priority support", amount_cents: 4500, status: "paid", created_at: "2026-03-05T10:00:00Z" },
      { id: 103, customer_id: 2, item: "enterprise seats", amount_cents: 98000, status: "paid", created_at: "2026-03-07T12:30:00Z" },
      { id: 104, customer_id: 3, item: "starter renewal", amount_cents: 1900, status: "open", created_at: "2026-03-09T08:15:00Z" },
      { id: 105, customer_id: 4, item: "migration services", amount_cents: 30000, status: "refunded", created_at: "2026-03-11T13:05:00Z" }
    ]) insertOrder.run(row);
    for (const row of [
      { id: 1001, customer_id: 1, event_type: "login", metadata_json: "{\"source\":\"web\"}", created_at: "2026-03-12T09:01:00Z" },
      { id: 1002, customer_id: 2, event_type: "export", metadata_json: "{\"rows\":240}", created_at: "2026-03-12T09:05:00Z" },
      { id: 1003, customer_id: 3, event_type: "upgrade_prompt", metadata_json: "{\"campaign\":\"spring\"}", created_at: "2026-03-12T09:08:00Z" },
      { id: 1004, customer_id: 4, event_type: "support_ticket", metadata_json: "{\"priority\":\"high\"}", created_at: "2026-03-12T09:12:00Z" }
    ]) insertEvent.run(row);
  });
  seed();
}
