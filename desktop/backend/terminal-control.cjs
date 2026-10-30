const fs = require("fs"),
  { execFile } = require("child_process"),
  { promisify } = require("util");
const execute = promisify(execFile);
// A native Claude pane has no interactive parent shell to receive `fg`.
// Keep Windows undo out of Unix job control, even when it arrives as raw input.
function terminalInput(data) {
  return data.replace(/\x1a/g, "\x1f");
}
function suspendedPane(command, capture, flags) {
  return (
    command === "claude" &&
    capture.includes("Claude Code has been suspended.") &&
    flags.split(/[\s;]+/).includes("icanon")
  );
}
async function recoverClaude(tmux, session, dependencies = {}) {
  if (!/^agentdeck_[\w-]+$/.test(session || ""))
    throw new Error("Invalid managed session");
  const run = dependencies.run || execute,
    disk = dependencies.fs || fs,
    signal = dependencies.signal || ((pid) => process.kill(pid, "SIGCONT"));
  const mux = async (args) =>
    (
      await run(tmux, ["-L", "agent-deck-managed", ...args], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  const details = (
    await mux([
      "display-message",
      "-p",
      "-t",
      session,
      "#{pane_pid}|#{pane_tty}|#{pane_current_command}",
    ])
  )
    .trim()
    .split("|");
  const [rawPid, tty, command] = details,
    pid = Number(rawPid);
  if (
    !Number.isInteger(pid) ||
    pid < 2 ||
    !/^\/dev\/pts\/\d+$/.test(tty || "") ||
    command !== "claude"
  )
    return { recovered: false };
  // Remember the process start time now, so a PID reused while we inspect
  // the pane is never signalled.
  const identity = (value) =>
      value.slice(value.lastIndexOf(")") + 2).split(" ")[19],
    started = identity(disk.readFileSync("/proc/" + pid + "/stat", "utf8"));
  const [capture, settings] = await Promise.all([
    mux(["capture-pane", "-p", "-t", session, "-S", "-50"]),
    run("/usr/bin/stty", ["-F", tty, "-a"], {
      encoding: "utf8",
      timeout: 3000,
    }),
  ]);
  if (!suspendedPane(command, capture, settings.stdout))
    return { recovered: false };
  const comm = disk.readFileSync("/proc/" + pid + "/comm", "utf8").trim();
  if (
    comm !== "claude" ||
    disk.statSync("/proc/" + pid).uid !== process.getuid()
  )
    throw new Error("Cannot verify Claude process");
  if (
    !/^\d+$/.test(started || "") ||
    started !== identity(disk.readFileSync("/proc/" + pid + "/stat", "utf8"))
  )
    throw new Error("Claude process changed");
  signal(pid);
  return { recovered: true, pid };
}
module.exports = { terminalInput, suspendedPane, recoverClaude };
