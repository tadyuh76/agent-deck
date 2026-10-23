const fs = require("fs"),
  { execFile } = require("child_process"),
  { promisify } = require("util"),
  run = promisify(execFile);
async function stopServers(tmux, names) {
  for (const name of names) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Invalid tmux server");
    await run(tmux, ["-L", name, "kill-server"], { timeout: 5000 }).catch(
      (error) => {
        if (
          !/no server running|No such file|error connecting/.test(
            error.stderr || "",
          )
        )
          throw error;
      },
    );
  }
}
function stopHelpers(root, deck) {
  const processes = [];
  for (const entry of fs.readdirSync("/proc").filter((x) => /^\d+$/.test(x)))
    try {
      const pid = Number(entry),
        argv = fs
          .readFileSync("/proc/" + entry + "/cmdline", "utf8")
          .split("\0"),
        status = fs.readFileSync("/proc/" + entry + "/status", "utf8"),
        ppid = Number(status.match(/^PPid:\s*(\d+)/m)?.[1]);
      processes.push({
        pid,
        ppid,
        owned:
          (deck &&
            argv[0] === deck &&
            argv.includes("session") &&
            argv.includes("send-worker")) ||
          argv.some((arg) =>
            [
              root + "/panel.js",
              root + "/workspace.js",
              root + "/panel-labels.js",
              root + "/limit-router.js",
              root + "/account-usage.js",
            ].includes(arg),
          ),
      });
    } catch {}
  const selected = new Set(
    processes.filter((p) => p.owned && p.pid !== process.pid).map((p) => p.pid),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of processes)
      if (selected.has(p.ppid) && !selected.has(p.pid)) {
        selected.add(p.pid);
        changed = true;
      }
  }
  // Children first: account-usage can briefly own a Claude usage-query process.
  for (const p of processes.reverse())
    if (selected.has(p.pid))
      try {
        process.kill(p.pid, "SIGTERM");
      } catch {}
}
module.exports = { stopServers, stopHelpers };
