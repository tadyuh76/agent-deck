const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs/promises"),
  os = require("os"),
  path = require("path"),
  { execFileSync, execFile } = require("child_process"),
  { promisify } = require("util");
const { Repository, parseWorktrees } = require("../backend/repository.cjs");
const { Workspaces } = require("../backend/workspaces.cjs");
const { localPath, fileReference } = require("../backend/local-paths.cjs");
const run = promisify(execFile);
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deck-workspaces-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "main");
  await fs.mkdir(root);
  const git = (...args) =>
    execFileSync(
      "/usr/bin/git",
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
  await fs.mkdir(root + "/src");
  await fs.writeFile(root + "/src/code.js", "initial\n");
  git("add", ".");
  git("commit", "-m", "init");
  return { dir, root, git };
}
test("Local paths resolve Windows drives, WSL UNC, file URLs and relative external references without confusing drive colons for lines", () => {
  assert.equal(localPath("S:\\Projects\\Web App"), "/mnt/s/Projects/Web App");
  assert.equal(
    localPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\alex"),
    "/home/alex",
  );
  assert.equal(
    localPath("file:///C:/Users/Some%20File.png"),
    "/mnt/c/Users/Some File.png",
  );
  assert.deepEqual(fileReference("C:\\Test\\a.ts:42", "/project"), {
    absolute: "/mnt/c/Test/a.ts",
    line: 42,
    relative: false,
  });
  assert.equal(
    fileReference("../other/a.ts", "/project").absolute,
    "/other/a.ts",
  );
  assert.throws(() => localPath("https://example.com"));
  assert.throws(() => localPath("\\\\wsl.localhost\\OtherDistro\\home"));
  assert.throws(() => localPath("C:relative"));
  assert.deepEqual(
    parseWorktrees(
      "worktree S:/Work/task\0HEAD abc\0branch refs/heads/feature\0\0worktree /home/me/task\0HEAD def\0detached\0\0",
      "/tmp",
    ).map((w) => [w.path, w.branch, w.detached]),
    [
      ["/mnt/s/Work/task", "feature", false],
      ["/home/me/task", "", true],
    ],
  );
});
test("Worktrees have isolated roots/diffs, live HEAD comparison, and branch switching cannot discard changes", async (t) => {
  const { dir, root, git } = await fixture(t),
    repo = new Repository(root),
    destination = dir + "/task";
  await fs.writeFile(root + "/src/code.js", "main draft\n");
  await repo.createWorktree({
    destination,
    branch: "task/one",
    base: "HEAD",
    create: true,
  });
  const task = new Repository(destination),
    info = await task.info();
  assert.equal(info.branch, "task/one");
  assert(info.isWorktree);
  assert.equal(info.repoRoot, destination);
  assert.equal((await repo.info(true)).worktrees.length, 2);
  assert.equal(
    await fs.readFile(destination + "/src/code.js", "utf8"),
    "initial\n",
  );
  await fs.writeFile(destination + "/src/code.js", "task version\n");
  assert.equal((await task.diff("src/code.js")).modified, "task version\n");
  assert.equal((await repo.diff("src/code.js")).modified, "main draft\n");
  await assert.rejects(repo.switchBranch("task/one"), /chưa commit/);
  assert.equal(
    await fs.readFile(root + "/src/code.js", "utf8"),
    "main draft\n",
  );
  await assert.rejects(
    repo.createWorktree({ destination, branch: "other" }),
    /đã tồn tại/,
  );
  await assert.rejects(
    repo.createWorktree({ destination: dir + "/bad", branch: "--bad" }),
    /không hợp lệ/,
  );
  git("checkout", "--", "src/code.js");
  git("branch", "second");
  await repo.switchBranch("second");
  assert.equal((await repo.info(true)).branch, "second");
  git("commit", "--allow-empty", "-m", "second");
  assert.equal(
    (
      await repo.diff("src/code.js", {
        mode: "branches",
        base: "main",
        target: "HEAD",
      })
    ).modified,
    "initial\n",
  );
});
test("Workspace registry discovers worktrees and follows the live session cwd; nested folders map to the right Git root", async (t) => {
  const { dir, root } = await fixture(t),
    task = dir + "/task";
  await new Repository(root).createWorktree({
    destination: task,
    branch: "task",
  });
  const catalog = new Workspaces({
    defaults: { web: root },
    file: dir + "/catalog.json",
    tmux: "/tmux",
    run: async () => ({ stdout: task + "/src\n" }),
  });
  await catalog.initialize();
  await catalog.discover(true);
  assert.equal(catalog.list().length, 2);
  const context = await catalog.sessionContext(
    { path: root, status: "waiting", tmux_session: "agentdeck_fixture" },
    root,
  );
  assert.equal(catalog.repo(context.project).root, task);
  assert.equal(context.workingPath, task + "/src");
  assert.equal((await catalog.repo(context.project).info()).branch, "task");
  const opened = await catalog.open("src/code.js", {
    project: context.project,
  });
  assert.equal(opened.document.text, "initial\n");
  assert.equal(opened.project, context.project);
});
test("Concurrent sessions in one folder share a registry entry and one Git metadata load", async (t) => {
  const { dir, root } = await fixture(t),
    catalog = new Workspaces({ defaults: {}, run, tmux: "/usr/bin/tmux" }),
    original = Repository.prototype.loadInfo;
  let loads = 0;
  Repository.prototype.loadInfo = function (...args) {
    if (this.root === root) loads++;
    return original.apply(this, args);
  };
  t.after(() => {
    Repository.prototype.loadInfo = original;
  });
  const entries = await Promise.all(
    Array.from({ length: 12 }, (_, n) =>
      catalog.add(root, { pinned: n === 11 }),
    ),
  );
  assert.equal(catalog.list().length, 1);
  assert(entries.every((entry) => entry === entries[0]));
  assert(entries[0].pinned);
  assert.equal(loads, 1);
  const repo = catalog.repo(entries[0].id);
  await Promise.all(Array.from({ length: 12 }, () => repo.info(true)));
  assert.equal(loads, 2);
  // A failed registration cannot poison subsequent attempts for this path.
  await assert.rejects(catalog.add(dir + "/missing"), { code: "ENOENT" });
  await fs.mkdir(dir + "/missing");
  assert(await catalog.add(dir + "/missing"));
});
test("External text, images, symlinks and non-Git folders preview across scopes; pinned folders survive restart", async (t) => {
  const { dir, root } = await fixture(t),
    external = dir + "/outside";
  await fs.mkdir(external);
  await fs.writeFile(external + "/notes.md", "outside project\n");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await fs.writeFile(external + "/image.png", png);
  const catalog = new Workspaces({
    defaults: { web: root },
    file: dir + "/catalog.json",
    run,
    tmux: "/usr/bin/tmux",
  });
  await catalog.initialize();
  const doc = await catalog.open("../outside/notes.md", { project: "web" });
  assert.equal(doc.document.kind, "file");
  assert.equal(doc.document.text, "outside project\n");
  assert(doc.document.readOnly);
  assert.equal(doc.document.absolutePath, external + "/notes.md");
  const image = await catalog.open(external + "/image.png", { project: "web" });
  assert.equal(image.document.kind, "image");
  await fs.symlink(external + "/notes.md", root + "/linked.md");
  assert.equal(
    (await catalog.open("linked.md", { project: "web" })).document.text,
    "outside project\n",
  );
  assert.equal((await catalog.repo(doc.project).info()).isGit, false);
  assert.deepEqual(await catalog.repo(doc.project).changes(), []);
  await catalog.open(external, { pin: true });
  const restored = new Workspaces({
    defaults: { web: root },
    file: dir + "/catalog.json",
    run,
    tmux: "/usr/bin/tmux",
  });
  await restored.initialize();
  assert(restored.list().some((e) => e.path === external && e.pinned));
  assert.equal((await restored.repo(doc.project).tree()).length, 2);
});
test("Mixed Git Windows / WSL worktrees on a Windows drive choose a readable engine without repairing or pruning metadata", async (t) => {
  const native = "/mnt/c/Program Files/Git/cmd/git.exe";
  if (!(await fs.stat(native).catch(() => null)))
    return t.skip("Git Windows unavailable");
  // The Windows user's temp folder, so both Git engines can reach it.
  let temp;
  try {
    const windowsTemp = execFileSync(
      "/mnt/c/Windows/System32/cmd.exe",
      ["/d", "/c", "echo %TEMP%"],
      { cwd: "/mnt/c", encoding: "utf8" },
    ).trim();
    temp = execFileSync("/usr/bin/wslpath", ["-u", windowsTemp], {
      encoding: "utf8",
    }).trim();
  } catch {
    return t.skip("Windows temp folder unavailable");
  }
  const dir = await fs.mkdtemp(temp + "/deck-mixed-worktree-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = dir + "/main";
  await fs.mkdir(root);
  const win = (p) =>
    execFileSync("/usr/bin/wslpath", ["-w", p], { encoding: "utf8" }).trim();
  const git = (bin, ...args) =>
    execFileSync(
      bin,
      [
        "-C",
        bin === native ? win(root) : root,
        "-c",
        "safe.directory=" + (bin === native ? win(root) : root),
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  git(native, "init", "-b", "main");
  await fs.writeFile(root + "/file.txt", "base\n");
  git(native, "add", ".");
  git(native, "commit", "-m", "base");
  const first = new Repository(root);
  await first.createWorktree({
    destination: dir + "/windows-task",
    branch: "windows-task",
  });
  git(
    "/usr/bin/git",
    "worktree",
    "add",
    "-b",
    "linux-task",
    dir + "/linux-task",
    "HEAD",
  );
  const windowsRepo = new Repository(dir + "/windows-task"),
    linuxRepo = new Repository(dir + "/linux-task");
  assert.equal((await windowsRepo.info()).branch, "windows-task");
  assert(windowsRepo.gitBin.endsWith("git.exe"));
  assert.equal((await linuxRepo.info()).branch, "linux-task");
  assert.equal(linuxRepo.gitBin, "/usr/bin/git");
  const bridge = require.resolve("../backend/git-agent-bridge.cjs");
  const bridged = (...args) =>
    execFileSync(
      process.execPath,
      [bridge, "-C", dir + "/windows-task", ...args],
      {
        env: { ...process.env, GIT_DIR: "", GIT_WORK_TREE: "" },
        encoding: "utf8",
      },
    ).trim();
  assert.equal(bridged("rev-parse", "--show-toplevel"), dir + "/windows-task");
  await fs.writeFile(dir + "/windows-task/file.txt", "Windows worktree task\n");
  assert(bridged("diff", "--", "file.txt").includes("+Windows worktree task"));
  assert.equal(await fs.readFile(root + "/file.txt", "utf8"), "base\n");
  // init creates its own repository instead of re-initialising the worktree.
  bridged("init", "-q", "nested");
  assert((await fs.stat(dir + "/windows-task/nested/.git")).isDirectory());
  const catalog = new Workspaces({
    defaults: { web: root },
    run,
    tmux: "/usr/bin/tmux",
  });
  await catalog.initialize();
  await catalog.discover(true);
  assert.equal(catalog.list().length, 3);
});
test("Discovery from a worktree keeps the main checkout a repository, and offline pins survive a save", async (t) => {
  const { dir, root, git } = await fixture(t),
    task = dir + "/task",
    file = dir + "/pins.json";
  git("worktree", "add", "-b", "task", task);
  await fs.writeFile(file, JSON.stringify([{ path: dir + "/offline" }]));
  const workspaces = new Workspaces({ file, run, tmux: "/bin/false" });
  await workspaces.initialize();
  await workspaces.add(task);
  await workspaces.add(root, { pinned: true });
  await workspaces.discover(true);
  const main = workspaces.list().find((e) => e.path === root);
  assert.equal(main.kind, "repository");
  assert.equal(main.parent, undefined);
  await workspaces.save();
  const saved = JSON.parse(await fs.readFile(file, "utf8")).map((e) => e.path);
  assert(saved.includes(dir + "/offline"));
  assert(saved.includes(root));
});
test("A folder opened only to preview a referenced file cannot be saved into", async (t) => {
  const { dir } = await fixture(t);
  await fs.mkdir(dir + "/outside");
  await fs.writeFile(dir + "/outside/o.txt", "keep\n");
  const workspaces = new Workspaces({ run, tmux: "/bin/false" }),
    opened = await workspaces.open(dir + "/outside/o.txt");
  assert.equal(opened.document.readOnly, true);
  assert.throws(() => workspaces.writable(opened.project), /chỉ mở để xem/);
  await workspaces.open(dir + "/outside", { pin: true });
  assert(workspaces.writable(opened.project));
});
test("A removed worktree leaves the list, while a pinned missing folder is marked unavailable", async (t) => {
  const { dir, root, git } = await fixture(t),
    task = dir + "/gone",
    pinned = dir + "/pinned";
  git("worktree", "add", "-b", "gone", task);
  await fs.mkdir(pinned);
  const workspaces = new Workspaces({ run, tmux: "/bin/false" });
  await workspaces.add(root, { pinned: true });
  await workspaces.add(pinned, { pinned: true });
  await workspaces.discover(true);
  assert(workspaces.list().some((e) => e.path === task));
  await fs.rm(task, { recursive: true, force: true });
  await fs.rm(pinned, { recursive: true, force: true });
  await workspaces.discover(true);
  assert(!workspaces.list().some((e) => e.path === task));
  assert.equal(
    workspaces.list().find((e) => e.path === pinned).available,
    false,
  );
});
