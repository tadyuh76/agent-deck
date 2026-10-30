const { test } = require("node:test"),
  assert = require("node:assert/strict");
const {
  terminalInput,
  suspendedPane,
  recoverClaude,
} = require("../backend/terminal-control.cjs");
test("Ctrl+Z becomes prompt undo, including raw input, without changing other terminal keys", async () => {
  assert.equal(terminalInput("\x1a"), "\x1f");
  assert.equal(terminalInput("abc\x1adef"), "abc\x1fdef");
  assert.equal(terminalInput("\x03\x1b[Ahello\r"), "\x03\x1b[Ahello\r");
  const { isTerminalUndo } = await import("../src/keyboard.mjs");
  assert(isTerminalUndo({ ctrlKey: true, code: "KeyZ" }));
  assert(!isTerminalUndo({ ctrlKey: true, shiftKey: true, code: "KeyZ" }));
  assert(!isTerminalUndo({ ctrlKey: true, altKey: true, code: "KeyZ" }));
  assert(!isTerminalUndo({ ctrlKey: false, code: "KeyZ" }));
});
test("Recovery only signals a verified Claude pane with a suspend notice and cooked input", async () => {
  const notice =
    "Claude Code has been suspended. Run 'fg' to bring Claude Code back.";
  assert(suspendedPane("claude", notice, "isig icanon echo;"));
  assert(!suspendedPane("bash", notice, "isig icanon echo;"));
  assert(!suspendedPane("claude", notice, "-isig -icanon -echo;"));
  let signals = [],
    canonical = true;
  const run = async (bin, args) => ({
    stdout:
      bin === "/usr/bin/stty"
        ? canonical
          ? "isig icanon echo;"
          : "-icanon -echo;"
        : args.includes("display-message")
          ? "123|/dev/pts/9|claude\n"
          : notice,
  });
  const disk = {
    readFileSync: (file) =>
      file.endsWith("/comm")
        ? "claude\n"
        : "123 (claude) " + ["S", ...Array(18).fill("0"), "54321"].join(" "),
    statSync: () => ({ uid: process.getuid() }),
  };
  const result = await recoverClaude("/usr/bin/tmux", "agentdeck_test", {
    run,
    fs: disk,
    signal: (pid) => signals.push(pid),
  });
  assert.equal(result.recovered, true);
  assert.deepEqual(signals, [123]);
  canonical = false;
  assert.equal(
    (
      await recoverClaude("/usr/bin/tmux", "agentdeck_test", {
        run,
        fs: disk,
        signal: (pid) => signals.push(pid),
      })
    ).recovered,
    false,
  );
  assert.equal(signals.length, 1);
  await assert.rejects(recoverClaude("/usr/bin/tmux", "unrelated"), /Invalid/);
});
