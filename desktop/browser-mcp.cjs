// MCP server for the agents: Playwright MCP attached to Agent Deck's browser.
// Runs with Windows Node (WSL cannot reach Windows loopback ports). The
// browser opens on the first tool call, not whenever a Claude session starts.
const { spawn } = require("child_process"),
  path = require("path"),
  readline = require("readline");
const { endpoint, root, ensureBrowser } = require("./browser-host.cjs");
const server = spawn(
  process.execPath,
  [
    path.join(root, "node_modules", "@playwright", "mcp", "cli.js"),
    "--cdp-endpoint",
    endpoint,
    "--output-dir",
    path.join(root, "output"),
    ...process.argv.slice(2),
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);
server.on("exit", (code) => process.exit(code ?? 1));
let ready = null;
// Messages are newline-delimited JSON-RPC; keep their order while the
// browser starts.
let queue = Promise.resolve();
readline
  .createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on("line", (line) => {
    queue = queue.then(async () => {
      try {
        if (JSON.parse(line).method === "tools/call")
          await (ready ??= ensureBrowser().catch((error) => {
            ready = null;
            process.stderr.write(error.message + "\n");
          }));
      } catch {}
      server.stdin.write(line + "\n");
    });
  })
  .on("close", () => queue.then(() => server.stdin.end()));
