const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs/promises"),
  path = require("path"),
  os = require("os");
const { SessionActions } = require("../backend/session-actions.cjs");
const uuid = "11111111-1111-4111-8111-111111111111";
async function fixture(t, { shared = false, failRemove = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-actions-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, uuid + ".jsonl"),
    folder = path.join(root, uuid);
  await fs.writeFile(file, "conversation\n");
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, "tool-log"), "tool history");
  const project = path.join(root, "project.ts");
  await fs.writeFile(project, "keep source");
  const calls = [],
    cleared = [],
    row = { id: "session-id", tool: "claude", claude_session_id: uuid };
  const cli = async (args) => {
    calls.push(args);
    if (args[1] === "show") return row;
    if (args[0] === "list")
      return [
        row,
        ...(shared ? [{ id: "other-id", claude_session_id: uuid }] : []),
      ];
    if (failRemove && args[1] === "remove") throw new Error("remove failed");
    return { success: true };
  };
  const actions = new SessionActions({
    cli,
    conversations: {
      transcript: async () => file,
      cache: new Map(),
      meta: new Map(),
    },
    clearPanels: async (id) => cleared.push(id),
  });
  return { actions, file, folder, project, calls, cleared };
}
test("Archive and unarchive preserve transcripts and use the native lifecycle", async (t) => {
  const f = await fixture(t);
  await f.actions.mutate("session-id", "archive");
  assert.deepEqual(f.calls.at(-1), [
    "session",
    "archive",
    "session-id",
    "--json",
  ]);
  assert.deepEqual(f.cleared, ["session-id"]);
  assert.equal(await fs.readFile(f.file, "utf8"), "conversation\n");
  await f.actions.mutate("session-id", "unarchive");
  assert.equal(f.cleared.length, 1);
  assert.deepEqual(f.calls.at(-1), [
    "session",
    "unarchive",
    "session-id",
    "--json",
  ]);
});
test("Deletion stops/removes the selected session and purges only its private transcript folder", async (t) => {
  const f = await fixture(t),
    result = await f.actions.mutate("session-id", "delete");
  assert(
    f.calls.some(
      (args) => args.join(" ") === "session remove session-id --force --json",
    ),
  );
  assert.equal(result.deletedTranscripts, 1);
  await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
  await assert.rejects(fs.stat(f.folder), { code: "ENOENT" });
  assert.equal(await fs.readFile(f.project, "utf8"), "keep source");
  assert.deepEqual(f.cleared, ["session-id"]);
});
test("Shared transcripts and optional retained history survive deletion", async (t) => {
  const shared = await fixture(t, { shared: true }),
    result = await shared.actions.mutate("session-id", "delete");
  assert.equal(result.retainedShared, 1);
  assert.equal(await fs.readFile(shared.file, "utf8"), "conversation\n");
  const kept = await fixture(t);
  await kept.actions.mutate("session-id", "delete", { deleteHistory: false });
  assert.equal(await fs.readFile(kept.file, "utf8"), "conversation\n");
});
test("Failed registry deletion never removes history or clears panels", async (t) => {
  const f = await fixture(t, { failRemove: true });
  await assert.rejects(
    f.actions.mutate("session-id", "delete"),
    /remove failed/,
  );
  assert.equal(await fs.readFile(f.file, "utf8"), "conversation\n");
  assert.equal(f.cleared.length, 0);
  await assert.rejects(f.actions.mutate("../outside", "delete"), /Invalid/);
});
