export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    serverUrl: "",
    apiKey: ""
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--server-url" && argv[i + 1]) out.serverUrl = argv[++i];
    else if (arg === "--api-key" && argv[i + 1]) out.apiKey = argv[++i];
    else if (arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  if (!out.serverUrl || !out.apiKey) {
    throw new Error("Usage: raftbot --server-url <url> --api-key <key>");
  }
  return out;
}
