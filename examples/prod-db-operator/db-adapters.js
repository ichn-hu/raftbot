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
        const result = await client.query(statement);
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
        const [rows] = await connection.query(statement);
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
    return this.db;
  }

  async query(statements, options = {}) {
    const db = await this.open();
    const results = statements.map((statement) => normalizeRows(statement, db.prepare(statement).all(), options.maxRows));
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
  const safeRows = rows.map((row) => row && typeof row === "object" ? { ...row } : { value: row });
  const truncated = safeRows.length > maxRows;
  return {
    statement,
    rows: truncated ? safeRows.slice(0, maxRows) : safeRows,
    totalRows: safeRows.length,
    truncated
  };
}
