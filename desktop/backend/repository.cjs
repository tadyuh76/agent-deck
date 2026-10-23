const fs = require("fs/promises"),
  fsSync = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  { execFile, execFileSync } = require("child_process"),
  { promisify } = require("util");
const run = promisify(execFile),
  MAX = 2 * 1024 * 1024;
const { localPath } = require("./local-paths.cjs");
const ignored = new Set([
  ".git",
  "node_modules",
  ".next",
  ".dart_tool",
  "build",
  ".gradle",
  ".turbo",
  ".cache",
  "coverage",
]);
const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
const IMAGE_MAX = 20 * 1024 * 1024;
function imageMime(data) {
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255)
    return "image/jpeg";
  if (/^GIF8[79]a/.test(data.toString("ascii", 0, 6))) return "image/gif";
  if (
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (data.toString("ascii", 0, 2) === "BM") return "image/bmp";
}
function preview(data, relative) {
  const mime = imageMime(data);
  if (mime)
    return {
      kind: "image",
      path: relative,
      mime,
      bytes: data.length,
      src: `data:${mime};base64,${data.toString("base64")}`,
    };
  if (data.includes(0))
    return { kind: "binary", path: relative, bytes: data.length };
  if (data.length > MAX) throw new Error("File exceeds the 2 MB editor limit");
  const text = data.toString("utf8");
  return {
    kind: "file",
    path: relative,
    text,
    version: digest(data),
    // Saving decoded text would replace legacy-encoded bytes with U+FFFD.
    ...(isUtf8(data, text)
      ? {}
      : { readOnly: true, notice: "File không phải UTF-8 nên chỉ xem." }),
  };
}
function isUtf8(data, text = data.toString("utf8")) {
  return Buffer.from(text, "utf8").equals(data);
}
const BOM = "\uFEFF";
function matchFormat(text, current) {
  // The editor drops a UTF-8 BOM and may rewrite line endings; keep the
  // file's own convention when it uses one consistently.
  const old = current.toString("utf8");
  let next = text;
  if (old.startsWith(BOM) && !next.startsWith(BOM)) next = BOM + next;
  if (old.includes("\r\n") && !/(^|[^\r])\n/.test(old))
    next = next.replace(/\r?\n/g, "\r\n");
  return next;
}
function sameEndings(original, modified) {
  // Git stores LF while a Windows checkout has CRLF; compare like with like
  // so only edited lines show as changed.
  const crlf = (text) => text.includes("\r\n");
  if (crlf(original) === crlf(modified)) return [original, modified];
  const lf = (text) => text.replace(/\r\n/g, "\n");
  return [lf(original), lf(modified)];
}
// Concurrent identical reads share one Git run, but only one that has just
// started: a caller arriving later (after a save or checkout) waits for a
// single fresh run, shared with any other late callers.
function coalesce(store, key, load) {
  const entry = store.get(key),
    now = Date.now();
  if (entry && now - entry.started < 250) return entry.task;
  if (entry)
    return (entry.next ??= entry.task
      .catch(() => {})
      .then(() => coalesce(store, key, load)));
  const fresh = { started: now };
  fresh.task = load().finally(() => {
    if (store.get(key) === fresh) store.delete(key);
  });
  store.set(key, fresh);
  return fresh.task;
}
function parseNames(output) {
  const parts = output.split("\0"),
    files = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (!status) continue;
    const name = parts[++i];
    if (/^[RC]/.test(status))
      files.push({ path: parts[++i], oldPath: name, status: status[0] });
    else files.push({ path: name, status: status[0] });
  }
  return files;
}
function parseStats(output) {
  const parts = output.split("\0"),
    stats = new Map();
  for (let i = 0; i < parts.length; i++) {
    const row = parts[i];
    if (!row) continue;
    const match = /^([^\t]+)\t([^\t]+)\t([\s\S]*)$/.exec(row);
    if (!match) continue;
    let name = match[3];
    if (!name) {
      i++;
      name = parts[++i];
    }
    stats.set(name, {
      added: match[1] === "-" ? null : Number(match[1]),
      removed: match[2] === "-" ? null : Number(match[2]),
      binary: match[1] === "-",
    });
  }
  return stats;
}
class Repository {
  constructor(root) {
    this.root = path.resolve(root);
    this.infoAt = 0;
    this.gitBin = "/usr/bin/git";
    this.gitRoot = this.root;
    const native = "/mnt/c/Program Files/Git/cmd/git.exe";
    if (/^\/mnt\/[a-z]\//.test(this.root) && fsSync.existsSync(native)) {
      this.gitBin = native;
      this.gitRoot = execFileSync("/usr/bin/wslpath", ["-w", this.root], {
        encoding: "utf8",
      }).trim();
    }
  }
  async prepare() {
    if (this.isGit === false && Date.now() - (this.preparedAt || 0) > 10000)
      this.preparing = null;
    if (this.preparing) return this.preparing;
    this.preparing = (async () => {
      this.preparedAt = Date.now();
      // A Windows worktree's .git file contains a drive path; a WSL worktree
      // contains /mnt or /home paths. Choose the engine that can resolve it.
      const candidates = [
        { bin: this.gitBin, root: this.gitRoot },
        ...(this.gitBin !== "/usr/bin/git"
          ? [{ bin: "/usr/bin/git", root: this.root }]
          : []),
      ];
      for (const candidate of candidates)
        try {
          const result = await this.invoke(candidate.bin, candidate.root, [
            "rev-parse",
            "--show-toplevel",
          ]);
          this.gitBin = candidate.bin;
          this.gitRoot = candidate.root;
          this.topLevel = localPath(result.trim(), this.root);
          this.isGit = true;
          return;
        } catch {}
      this.isGit = false;
    })();
    return this.preparing;
  }
  invoke(bin, root, args, raw = false) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" };
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_PREFIX",
      "GIT_EXTERNAL_DIFF",
    ])
      delete env[key];
    return run(
      bin,
      [
        "--no-optional-locks",
        "-c",
        "safe.directory=" + root,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "diff.external=",
        "-c",
        "color.ui=false",
        "-C",
        root,
        ...args,
      ],
      {
        encoding: raw ? null : "utf8",
        timeout: args[0] === "worktree" && args[1] === "add" ? 120000 : 30000,
        maxBuffer: 24 * 1024 * 1024,
        env,
      },
    ).then((r) => r.stdout);
  }
  async git(args, optional = false, raw = false) {
    try {
      await this.prepare();
      if (!this.isGit) throw new Error("Thư mục này không phải Git repository");
      return await this.invoke(this.gitBin, this.gitRoot, args, raw);
    } catch (error) {
      if (optional) return raw ? Buffer.alloc(0) : "";
      throw new Error((error.stderr || error.message).trim().slice(0, 500));
    }
  }
  async safe(relative, exists = true) {
    if (
      typeof relative !== "string" ||
      relative.includes("\0") ||
      path.isAbsolute(relative)
    )
      throw new Error("Invalid file path");
    const target = path.resolve(this.root, relative);
    if (target !== this.root && !target.startsWith(this.root + path.sep))
      throw new Error("File must stay inside the selected project");
    let ancestor = exists ? target : path.dirname(target),
      actual;
    while (true) {
      try {
        actual = await fs.realpath(ancestor);
        break;
      } catch (error) {
        if (exists || error.code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    const root = await fs.realpath(this.root);
    if (actual !== root && !actual.startsWith(root + path.sep))
      throw new Error("External symbolic links cannot be opened");
    return target;
  }
  async info(force = false) {
    this.infoLoads ??= new Map();
    if (!force && Date.now() - this.infoAt < 2000 && this.cachedInfo)
      return this.cachedInfo;
    const running = this.infoLoads.get("info");
    if (!force && running) return running.task;
    if (force) this.infoAt = 0;
    return coalesce(this.infoLoads, "info", () => this.loadInfo());
  }
  async loadInfo() {
    await this.prepare();
    if (!this.isGit)
      return {
        isGit: false,
        branch: "",
        branches: [],
        defaultBase: "HEAD",
        root: this.root,
        worktrees: [],
      };
    // Four git runs instead of eight: one for-each-ref lists local and remote
    // branches with origin's default, and the git folders never change for a
    // checkout, so they are read once.
    this.gitDirs ??= this.git(
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--absolute-git-dir",
      ],
      true,
    ).then((out) => {
      const [common = "", gitdir = ""] = out.trim().split(/\r?\n/);
      if (!common) this.gitDirs = null;
      return { common, gitdir };
    });
    const [branch, refs, head, worktrees, { common, gitdir }] =
      await Promise.all([
        this.git(["branch", "--show-current"], true),
        this.git(
          [
            "for-each-ref",
            "--format=%(refname)%00%(refname:short)%00%(symref:short)",
            "refs/heads",
            "refs/remotes",
          ],
          true,
        ),
        this.git(["rev-parse", "--verify", "HEAD"], true),
        this.git(["worktree", "list", "--porcelain", "-z"], true),
        this.gitDirs,
      ]);
    const rows = refs
      .split("\n")
      .map((line) => line.trim().split("\0"))
      .filter(([name, short]) => name && short);
    const branches = rows
      .filter(([name]) => !name.endsWith("/HEAD"))
      .map(([, short]) => short);
    const locals = rows
      .filter(([name]) => name.startsWith("refs/heads/"))
      .map(([, short]) => short);
    const origin =
      rows.find(([name]) => name === "refs/remotes/origin/HEAD")?.[2] || "";
    const preferred =
      origin.replace(/\/HEAD$/, "") ||
      branches.find(
        (x) =>
          x === "main" ||
          x === "master" ||
          x === "origin/main" ||
          x === "origin/master",
      ) ||
      branch.trim();
    this.cachedInfo = {
      branch: branch.trim() || "Detached HEAD",
      branches,
      localBranches: locals,
      defaultBase: preferred || "HEAD",
      root: this.root,
      isGit: true,
      head: head.trim(),
      repoRoot: this.topLevel,
      isWorktree:
        !!common.trim() &&
        localPath(common.trim(), this.root) !==
          localPath(gitdir.trim(), this.root),
      commonDir: common.trim() ? localPath(common.trim(), this.root) : null,
      worktrees: parseWorktrees(worktrees, this.root),
    };
    this.infoAt = Date.now();
    return this.cachedInfo;
  }
  async revisions(options) {
    const info = await this.info();
    const valid = (ref) => ref === "HEAD" || info.branches.includes(ref);
    const base = options.base || info.defaultBase,
      target = options.target || "HEAD";
    if (!valid(base) || !valid(target))
      throw new Error("Select valid branch names");
    return { base, target };
  }
  async tree(relative = "") {
    const target = await this.safe(relative);
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries
      .filter((e) => !ignored.has(e.name) && !e.isSymbolicLink())
      .map((e) => ({
        name: e.name,
        path: path.posix.join(relative, e.name),
        directory: e.isDirectory(),
      }))
      .sort(
        (a, b) =>
          Number(b.directory) - Number(a.directory) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, 2000);
  }
  async file(relative) {
    const target = await this.safe(relative);
    const stat = await fs.stat(target);
    if (!stat.isFile()) throw new Error("Select a file");
    if (stat.size > IMAGE_MAX)
      throw new Error("File exceeds the 20 MB preview limit");
    const data = await fs.readFile(target);
    return preview(data, relative);
  }
  async locate(relative) {
    try {
      await this.safe(relative);
      return [relative];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!this.pathIndex || Date.now() - this.pathIndexAt > 10000) {
      this.pathIndex = (
        await this.git([
          "ls-files",
          "--cached",
          "--others",
          "-z",
          ...[...ignored, ".worktrees"].flatMap((name) => [
            "--exclude=" + name + "/**",
            "--exclude=**/" + name + "/**",
          ]),
        ])
      )
        .split("\0")
        .filter(Boolean);
      this.pathIndexAt = Date.now();
    }
    // Names from macOS archives are often NFD while chat text is NFC.
    const wanted = relative.normalize("NFC");
    const matches = [
      ...new Set(
        this.pathIndex.filter((name) => {
          const value = name.normalize("NFC");
          return value === wanted || value.endsWith("/" + wanted);
        }),
      ),
    ];
    if (!matches.length)
      throw new Error("Không tìm thấy file trong dự án: " + relative);
    return matches.slice(0, 50);
  }
  async save(relative, text, version) {
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX)
      throw new Error("File exceeds the 2 MB editor limit");
    // safe() already rejects links leaving the project; write through a link
    // to its file so the link itself survives the rename below.
    const target = await fs.realpath(await this.safe(relative));
    const current = await fs.readFile(target);
    if (current.includes(0) || imageMime(current))
      throw new Error("Binary files cannot be edited as text");
    if (!isUtf8(current))
      throw new Error(
        "File không phải UTF-8. Không lưu để tránh làm hỏng ký tự.",
      );
    if (digest(current) !== version)
      throw new Error(
        "File changed on disk. Reopen it before saving to keep the agent’s edits.",
      );
    const stat = await fs.stat(target),
      temp = target + ".agent-deck-" + crypto.randomUUID();
    text = matchFormat(text, current);
    try {
      await fs.writeFile(temp, text, { mode: stat.mode & 0o777, flag: "wx" });
      if (digest(await fs.readFile(target)) !== version)
        throw new Error("File changed on disk while saving. Reopen it first.");
      await fs.rename(temp, target);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
    return { path: relative, text, version: digest(text) };
  }
  async changes(options = {}) {
    this.pendingChanges ??= new Map();
    return coalesce(this.pendingChanges, JSON.stringify(options), () =>
      this.readChanges(options),
    );
  }
  async commitRange(commit) {
    if (typeof commit !== "string" || !/^[a-f\d]{7,64}$/i.test(commit))
      throw new Error("Chọn một commit hợp lệ");
    const oid = (
      await this.git(["rev-parse", "--verify", commit + "^{commit}"])
    ).trim();
    const parents = (await this.git(["rev-list", "--parents", "-n", "1", oid]))
      .trim()
      .split(/\s+/);
    return { oid, parent: parents[1] || null };
  }
  async commits({
    target = "HEAD",
    base,
    search = "",
    skip = 0,
    limit = 80,
  } = {}) {
    const info = await this.info();
    if (!info.isGit || !info.head)
      return { commits: [], total: 0, hasMore: false };
    if (!["HEAD", ...info.branches].includes(target))
      throw new Error("Chọn branch hợp lệ");
    search = String(search).trim().slice(0, 200);
    skip = Math.max(0, Math.min(100000, Number(skip) || 0));
    limit = Math.max(1, Math.min(100, Number(limit) || 80));
    const filter = search
      ? ["--fixed-strings", "--regexp-ignore-case", "--grep=" + search]
      : [];
    // Pin both queries to the same HEAD so a concurrent commit cannot reorder pagination.
    const head = (
      await this.git(["rev-parse", "--verify", target + "^{commit}"])
    ).trim();
    if (base && !["HEAD", ...info.branches].includes(base))
      throw new Error("Chọn branch gốc hợp lệ");
    const baseline =
      base && base !== "HEAD"
        ? (await this.git(["merge-base", base, head], true)).trim()
        : "";
    const range = baseline ? baseline + ".." + head : head;
    const [output, count] = await Promise.all([
      this.git([
        "log",
        "--no-show-signature",
        "--date-order",
        "--format=%H%x00%h%x00%P%x00%s%x00%an%x00%aI%x00",
        "--max-count=" + (limit + 1),
        "--skip=" + skip,
        ...filter,
        range,
        "--",
      ]),
      this.git(["rev-list", "--count", ...filter, range, "--"]),
    ]);
    const parts = output.split("\0"),
      commits = [];
    for (let i = 0; i + 5 < parts.length; i += 6) {
      const hash = parts[i].trim();
      if (!hash) continue;
      commits.push({
        hash,
        short: parts[i + 1],
        parents: parts[i + 2].split(" ").filter(Boolean),
        subject: parts[i + 3],
        author: parts[i + 4],
        date: parts[i + 5],
      });
    }
    // A pasted SHA is also a useful way to find a commit, including one outside HEAD's history.
    if (search && /^[a-f\d]{7,64}$/i.test(search) && !skip) {
      try {
        const { oid } = await this.commitRange(search);
        const row = (
          await this.git([
            "show",
            "-s",
            "--format=%H%x00%h%x00%P%x00%s%x00%an%x00%aI",
            oid,
          ])
        )
          .trimEnd()
          .split("\0");
        return {
          commits: [
            {
              hash: row[0],
              short: row[1],
              parents: row[2].split(" ").filter(Boolean),
              subject: row[3],
              author: row[4],
              date: row[5],
            },
          ],
          total: 1,
          hasMore: false,
          head,
        };
      } catch {}
    }
    return {
      commits: commits.slice(0, limit),
      total: Number(count) || 0,
      hasMore: commits.length > limit,
      head,
    };
  }
  async readChanges(options = {}) {
    await this.prepare();
    if (!this.isGit) return [];
    const mode =
      options.mode === "all" && !(await this.info()).head
        ? "working"
        : options.mode || "working";
    let output,
      files,
      range = [],
      command = "diff";
    const flags = [
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      ...(options.ignoreWhitespace ? ["-w"] : []),
    ];
    if (mode === "working") {
      output = await this.git([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      const parts = output.split("\0"),
        entries = [];
      for (let i = 0; i < parts.length; i++) {
        const row = parts[i];
        if (!row) continue;
        const status = row.slice(0, 2),
          name = row.slice(3);
        const oldPath = /R|C/.test(status) ? parts[++i] : undefined;
        entries.push({ path: name, oldPath, status: status.trim() || "M" });
      }
      files = entries;
      range = (await this.info()).head ? ["HEAD"] : [];
    } else {
      range =
        mode === "staged"
          ? ["--cached"]
          : mode === "unstaged"
            ? []
            : mode === "commit"
              ? await this.commitRange(options.commit).then(
                  ({ oid, parent }) => {
                    if (parent) return [parent, oid];
                    command = "diff-tree";
                    return ["--root", "--no-commit-id", "-r", oid];
                  },
                )
              : mode === "all"
                ? [await this.comparisonBase(options)]
                : await this.range(options);
      files = parseNames(
        await this.git([command, "--name-status", "-z", ...flags, ...range]),
      );
      if (mode === "unstaged" || mode === "all") {
        const untracked = (
          await this.git(["ls-files", "--others", "--exclude-standard", "-z"])
        )
          .split("\0")
          .filter(Boolean);
        files.push(...untracked.map((path) => ({ path, status: "??" })));
      }
    }
    const stats = parseStats(
      await this.git([command, "--numstat", "-z", ...flags, ...range]),
    );
    const result = [];
    // Bounded batches keep large asset directories responsive without launching one Git process per file.
    for (let i = 0; i < files.length; i += 12) {
      result.push(
        ...(await Promise.all(
          files.slice(i, i + 12).map(async (file) => {
            let stat = stats.get(file.path) || {
              added: 0,
              removed: 0,
              binary: false,
            };
            if (file.status === "??") {
              try {
                const target = await this.safe(file.path),
                  info = await fs.stat(target);
                if (
                  /\.(png|jpe?g|gif|webp|ico|zip|pdf|woff2?|ttf|mp[34]|mov)$/i.test(
                    file.path,
                  )
                )
                  stat = { added: null, removed: null, binary: true };
                else if (info.size > MAX)
                  // Too large to count here; not necessarily binary.
                  stat = {
                    added: null,
                    removed: null,
                    binary: false,
                    large: true,
                  };
                else {
                  const data = await fs.readFile(target);
                  stat = data.includes(0)
                    ? { added: null, removed: null, binary: true }
                    : {
                        added: data.length
                          ? data.toString("utf8").split("\n").length -
                            (data[data.length - 1] === 10 ? 1 : 0)
                          : 0,
                        removed: 0,
                        binary: false,
                      };
                }
              } catch {
                stat = { added: null, removed: null, binary: true };
              }
            }
            return { ...file, ...stat };
          }),
        )),
      );
    }
    return result
      .filter(
        (f) =>
          !options.ignoreWhitespace ||
          !/^M+$/.test(f.status) ||
          f.binary ||
          f.added ||
          f.removed,
      )
      .sort(
        (a, b) =>
          Number(/(^|\/)(__MACOSX|\._|\.DS_Store)/.test(a.path)) -
            Number(/(^|\/)(__MACOSX|\._|\.DS_Store)/.test(b.path)) ||
          Number(a.path.includes("/")) - Number(b.path.includes("/")) ||
          a.path.localeCompare(b.path),
      );
  }
  async range(options) {
    const { base, target } = await this.revisions(options);
    return [base + (options.mergeBase === false ? ".." : "...") + target];
  }
  async comparisonBase(options) {
    const { base } = await this.revisions({ ...options, target: "HEAD" });
    return options.mergeBase === false
      ? base
      : (await this.git(["merge-base", base, "HEAD"])).trim();
  }
  async blob(ref, relative) {
    if (!relative || relative.includes("\0"))
      throw new Error("Invalid file path");
    const object = ref + ":" + relative,
      size = (await this.git(["cat-file", "-s", object], true)).trim();
    if (!size) return Buffer.alloc(0);
    if (Number(size) > IMAGE_MAX)
      throw new Error("Diff exceeds the 20 MB preview limit");
    return this.git(["show", object], false, true);
  }
  async diff(relative, options = {}) {
    await this.safe(relative, false);
    const mode =
        options.mode === "all" && !(await this.info()).head
          ? "working"
          : options.mode || "working",
      oldPath = options.oldPath || relative;
    await this.safe(oldPath, false);
    let original = Buffer.alloc(0),
      modified = Buffer.alloc(0),
      originalLabel = "HEAD",
      modifiedLabel = "Working tree";
    if (mode === "working" || mode === "unstaged" || mode === "all") {
      const baseline =
        mode === "all"
          ? await this.comparisonBase(options)
          : mode === "unstaged"
            ? ""
            : "HEAD";
      const base = options.base || (await this.info()).defaultBase;
      originalLabel =
        mode === "all"
          ? options.mergeBase === false
            ? base
            : base + " (merge base)"
          : mode === "unstaged"
            ? "Index (đã stage)"
            : "HEAD";
      original = await this.blob(baseline, oldPath);
      try {
        const target = await this.safe(relative);
        if ((await fs.stat(target)).size > IMAGE_MAX)
          throw new Error("File exceeds the 20 MB preview limit");
        modified = await fs.readFile(target);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    } else if (mode === "staged") {
      original = await this.blob("HEAD", oldPath);
      modified = await this.blob("", relative);
      modifiedLabel = "Index";
    } else if (mode === "commit") {
      const { oid, parent } = await this.commitRange(options.commit);
      original = parent ? await this.blob(parent, oldPath) : Buffer.alloc(0);
      modified = await this.blob(oid, relative);
      originalLabel = parent ? parent.slice(0, 9) : "Empty tree";
      modifiedLabel = oid.slice(0, 9);
    } else {
      const { base, target } = await this.revisions(options);
      let comparison = base;
      if (options.mergeBase !== false)
        comparison = (await this.git(["merge-base", base, target])).trim();
      original = await this.blob(comparison, oldPath);
      modified = await this.blob(target, relative);
      originalLabel =
        options.mergeBase === false ? base : base + " (merge base)";
      modifiedLabel = target;
    }
    const common = {
      path: relative,
      originalLabel,
      modifiedLabel,
      revision: digest(Buffer.concat([original, Buffer.from([0]), modified])),
    };
    let before, after;
    try {
      before = preview(original, oldPath);
      after = preview(modified, relative);
    } catch (error) {
      // Text over the editor limit gets a notice, not a failed diff.
      if (!/2 MB/.test(error.message)) throw error;
      return {
        ...common,
        kind: "large",
        bytes: Math.max(original.length, modified.length),
      };
    }
    if (before.kind === "image" || after.kind === "image")
      return { ...common, kind: "image-diff", before, after };
    if (before.kind === "binary" || after.kind === "binary")
      return { ...common, kind: "binary", bytes: modified.length };
    const [left, right] = sameEndings(before.text, after.text);
    return { ...common, kind: "diff", original: left, modified: right };
  }
  async createWorktree({ destination, branch, base = "HEAD", create = true }) {
    const info = await this.info(true);
    if (!info.isGit) throw new Error("Chọn Git repository trước");
    if (
      typeof branch !== "string" ||
      !branch ||
      branch.startsWith("-") ||
      branch.length > 200 ||
      /[\0\r\n]/.test(branch)
    )
      throw new Error("Tên branch không hợp lệ");
    await this.git(["check-ref-format", "--branch", branch]);
    const target = localPath(destination, this.root);
    if (
      target === this.root ||
      (await fs.lstat(target).then(
        () => true,
        (e) => {
          if (e.code === "ENOENT") return false;
          throw e;
        },
      ))
    )
      throw new Error("Thư mục đích đã tồn tại; chọn một thư mục mới");
    if (create && !["HEAD", ...info.branches].includes(base))
      throw new Error("Chọn branch gốc hợp lệ");
    if (!create && !info.localBranches.includes(branch))
      throw new Error("Chọn một branch local có sẵn");
    const native = this.gitBin.endsWith(".exe")
      ? execFileSync("/usr/bin/wslpath", ["-w", target], {
          encoding: "utf8",
        }).trim()
      : target;
    await this.git([
      "worktree",
      "add",
      ...(create ? ["-b", branch] : []),
      native,
      create ? base : branch,
    ]);
    this.infoAt = 0;
    return { path: target, branch };
  }
  async switchBranch(branch) {
    const info = await this.info(true);
    if (
      typeof branch !== "string" ||
      branch.startsWith("-") ||
      !info.localBranches.includes(branch)
    )
      throw new Error("Chọn branch local hợp lệ");
    const status = await this.git(["status", "--porcelain", "-z"]);
    if (status)
      throw new Error(
        "Thư mục còn thay đổi chưa commit. Dùng worktree riêng để giữ các task độc lập.",
      );
    await this.git(["switch", "--no-guess", branch]);
    this.infoAt = 0;
    return this.info(true);
  }
}
function parseWorktrees(output, base) {
  return output
    .split("\0\0")
    .filter(Boolean)
    .flatMap((record, index) => {
      const values = record.split("\0"),
        folder = values.find((v) => v.startsWith("worktree "))?.slice(9);
      if (!folder) return [];
      try {
        return [
          {
            path: localPath(folder, base),
            branch:
              values
                .find((v) => v.startsWith("branch "))
                ?.slice(7)
                .replace(/^refs\/heads\//, "") || "",
            head: values.find((v) => v.startsWith("HEAD "))?.slice(5) || "",
            detached: values.includes("detached"),
            locked: values.some(
              (v) => v === "locked" || v.startsWith("locked "),
            ),
            prunable: values.some(
              (v) => v === "prunable" || v.startsWith("prunable "),
            ),
            // Git always lists the main worktree first.
            main: index === 0,
          },
        ];
      } catch {
        return [];
      }
    });
}
module.exports = { Repository, digest, preview, parseStats, parseWorktrees };
