import sqlParser from "node-sql-parser";

const { Parser } = sqlParser;
const parser = new Parser();
const READ_ONLY_TYPES = new Set(["select", "show", "describe", "desc", "explain"]);

export function classifySql(sql, options = {}) {
  const database = parserDatabase(options.driver);
  const fallbackStatements = fallbackSplitStatements(sql);
  try {
    const parsed = parser.astify(sql, { database });
    const asts = Array.isArray(parsed) ? parsed : [parsed];
    const readOnly = asts.length > 0 && asts.every(isReadOnlyAst);
    return {
      statements: fallbackStatements,
      kind: readOnly ? "read" : "write",
      risks: detectRisks(asts),
      parseError: null
    };
  } catch (err) {
    return {
      statements: fallbackStatements,
      kind: "write",
      risks: ["parse_error"],
      parseError: err instanceof Error ? err.message : String(err)
    };
  }
}

function parserDatabase(driver) {
  if (driver === "pg" || driver === "postgres" || driver === "postgresql") return "postgresql";
  if (driver === "mysql" || driver === "mysql2") return "mysql";
  return "sqlite";
}

function isReadOnlyAst(ast) {
  const node = unwrapAst(ast);
  if (!node || typeof node !== "object") return false;
  if (!READ_ONLY_TYPES.has(node.type)) return false;
  if (node.type === "select") {
    if (hasMeaningfulInto(node.into)) return false;
    if (node.for_update || node.locking_read) return false;
  }
  return readOnlyWithClause(node.with);
}

function readOnlyWithClause(withClause) {
  if (!Array.isArray(withClause)) return true;
  return withClause.every((item) => {
    const stmt = unwrapAst(item?.stmt);
    return stmt ? isReadOnlyAst(stmt) : false;
  });
}

function unwrapAst(value) {
  if (value?.ast) return unwrapAst(value.ast);
  return value;
}

function hasMeaningfulInto(into) {
  if (!into) return false;
  if (Array.isArray(into)) return into.length > 0;
  if (typeof into !== "object") return true;
  return Object.entries(into).some(([key, value]) => key !== "position" && value !== null && value !== undefined);
}

function detectRisks(asts) {
  const risks = new Set();
  for (const ast of asts) collectRisks(unwrapAst(ast), risks);
  return [...risks];
}

function collectRisks(ast, risks) {
  if (!ast || typeof ast !== "object") return;
  if (Array.isArray(ast)) {
    for (const item of ast) collectRisks(item, risks);
    return;
  }
  if (ast.type === "drop") risks.add("drop");
  if (ast.type === "truncate") risks.add("truncate");
  if (ast.type === "alter") risks.add("alter");
  if (ast.type === "delete" && !ast.where) risks.add("delete_without_where");
  if (ast.type === "update" && !ast.where) risks.add("update_without_where");
  for (const value of Object.values(ast)) {
    if (value && typeof value === "object") collectRisks(value, risks);
  }
}

function fallbackSplitStatements(sql) {
  const statements = [];
  let current = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      current += ch;
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      current += ch;
      if (ch === "*" && next === "/") {
        current += next;
        i += 1;
        blockComment = false;
      }
      continue;
    }
    if (!quote && ch === "-" && next === "-") {
      current += ch + next;
      i += 1;
      lineComment = true;
      continue;
    }
    if (!quote && ch === "/" && next === "*") {
      current += ch + next;
      i += 1;
      blockComment = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote && sql[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";") {
      pushStatement(statements, current);
      current = "";
      continue;
    }
    current += ch;
  }
  pushStatement(statements, current);
  return statements;
}

function pushStatement(statements, raw) {
  const statement = raw.trim();
  if (statement) statements.push(statement);
}
