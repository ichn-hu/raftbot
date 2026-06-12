export function log(event, fields = {}) {
  const payload = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
  console.error(`[raftbot] ${event}${payload ? ` ${payload}` : ""}`);
}

function formatValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
