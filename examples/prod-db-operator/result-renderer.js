export function createResultResponse(results, options = {}) {
  const inlineRows = options.inlineRows ?? 20;
  const pageRows = options.pageRows ?? 500;
  const maxRows = options.maxRows ?? 2_000;
  const totalRows = results.reduce((sum, result) => sum + result.rows.length, 0);
  const truncated = results.some((result) => result.truncated || result.totalRows > maxRows);

  if (totalRows <= inlineRows) {
    return {
      truncated,
      message: {
        text: renderMarkdown(results, { truncated }),
        attachments: []
      }
    };
  }

  const attachments = [];
  let pageCount = 0;
  for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
    const result = results[resultIndex];
    const pages = chunkRows(result.rows, pageRows);
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      pageCount += 1;
      const pageRowsForResult = pages[pageIndex];
      const prefix = `${options.baseName ?? "query-result"}-s${resultIndex + 1}-p${pageIndex + 1}`;
      attachments.push({
        filename: `${prefix}.csv`,
        mimeType: "text/csv",
        bytes: Buffer.from(renderCsv(pageRowsForResult), "utf-8")
      });
      attachments.push({
        filename: `${prefix}.html`,
        mimeType: "text/html",
        bytes: Buffer.from(renderHtml(result, pageRowsForResult, {
          resultIndex,
          pageIndex,
          pageCount: pages.length,
          truncated: result.truncated
        }), "utf-8")
      });
    }
  }

  return {
    truncated,
    message: {
      text: [
        `Query returned ${totalRows} row${totalRows === 1 ? "" : "s"} across ${results.length} result set${results.length === 1 ? "" : "s"}.`,
        `Attached ${attachments.length} file${attachments.length === 1 ? "" : "s"} across ${pageCount} page${pageCount === 1 ? "" : "s"}.`,
        truncated ? `Result was capped at ${maxRows} rows per result set.` : null
      ].filter(Boolean).join("\n"),
      attachments
    }
  };
}

function renderMarkdown(results, options = {}) {
  const blocks = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    blocks.push(`Result set ${i + 1}: ${result.rows.length} row${result.rows.length === 1 ? "" : "s"}`);
    if (result.rows.length === 0) {
      blocks.push("(no rows)");
      continue;
    }
    blocks.push(renderMarkdownTable(result.rows));
  }
  if (options.truncated) blocks.push("Result was truncated by the configured row cap.");
  return blocks.join("\n\n");
}

function renderMarkdownTable(rows) {
  const columns = columnsForRows(rows);
  const header = `| ${columns.map(escapeMarkdownCell).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => escapeMarkdownCell(formatValue(row[column]))).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

function renderCsv(rows) {
  const columns = columnsForRows(rows);
  const lines = [columns.map(escapeCsv).join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsv(formatValue(row[column]))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function renderHtml(result, rows, meta) {
  const columns = columnsForRows(rows);
  const header = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const body = rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(formatValue(row[column]))}</td>`).join("")}</tr>`).join("\n");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>SQL Result ${meta.resultIndex + 1}.${meta.pageIndex + 1}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; color: #17202a; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid #d6dbdf; padding: 6px 8px; text-align: left; vertical-align: top; }
    th { background: #eef2f5; position: sticky; top: 0; }
    code { white-space: pre-wrap; }
    .meta { margin-bottom: 16px; color: #566573; }
  </style>
</head>
<body>
  <h1>SQL Result Set ${meta.resultIndex + 1}</h1>
  <div class="meta">Page ${meta.pageIndex + 1} of ${meta.pageCount}. Rows in this page: ${rows.length}.${meta.truncated ? " Result was capped by the configured row limit." : ""}</div>
  <h2>Statement</h2>
  <code>${escapeHtml(result.statement)}</code>
  <h2>Rows</h2>
  <table>
    <thead><tr>${header}</tr></thead>
    <tbody>${body}</tbody>
  </table>
</body>
</html>`;
}

function columnsForRows(rows) {
  const columns = [];
  const seen = new Set();
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }
    }
  }
  return columns.length > 0 ? columns : ["value"];
}

function chunkRows(rows, size) {
  const pages = [];
  for (let i = 0; i < rows.length; i += size) {
    pages.push(rows.slice(i, i + size));
  }
  return pages.length > 0 ? pages : [[]];
}

function formatValue(value) {
  if (value === null) return "NULL";
  if (value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function escapeMarkdownCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function escapeCsv(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
