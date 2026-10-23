const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs/promises"),
  os = require("os"),
  path = require("path"),
  { execFileSync } = require("child_process");
const { Repository } = require("../backend/repository.cjs");
test("Git review handles working, staged, renamed and deleted files, and branch merge bases", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-review-"));
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
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  git("init", "-b", "main");
  await fs.mkdir(path.join(root, "gone"));
  await fs.writeFile(path.join(root, "gone", "file.txt"), "original\n");
  await fs.writeFile(path.join(root, "code.ts"), "const n = 1;\n");
  git("add", ".");
  git("commit", "-m", "base");
  git("checkout", "-b", "feature");
  await fs.writeFile(path.join(root, "code.ts"), "const n = 2;\n");
  git("commit", "-am", "feature edit");
  git("checkout", "main");
  await fs.writeFile(path.join(root, "main.txt"), "main-only\n");
  git("add", ".");
  git("commit", "-m", "main advanced");
  const repo = new Repository(root),
    info = await repo.info();
  assert.equal(info.branch, "main");
  const changes = await repo.changes({
    mode: "branches",
    base: "main",
    target: "feature",
  });
  assert.deepEqual(
    changes.map((x) => x.path),
    ["code.ts"],
  );
  const diff = await repo.diff("code.ts", {
    mode: "branches",
    base: "main",
    target: "feature",
  });
  assert.equal(diff.original, "const n = 1;\n");
  assert.equal(diff.modified, "const n = 2;\n");
  const direct = await repo.changes({
    mode: "branches",
    base: "main",
    target: "feature",
    mergeBase: false,
  });
  assert(direct.some((x) => x.path === "main.txt" && x.status === "D"));
  git("mv", "code.ts", "renamed file.ts");
  await fs.rm(path.join(root, "gone"), { recursive: true });
  await fs.writeFile(path.join(root, "new file.txt"), "new\n");
  const work = await repo.changes({ mode: "working" });
  assert(
    work.some((x) => x.path === "renamed file.ts" && x.oldPath === "code.ts"),
  );
  assert(work.some((x) => x.path === "new file.txt" && x.status === "??"));
  const deleted = await repo.diff("gone/file.txt");
  assert.equal(deleted.original, "original\n");
  assert.equal(deleted.modified, "");
  const staged = await repo.diff("renamed file.ts", {
    mode: "staged",
    oldPath: "code.ts",
  });
  assert.equal(staged.original, staged.modified);
});
test("Editor rejects traversal, external symlinks and concurrent changes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = new Repository(root);
  await fs.writeFile(path.join(root, "file.txt"), "first");
  const opened = await repo.file("file.txt");
  await fs.writeFile(path.join(root, "file.txt"), "agent edit");
  await assert.rejects(
    repo.save("file.txt", "user edit", opened.version),
    /changed on disk/,
  );
  assert.equal(
    await fs.readFile(path.join(root, "file.txt"), "utf8"),
    "agent edit",
  );
  const latest = await repo.file("file.txt");
  const saved = await repo.save("file.txt", "saved", latest.version);
  assert.equal(saved.text, "saved");
  await assert.rejects(repo.file("../outside"), /inside/);
  await fs.symlink("/etc/passwd", path.join(root, "external"));
  await assert.rejects(repo.file("external"), /symbolic/);
  await fs.writeFile(path.join(root, "binary"), Buffer.from([0, 1, 2]));
  assert.equal((await repo.file("binary")).kind, "binary");
});
test("Staged and unstaged contents and per-file line counts stay separate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-staging-"));
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
      { stdio: "pipe" },
    );
  git("init", "-b", "main");
  await fs.writeFile(path.join(root, "code.txt"), "base\n");
  git("add", ".");
  git("commit", "-m", "base");
  await fs.writeFile(path.join(root, "code.txt"), "staged\nstaged second\n");
  git("add", "code.txt");
  await fs.writeFile(
    path.join(root, "code.txt"),
    "working\nstaged second\nworking third\n",
  );
  await fs.writeFile(path.join(root, "new unicode tiếng Việt.txt"), "one\ntwo");
  const repo = new Repository(root),
    staged = await repo.changes({ mode: "staged" }),
    unstaged = await repo.changes({ mode: "unstaged" });
  assert.equal(staged[0].added, 2);
  assert.equal(staged[0].removed, 1);
  assert.equal(unstaged.find((f) => f.path === "code.txt").added, 2);
  assert.equal(unstaged.find((f) => f.path === "code.txt").removed, 1);
  assert.equal(unstaged.find((f) => f.path.startsWith("new unicode")).added, 2);
  const stagedDiff = await repo.diff("code.txt", { mode: "staged" }),
    unstagedDiff = await repo.diff("code.txt", { mode: "unstaged" });
  assert.equal(stagedDiff.original, "base\n");
  assert.equal(stagedDiff.modified, "staged\nstaged second\n");
  assert.equal(unstagedDiff.original, stagedDiff.modified);
  assert.equal(
    unstagedDiff.modified,
    "working\nstaged second\nworking third\n",
  );
  git("add", "code.txt");
  git("commit", "-m", "before rename");
  git("mv", "code.txt", "renamed tiếng Việt.txt");
  await fs.appendFile(
    path.join(root, "renamed tiếng Việt.txt"),
    "fourth\nfifth\n",
  );
  git("add", "renamed tiếng Việt.txt");
  const rename = (await repo.changes({ mode: "staged" })).find(
    (f) => f.oldPath === "code.txt",
  );
  assert(rename);
  assert.equal(rename.added, 2);
});
test("PNG previews preserve binary bytes in files, index, and branch blobs", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-png-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFrsAAAAASUVORK5CYII=",
    "base64",
  );
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
      { stdio: "pipe" },
    );
  git("init", "-b", "main");
  await fs.writeFile(path.join(root, "image.png"), png);
  git("add", ".");
  git("commit", "-m", "image");
  const repo = new Repository(root),
    image = await repo.file("image.png");
  assert.equal(image.kind, "image");
  assert.equal(image.src.split(",")[1], png.toString("base64"));
  const changed = Buffer.concat([png, Buffer.from("metadata")]);
  await fs.writeFile(path.join(root, "image.png"), changed);
  git("add", ".");
  const diff = await repo.diff("image.png", { mode: "staged" });
  assert.equal(diff.kind, "image-diff");
  assert.equal(diff.before.src, image.src);
  assert.equal(diff.after.src.split(",")[1], changed.toString("base64"));
  assert.equal((await repo.changes({ mode: "staged" }))[0].binary, true);
  await assert.rejects(
    repo.save("image.png", "broken", image.version),
    /Binary/,
  );
});
test("Short file references resolve unique and duplicate project filenames", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-references-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main", root], { stdio: "pipe" });
  await fs.mkdir(path.join(root, "src"));
  await fs.mkdir(path.join(root, "docs"));
  await fs.mkdir(path.join(root, "mockups"));
  await fs.writeFile(path.join(root, ".gitignore"), "mockups/\n");
  await fs.writeFile(
    path.join(root, "mockups", "copy-v3.js"),
    "ignored but previewable",
  );
  await fs.writeFile(path.join(root, "src", "unique.ts"), "source");
  await fs.writeFile(path.join(root, "src", "same.md"), "a");
  await fs.writeFile(path.join(root, "docs", "same.md"), "b");
  const repo = new Repository(root);
  assert.deepEqual(await repo.locate("unique.ts"), ["src/unique.ts"]);
  assert.deepEqual(await repo.locate("copy-v3.js"), ["mockups/copy-v3.js"]);
  assert.deepEqual((await repo.locate("same.md")).sort(), [
    "docs/same.md",
    "src/same.md",
  ]);
  await assert.rejects(repo.locate("../outside"), /inside/);
});
test("Non-UTF-8 files stay read-only, CRLF checkouts diff by line, and saves keep BOM and CRLF", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-encoding-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@localhost",
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  git("init", "-b", "main");
  git("config", "core.autocrlf", "true");
  await fs.writeFile(root + "/latin.txt", Buffer.from("caf\xe9\n", "latin1"));
  await fs.writeFile(root + "/crlf.txt", "one\r\ntwo\r\nthree\r\n");
  await fs.writeFile(root + "/bom.txt", "﻿a\r\nb\r\n");
  git("add", ".");
  git("commit", "-m", "init");
  await fs.writeFile(root + "/crlf.txt", "one\r\nTWO\r\nthree\r\n");
  const repo = new Repository(root),
    latin = await repo.file("latin.txt");
  assert.equal(latin.readOnly, true);
  await assert.rejects(
    repo.save("latin.txt", latin.text, latin.version),
    /UTF-8/,
  );
  assert.equal(
    (await fs.readFile(root + "/latin.txt")).toString("hex"),
    "636166e90a",
  );
  const diff = await repo.diff("crlf.txt", { mode: "working" });
  assert.equal(diff.original, "one\ntwo\nthree\n");
  assert.equal(diff.modified, "one\nTWO\nthree\n");
  const bom = await repo.file("bom.txt");
  await repo.save("bom.txt", "a\nB\n", bom.version);
  assert.equal(await fs.readFile(root + "/bom.txt", "utf8"), "﻿a\r\nB\r\n");
});
test("Saves keep symlinks, NFC references find NFD names, big text is not binary, and labels name the real base", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-p3-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "user.name=T",
        "-c",
        "user.email=t@localhost",
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  git("init", "-b", "main");
  await fs.writeFile(root + "/a.txt", "a\n");
  await fs.symlink("a.txt", root + "/link");
  await fs.writeFile(root + "/Việt.txt", "x\n");
  git("add", ".");
  git("commit", "-m", "init");
  await fs.writeFile(root + "/big.txt", ("a".repeat(99) + "\n").repeat(30000));
  const repo = new Repository(root),
    link = await repo.file("link");
  await repo.save("link", "b\n", link.version);
  assert((await fs.lstat(root + "/link")).isSymbolicLink());
  assert.equal(await fs.readFile(root + "/a.txt", "utf8"), "b\n");
  assert.deepEqual(await repo.locate("Việt.txt".normalize("NFC")), [
    "Việt.txt",
  ]);
  const big = (await repo.changes({ mode: "working" })).find(
    (f) => f.path === "big.txt",
  );
  assert.equal(big.binary, false);
  assert.equal(big.large, true);
  assert.equal((await repo.diff("big.txt", { mode: "working" })).kind, "large");
  const all = await repo.diff("a.txt", { mode: "all" });
  assert.equal(all.originalLabel, "main (merge base)");
  const direct = await repo.diff("a.txt", {
    mode: "all",
    base: "main",
    mergeBase: false,
  });
  assert.equal(direct.originalLabel, "main");
});
test("A Git read issued after a change never reuses a run that started before it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-coalesce-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  execFileSync("git", ["-C", root, "init", "-q"]);
  const repo = new Repository(root),
    read = repo.readChanges.bind(repo);
  await repo.info();
  let runs = 0;
  repo.readChanges = async (options) => {
    runs++;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return read(options);
  };
  const first = repo.changes({ mode: "working" }),
    twin = repo.changes({ mode: "working" });
  await new Promise((resolve) => setTimeout(resolve, 280));
  await fs.writeFile(root + "/new.txt", "x\n");
  assert.equal(runs, 1);
  const late = repo.changes({ mode: "working" });
  await Promise.all([first, twin]);
  assert((await late).some((f) => f.path === "new.txt"));
  assert.equal(runs, 2);
});
