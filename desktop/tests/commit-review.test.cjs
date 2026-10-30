const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs/promises"),
  os = require("os"),
  path = require("path"),
  { execFileSync } = require("child_process");
const { Repository } = require("../backend/repository.cjs");
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-commits-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        ...args,
      ],
      { encoding: "utf8", stdio: "pipe" },
    ).trim();
  git("init", "-b", "dev");
  const write = (name, text) => fs.writeFile(path.join(root, name), text);
  return { root, git, write, repo: new Repository(root) };
}
test("Commit review handles root, first-parent merge, deletion, rename and literal/SHA history search", async (t) => {
  const { git, write, repo } = await fixture(t);
  await write("first.txt", "first\n");
  git("add", ".");
  git("commit", "-m", "root [literal]");
  const rootCommit = git("rev-parse", "HEAD");
  assert.deepEqual(
    (await repo.changes({ mode: "commit", commit: rootCommit })).map((f) => [
      f.path,
      f.added,
      f.removed,
    ]),
    [["first.txt", 1, 0]],
  );
  const rootDiff = await repo.diff("first.txt", {
    mode: "commit",
    commit: rootCommit,
  });
  assert.equal(rootDiff.original, "");
  assert.equal(rootDiff.modified, "first\n");
  git("checkout", "-b", "feature");
  git("mv", "first.txt", "renamed.txt");
  git("commit", "-m", "rename");
  const rename = git("rev-parse", "HEAD");
  const renameFiles = await repo.changes({ mode: "commit", commit: rename });
  assert.equal(renameFiles[0].oldPath, "first.txt");
  assert.equal(
    (
      await repo.diff("renamed.txt", {
        mode: "commit",
        commit: rename,
        oldPath: "first.txt",
      })
    ).original,
    "first\n",
  );
  assert.equal((await repo.commits({ base: "dev" })).total, 1);
  git("checkout", "dev");
  await write("dev.txt", "dev\n");
  git("add", ".");
  git("commit", "-m", "dev advanced");
  git("merge", "--no-ff", "feature", "-m", "merge feature");
  const merge = git("rev-parse", "HEAD"),
    files = await repo.changes({ mode: "commit", commit: merge });
  assert.equal(files[0].path, "renamed.txt");
  assert(!files.some((f) => f.path === "dev.txt"));
  git("rm", "renamed.txt");
  git("commit", "-m", "delete");
  const gone = await repo.diff("renamed.txt", {
    mode: "commit",
    commit: git("rev-parse", "HEAD"),
  });
  assert.equal(gone.original, "first\n");
  assert.equal(gone.modified, "");
  const first = await repo.commits({ limit: 2 });
  assert.equal(first.commits.length, 2);
  assert.equal(first.total, 5);
  assert(first.hasMore);
  const rest = await repo.commits({ limit: 2, skip: 2 });
  assert(
    !rest.commits.some((c) => first.commits.some((f) => f.hash === c.hash)),
  );
  assert.equal(
    (await repo.commits({ search: "[literal]" })).commits[0].hash,
    rootCommit,
  );
  assert.equal(
    (await repo.commits({ search: rename.slice(0, 9) })).commits[0].hash,
    rename,
  );
  await assert.rejects(
    repo.changes({ mode: "commit", commit: "HEAD;rm -rf /" }),
    /hợp lệ/,
  );
  await assert.rejects(repo.commits({ target: "--all" }), /hợp lệ/);
});
test("All changes combines committed, index, worktree and untracked edits; whitespace filtering agrees with diff rows", async (t) => {
  const { git, write, repo } = await fixture(t);
  await write("code.ts", "const value = 1;\n");
  await write("space.ts", "const x = 1;\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("checkout", "-b", "task");
  await write("code.ts", "const value = 2;\n");
  git("commit", "-am", "committed");
  await write("code.ts", "const value = 3;\n");
  git("add", "code.ts");
  await write("code.ts", "const value = 4;\n");
  await write("space.ts", "  const   x=1;  \n");
  await write("new.txt", "one\ntwo\n");
  const all = await repo.changes({ mode: "all", base: "dev" });
  assert.equal(all.find((f) => f.path === "new.txt").added, 2);
  const diff = await repo.diff("code.ts", { mode: "all", base: "dev" });
  assert.equal(diff.original, "const value = 1;\n");
  assert.equal(diff.modified, "const value = 4;\n");
  const filtered = await repo.changes({
    mode: "all",
    base: "dev",
    ignoreWhitespace: true,
  });
  assert(!filtered.some((f) => f.path === "space.ts"));
  const { reviewBlocks, splitRows, fileGroups } = await import(
    "../src/diff-model.mjs"
  );
  assert(
    reviewBlocks("const x = 1;\n", "  const   x=1;  \n", 3, {
      ignoreWhitespace: true,
    }).every((b) => b.rows.every((r) => r.type === "context")),
  );
  const rows = reviewBlocks("const x = 1;\n", "const x = 22;\nextra\n").flatMap(
    (b) => b.rows,
  );
  assert(
    rows
      .find((r) => r.type === "remove")
      .words.some((w) => w.changed && w.text === "1"),
  );
  assert.equal(splitRows(rows)[1].left, undefined);
  assert.equal(splitRows(rows)[1].right.text, "extra");
  assert.deepEqual(
    fileGroups(
      [
        { path: "src/a.ts" },
        { path: "tests/a.test.ts" },
        { path: "build/a.js" },
      ],
      { separate: true },
    ).map((g) => g.label),
    ["Source", "Tests", "Build & generated"],
  );
  const before = diff.revision;
  await write("code.ts", "other\n");
  assert.notEqual(
    (await repo.diff("code.ts", { mode: "all", base: "dev" })).revision,
    before,
  );
});
test("All changes works for a repository without its first commit", async (t) => {
  const { write, repo } = await fixture(t);
  await write("new.txt", "new\n");
  assert.equal((await repo.changes({ mode: "all", base: "HEAD" }))[0].added, 1);
  assert.equal(
    (await repo.diff("new.txt", { mode: "all", base: "HEAD" })).modified,
    "new\n",
  );
  assert.deepEqual((await repo.commits()).commits, []);
});
