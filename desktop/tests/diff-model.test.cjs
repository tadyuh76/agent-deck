const { test } = require("node:test"),
  assert = require("node:assert/strict");
test("Continuous review folds unchanged lines and numbers additions and removals", async () => {
  const { reviewBlocks } = await import("../src/diff-model.mjs");
  const before = Array.from({ length: 40 }, (_, i) => "line " + (i + 1) + "\n");
  const after = [...before];
  after[20] = "changed\n";
  const blocks = reviewBlocks(before.join(""), after.join(""));
  assert(blocks.some((b) => b.folded && b.rows.length > 10));
  const rows = blocks.flatMap((b) => b.rows);
  const removed = rows.find((r) => r.type === "remove"),
    added = rows.find((r) => r.type === "add");
  assert.equal(removed.old, 21);
  assert.equal(added.next, 21);
  assert.equal(added.text, "changed");
});
