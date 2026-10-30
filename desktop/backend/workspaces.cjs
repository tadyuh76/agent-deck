const fs = require("fs/promises"),
  path = require("path"),
  { createHash, randomUUID } = require("crypto");
const { Repository } = require("./repository.cjs");
const { localPath, fileReference } = require("./local-paths.cjs");
class Workspaces {
  constructor({ defaults = {}, file, run, tmux }) {
    Object.assign(this, { defaults, file, run, tmux });
    this.entries = new Map();
    this.byPath = new Map();
    this.repos = new Map();
    this.adding = new Map();
    this.discoveryAt = 0;
    // Saved folders that are offline now (unmounted drive, renamed folder)
    // stay in the saved list until they come back.
    this.missing = new Set();
  }
  async initialize() {
    await Promise.all(
      Object.entries(this.defaults).map(([id, folder]) =>
        this.add(folder, { id, pinned: true }).catch(() => {}),
      ),
    );
    let saved = [];
    if (this.file)
      try {
        saved = JSON.parse(await fs.readFile(this.file, "utf8"));
      } catch {}
    for (const item of Array.isArray(saved) ? saved : [])
      if (typeof item?.path === "string")
        await this.add(item.path, { pinned: true }).catch(() =>
          this.missing.add(item.path),
        );
    return this.list();
  }
  forget(id) {
    this.entries.delete(id);
    this.repos.delete(id);
    for (const [folder, key] of this.byPath)
      if (key === id) this.byPath.delete(folder);
  }
  writable(id) {
    this.repo(id);
    if (this.entries.get(id).referenceOnly)
      throw new Error(
        "Thư mục này chỉ mở để xem từ tham chiếu. Dùng Mở thư mục… để cho phép sửa file.",
      );
    return this.repos.get(id);
  }
  repo(id) {
    const entry = this.entries.get(id);
    if (!entry)
      throw new Error(
        "Thư mục chưa được mở. Chọn Mở thư mục hoặc nhập đường dẫn.",
      );
    return this.repos.get(id);
  }
  list() {
    return [...this.entries.values()].map(
      ({ id, name, path, kind, branch, pinned, parent, available }) => ({
        id,
        name,
        path,
        kind,
        branch,
        pinned,
        parent,
        available,
      }),
    );
  }
  async save() {
    if (!this.file) return;
    // Each save writes the whole list; a unique temp file keeps concurrent
    // saves (pin + new worktree) from renaming each other's file away.
    const temp = this.file + "." + randomUUID() + ".tmp";
    const pinned = [...this.entries.values()]
      .filter((e) => e.pinned && !this.defaults[e.id])
      .map(({ path }) => path);
    for (const item of this.missing)
      if (!pinned.includes(item)) pinned.push(item);
    await fs.writeFile(temp, JSON.stringify(pinned.map((path) => ({ path }))), {
      mode: 0o600,
    });
    await fs.rename(temp, this.file);
  }
  async add(input, options = {}) {
    const absolute = localPath(input),
      real = await fs.realpath(absolute),
      stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new Error("Chọn một thư mục");
    // Several sessions and panels can share a cwd. Probe it once, then apply
    // each caller's pin/parent options to the same registry entry.
    const pending = this.adding.get(real);
    if (pending) {
      await pending;
      return this.addReal(real, options);
    }
    const task = this.addReal(real, options);
    this.adding.set(real, task);
    try {
      return await task;
    } finally {
      this.adding.delete(real);
    }
  }
  async addReal(real, { id, pinned = false, parent, kind, reference } = {}) {
    let key = this.byPath.get(real),
      repo = key ? this.repos.get(key) : new Repository(real);
    await repo.prepare();
    // Git status/diff paths are relative to the worktree root, not a nested cwd.
    const folder = repo.isGit ? await fs.realpath(repo.topLevel) : real;
    key =
      this.byPath.get(folder) ||
      id ||
      "folder-" +
        createHash("sha256").update(folder).digest("hex").slice(0, 16);
    let entry = this.entries.get(key);
    if (!entry) {
      if (folder !== real) repo = new Repository(folder);
      const info = await repo.info();
      entry = {
        id: key,
        name: path.basename(folder) || folder,
        path: folder,
        kind:
          kind ||
          (info.isWorktree ? "worktree" : info.isGit ? "repository" : "folder"),
        branch: info.branch || "",
        pinned,
        parent,
        available: true,
        // Folders registered only to preview a referenced file stay read-only.
        referenceOnly: !!reference && !pinned,
      };
      this.entries.set(key, entry);
      this.repos.set(key, repo);
      this.byPath.set(folder, key);
    } else {
      if (pinned) entry.pinned = true;
      if (!reference) entry.referenceOnly = false;
      // A main checkout listed by one of its worktrees keeps its own kind.
      if (entry.kind !== "repository" || kind !== "worktree") {
        if (parent) entry.parent = parent;
        if (kind) entry.kind = kind;
      }
      entry.available = true;
    }
    this.byPath.set(real, key);
    return entry;
  }
  async discover(force = false) {
    if (this.discovering) return this.discovering;
    if (!force && Date.now() - this.discoveryAt < 30000) return;
    this.discoveryAt = Date.now();
    this.discovering = (async () => {
      const seen = new Set();
      for (const folder of [...this.missing])
        await this.add(folder, { pinned: true })
          .then(() => this.missing.delete(folder))
          .catch(() => {});
      for (const entry of [...this.entries.values()]) {
        // A removed or renamed worktree folder is no longer usable.
        const present = await fs
          .stat(entry.path)
          .then((s) => s.isDirectory())
          .catch(() => false);
        if (!present) {
          entry.available = false;
          if (!entry.pinned && !this.defaults[entry.id]) this.forget(entry.id);
          continue;
        }
        entry.available = true;
        try {
          const info = await this.repo(entry.id).info(force);
          entry.branch = info.branch || "";
          if (!info.isGit || seen.has(info.commonDir)) continue;
          seen.add(info.commonDir);
          for (const worktree of info.worktrees) {
            if (worktree.path === entry.path) continue;
            const item = await this.add(
              worktree.path,
              worktree.main ? {} : { parent: entry.id, kind: "worktree" },
            ).catch(() => null);
            if (item) item.branch = worktree.branch || "Detached HEAD";
          }
        } catch {}
      }
    })().finally(() => {
      this.discovering = null;
    });
    return this.discovering;
  }
  // Every tmux session's current folder from one tmux call, instead of one
  // call per chat on each refresh.
  async livePaths() {
    try {
      const { stdout } = await this.run(
        this.tmux,
        [
          "-L",
          "agent-deck-managed",
          "list-sessions",
          "-F",
          "#{session_name}\t#{pane_current_path}",
        ],
        { encoding: "utf8", timeout: 3000, maxBuffer: 1024 * 1024 },
      );
      return new Map(
        stdout
          .split("\n")
          .map((line) => line.split("\t"))
          .filter(([name, folder]) => name && folder),
      );
    } catch {
      return null;
    }
  }
  async sessionContext(session, fallback, live) {
    let folder = session?.worktree_path || session?.path || fallback;
    if (
      session?.tmux_session &&
      /^agentdeck_[\w-]+$/.test(session.tmux_session) &&
      ["running", "waiting", "idle"].includes(session.status)
    ) {
      if (live) folder = live.get(session.tmux_session) || folder;
      else
        try {
          const result = await this.run(
            this.tmux,
            [
              "-L",
              "agent-deck-managed",
              "display-message",
              "-p",
              "-t",
              session.tmux_session,
              "#{pane_current_path}",
            ],
            { encoding: "utf8", timeout: 3000, maxBuffer: 16384 },
          );
          if (result.stdout.trim()) folder = result.stdout.trim();
        } catch {}
    }
    try {
      const entry = await this.add(folder);
      return {
        project: entry.id,
        workingPath: localPath(folder),
        root: entry.path,
      };
    } catch {
      return {
        project: this.byPath.get(
          localPath(fallback || Object.values(this.defaults)[0]),
        ),
        workingPath: folder,
      };
    }
  }
  async open(input, { project, pin = false } = {}) {
    const selected = this.entries.get(project),
      ref = fileReference(input, selected?.path),
      absolute = await fs.realpath(ref.absolute).catch(async (error) => {
        if (error.code !== "ENOENT" || !ref.relative || !selected) throw error;
        const relative = path.posix.relative(selected.path, ref.absolute);
        if (relative.startsWith("../")) throw error;
        const matches = await this.repo(project).locate(relative);
        if (matches.length !== 1) return { matches };
        return fs.realpath(path.join(selected.path, matches[0]));
      });
    if (absolute.matches)
      return {
        project,
        document: {
          kind: "choices",
          path: input,
          matches: absolute.matches.map((p) => ({
            path: p,
            reference: path.join(selected.path, p),
          })),
        },
      };
    const stat = await fs.stat(absolute);
    const entry = await this.add(
      stat.isDirectory() ? absolute : path.dirname(absolute),
      { pinned: pin && stat.isDirectory(), reference: !stat.isDirectory() },
    );
    if (pin && stat.isDirectory()) await this.save();
    if (stat.isDirectory()) {
      await this.discover(true);
      return { kind: "directory", project: entry.id };
    }
    const relative = path.relative(entry.path, absolute),
      document = await this.repo(entry.id).file(relative);
    return {
      project: entry.id,
      line: ref.line,
      document: {
        ...document,
        absolutePath: absolute,
        readOnly: !entry.pinned || !!entry.referenceOnly,
        external: entry.id !== project,
      },
    };
  }
}
module.exports = { Workspaces };
