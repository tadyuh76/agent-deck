const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { execFileSync } = require("child_process"),
  fs = require("fs"),
  path = require("path");
const { stopServers } = require("../backend/lifecycle.cjs");
test("Full exit stops the owned server and leaves another tmux server running", async (t) => {
  const owned = "deck-test-owned-" + process.pid,
    other = "deck-test-unrelated-" + process.pid;
  const tmux = (name, ...args) =>
    execFileSync("/usr/bin/tmux", ["-L", name, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  t.after(async () => {
    await stopServers("/usr/bin/tmux", [owned, other]);
    // A stopped server leaves its socket file; remove the test's own.
    const folder = path.join(
      process.env.TMUX_TMPDIR || "/tmp",
      "tmux-" + process.getuid(),
    );
    for (const name of [owned, other])
      fs.rmSync(path.join(folder, name), { force: true });
  });
  tmux(owned, "new-session", "-d", "-s", "agent", "sleep 600");
  tmux(other, "new-session", "-d", "-s", "unrelated", "sleep 600");
  await stopServers("/usr/bin/tmux", [owned]);
  assert.throws(() => tmux(owned, "has-session"));
  assert.doesNotThrow(() => tmux(other, "has-session"));
  await stopServers("/usr/bin/tmux", [owned]);
});
