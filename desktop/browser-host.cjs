// Agent Deck's own browser: one Chrome (or Edge) window with a private
// profile and a loopback DevTools port. The agents drive it through
// Playwright MCP and the desktop app's Browser tab shows the same pages.
const { spawn } = require("child_process"),
  fs = require("fs"),
  path = require("path");
const PORT = 9333,
  endpoint = "http://127.0.0.1:" + PORT,
  root = path.join(process.env.LOCALAPPDATA || "", "AgentDeck", "browser"),
  programs = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.LOCALAPPDATA,
  ].filter(Boolean);
const executables = [
  ...programs.map((dir) =>
    path.join(dir, "Google", "Chrome", "Application", "chrome.exe"),
  ),
  ...programs.map((dir) =>
    path.join(dir, "Microsoft", "Edge", "Application", "msedge.exe"),
  ),
];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function version() {
  try {
    const response = await fetch(endpoint + "/json/version", {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
async function ensureBrowser() {
  let info = await version();
  if (info) return info;
  fs.mkdirSync(root, { recursive: true });
  // Several agents may ask at once; one launches, the others wait for it.
  const lock = path.join(root, "launch.lock");
  let owner = false;
  try {
    const stale = Date.now() - fs.statSync(lock).mtimeMs > 20000;
    if (stale) fs.rmSync(lock, { force: true });
  } catch {}
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
    owner = true;
  } catch {}
  try {
    if (owner) {
      const executable = executables.find((file) => fs.existsSync(file));
      if (!executable)
        throw new Error("Không tìm thấy Chrome hoặc Edge trên Windows");
      spawn(
        executable,
        [
          "--remote-debugging-port=" + PORT,
          "--remote-debugging-address=127.0.0.1",
          "--user-data-dir=" + path.join(root, "profile"),
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
        { detached: true, stdio: "ignore" },
      ).unref();
    }
    for (let i = 0; i < 75; i++) {
      await pause(200);
      if ((info = await version())) return info;
    }
    throw new Error("Trình duyệt Agent Deck chưa mở cổng DevTools");
  } finally {
    if (owner) fs.rmSync(lock, { force: true });
  }
}
module.exports = { PORT, endpoint, root, version, ensureBrowser };
