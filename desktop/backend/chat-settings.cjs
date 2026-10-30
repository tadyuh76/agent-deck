const { spawn } = require("child_process"),
  fs = require("fs/promises");
const LEVELS = ["low", "medium", "high", "xhigh", "max"];
function modelCatalog(response) {
  if (!Array.isArray(response?.models))
    throw new Error("Claude chưa trả danh sách model");
  return response.models
    .filter(
      (m) =>
        /^[\w.()\[\]-]{1,120}$/.test(m.value || "") &&
        typeof m.displayName === "string",
    )
    .map((m) => ({
      value: m.value,
      name: m.displayName,
      resolved: m.resolvedModel,
      description: m.description,
      supportsEffort: m.supportsEffort === true,
      efforts: (m.supportedEffortLevels || []).filter((l) =>
        LEVELS.includes(l),
      ),
    }));
}
function initializeModels({ claude, home, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      claude,
      [
        "-p",
        "--safe-mode",
        "--no-session-persistence",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      { cwd: home, env, stdio: ["pipe", "pipe", "ignore"] },
    );
    let buffer = "",
      finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      force.unref();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(
      () => finish(new Error("Chưa lấy được model từ Claude. Thử tải lại.")),
      25000,
    );
    child.on("error", finish);
    child.stdin.on("error", finish);
    child.on("exit", () => {
      if (!finished) finish(new Error("Claude chưa trả danh sách model"));
    });
    child.stdout.on("data", (data) => {
      buffer += data;
      if (buffer.length > 2 * 1024 * 1024)
        return finish(new Error("Invalid model response"));
      let n;
      while ((n = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        try {
          const m = JSON.parse(line),
            r = m.response;
          if (
            m.type === "control_response" &&
            r?.request_id === "deck-models"
          ) {
            if (r.subtype !== "success")
              return finish(
                new Error("Không lấy được model cho tài khoản này"),
              );
            return finish(null, modelCatalog(r.response));
          }
        } catch (error) {
          if (
            error.message !== "Unexpected end of JSON input" &&
            line.startsWith("{")
          )
            return finish(new Error("Invalid model response"));
        }
      }
    });
    // Control-only initialization: no user prompt or model inference.
    child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: "deck-models",
        request: { subtype: "initialize" },
      }) + "\n",
    );
  });
}
// Fallback when no transcript exists yet: the reply printed under the newly
// typed command on screen.
function screenReply(after, before, kind, value) {
  if (after === before) return null;
  const echo = (text) =>
    text.split("\n").filter((l) => l.includes("/" + kind + " " + value)).length;
  if (echo(after) <= echo(before)) return null;
  const lines = after.split("\n"),
    last = lines.findLastIndex((l) => l.includes("/" + kind + " " + value));
  return commandResult(lines.slice(last + 1).join("\n"), kind);
}
const named = (text, models) =>
  [...models]
    .sort((a, b) => b.name.length - a.name.length)
    .find((m) => text.toLowerCase().includes(m.name.toLowerCase()));
const effortIn = (text) =>
  /\b(low|medium|high|xhigh|max) effort\b/i.exec(text)?.[1]?.toLowerCase() ||
  null;
// The footer under Claude's input box names the live model; the start-up
// banner only shows the model the session was launched with.
function screenSettings(screen, models) {
  const lines = screen.replace(/\x1b\[[0-9;]*m/g, "").split("\n"),
    border = lines.findLastIndex((l) => /^─{8,}/.test(l.trim())),
    footer = border >= 0 ? lines.slice(border + 1).join("\n") : "",
    banner = lines.find((line) => /▝▜/.test(line)) || "";
  return {
    footerModel: named(footer, models),
    footerEffort: effortIn(footer),
    bannerModel: named(banner, models),
    bannerEffort: effortIn(banner),
  };
}
// Latest /model and /effort results and the model of the latest reply.
function transcriptSettings(text, models) {
  const rows = text.split("\n");
  let model = null,
    effort = null;
  for (let i = rows.length - 1; i >= 0 && (!model || !effort); i--) {
    let row;
    try {
      row = JSON.parse(rows[i]);
    } catch {
      continue;
    }
    if (row.isSidechain) continue;
    const content = row.message?.content,
      body = (
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((b) => (b.type === "text" ? b.text : "")).join("\n")
            : ""
      ).replace(/\x1b\[[0-9;]*m/g, "");
    if (row.type === "user" && body.includes("<local-command-stdout>")) {
      const capped = /set to '?(low|medium|high|xhigh|max)'? instead/i.exec(
          body,
        ),
        set = /set effort(?: level)? to '?(low|medium|high|xhigh|max)\b/i.exec(
          body,
        );
      if (!effort && (capped || set)) effort = (capped || set)[1].toLowerCase();
      const switched = /set model to ([^\n<(]+)/i.exec(body);
      if (!model && switched) model = named(switched[1], models) || null;
    }
    if (!model && row.type === "assistant" && row.message?.model) {
      const id = row.message.model;
      model = models.find((m) => m.resolved === id || m.value === id) || null;
    }
  }
  return { model, effort };
}
// Claude's reply to /effort or /model: what was really applied, or why not.
function commandResult(text, kind) {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  const find = (pattern) => pattern.exec(plain);
  if (kind === "effort") {
    const locked = find(/CLAUDE_CODE_EFFORT_LEVEL=(\S+)/);
    if (locked)
      return {
        error:
          "Biến môi trường CLAUDE_CODE_EFFORT_LEVEL=" +
          locked[1] +
          " đang khóa effort của phiên này.",
      };
    const failed = find(/Failed to set effort level: ([^\n]+)/);
    if (failed)
      return { error: "Claude không đổi effort: " + failed[1].trim() };
    const capped = find(
      /Effort '(\w+)' exceeds the cap[^\n]*?set to '(\w+)' instead/i,
    );
    if (capped)
      return {
        value: capped[2].toLowerCase(),
        notice:
          "Tổ chức giới hạn effort: Claude đặt " +
          capped[2] +
          " thay cho " +
          capped[1] +
          ".",
      };
    const set = find(/Set effort level to (\w+)/i);
    if (set) return { value: set[1].toLowerCase() };
    return null;
  }
  const refused = find(
    /(Model '[^'\n]+' is (?:not available|restricted|not currently available)[^\n]*|Unknown model '[^'\n]+'|Failed to validate model: [^\n]+)/,
  );
  if (refused) return { error: "Claude không đổi model: " + refused[1].trim() };
  const set = find(
    /(?:Set|Kept) model (?:to|as) ([^\n]+?)(?: and saved[^\n]*)?$/im,
  );
  if (set) return { value: set[1].replace(/`/g, "").trim() };
  return null;
}
class ChatSettings {
  constructor({
    cli,
    conversations,
    accounts,
    paths,
    env,
    run,
    probe = initializeModels,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  }) {
    Object.assign(this, {
      cli,
      conversations,
      accounts,
      paths,
      env,
      run,
      probe,
      sleep,
    });
    this.cache = new Map();
    this.pending = new Set();
    this.applied = new Map();
  }
  async catalog(id, force = false) {
    const session = await this.conversations.session(id),
      account = this.accounts.find(
        (a) => a.slot === session.account || a.name === session.account,
      );
    if (!account) throw new Error("Không tìm được tài khoản Claude");
    let entry = this.cache.get(account.slot);
    if (force || !entry || Date.now() - entry.at > 600000) {
      const task = this.probe({
        claude: this.paths.claude,
        home: this.paths.home,
        env: { ...this.env, CLAUDE_CONFIG_DIR: account.home },
      });
      entry = { at: Date.now(), task };
      this.cache.set(account.slot, entry);
      task.catch(() => {
        if (this.cache.get(account.slot) === entry)
          this.cache.delete(account.slot);
      });
    }
    const models = await entry.task;
    const screen = screenSettings(
        await this.capture(session).catch(() => ""),
        models,
      ),
      recent = await this.recent(session, models);
    const active =
        screen.footerModel || recent.model || screen.bannerModel || null,
      effort = screen.footerEffort || recent.effort || screen.bannerEffort;
    return {
      models,
      currentModel: active?.name || null,
      currentEffort: effort || null,
      applied: this.applied.get(id) || null,
    };
  }
  async transcriptSize(session) {
    try {
      const file = await this.conversations.transcript(session);
      return file ? (await fs.stat(file)).size : 0;
    } catch {
      return 0;
    }
  }
  // Slash-command output Claude wrote to the transcript after `offset`.
  async reply(session, offset, kind) {
    try {
      const file = await this.conversations.transcript(session);
      if (!file) return null;
      const handle = await fs.open(file, "r");
      try {
        const { size } = await handle.stat();
        if (size <= offset) return null;
        const length = Math.min(size - offset, 1024 * 1024),
          buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        for (const line of buffer.toString("utf8").split("\n")) {
          let row;
          try {
            row = JSON.parse(line);
          } catch {
            continue;
          }
          const content = row.message?.content,
            body =
              typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? content.map((b) => b.text || "").join("\n")
                  : "";
          if (row.type !== "user" || !body.includes("<local-command-stdout>"))
            continue;
          const result = commandResult(body, kind);
          if (result) return result;
        }
        return null;
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }
  async recent(session, models) {
    try {
      const file = await this.conversations.transcript(session);
      if (!file) return {};
      const handle = await fs.open(file, "r");
      try {
        const { size } = await handle.stat(),
          length = Math.min(size, 1024 * 1024),
          buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        return transcriptSettings(buffer.toString("utf8"), models);
      } finally {
        await handle.close();
      }
    } catch {
      return {};
    }
  }
  async capture(session) {
    if (!/^agentdeck_[\w-]+$/.test(session.tmux_session || ""))
      throw new Error("Không xác định được terminal Claude");
    return (
      await this.run(
        this.paths.mux,
        [
          "-L",
          "agent-deck-managed",
          "capture-pane",
          "-p",
          "-J",
          "-S",
          "-100",
          "-t",
          session.tmux_session,
        ],
        { encoding: "utf8", timeout: 4000, maxBuffer: 1024 * 1024 },
      )
    ).stdout;
  }
  async apply(id, selection) {
    if (this.pending.has(id)) throw new Error("Đang đổi model / effort");
    this.pending.add(id);
    try {
      const { model = "", effort = "" } = selection || {};
      if (!model && !effort) return { unchanged: true };
      const catalog = await this.catalog(id),
        chosen = model ? catalog.models.find((m) => m.value === model) : null;
      if (model && !chosen)
        throw new Error("Model không có trong danh sách của Claude");
      if (
        effort &&
        (!LEVELS.includes(effort) ||
          (chosen &&
            (!chosen.supportsEffort || !chosen.efforts.includes(effort))))
      )
        throw new Error("Model này không hỗ trợ mức effort đã chọn");
      this.conversations.meta.delete(id);
      const session = await this.conversations.session(id);
      if (
        session.id !== id ||
        session.tool !== "claude" ||
        !["waiting", "idle"].includes(session.status)
      )
        throw new Error(
          "Đợi Claude xử lý xong rồi đổi model / effort. Bản nháp được giữ lại.",
        );
      const applied = {
        ...(this.applied.get(id) || {}),
        nativeId: session.claude_session_id,
        notice: undefined,
      };
      for (const [kind, value] of [
        ["model", model],
        ["effort", effort],
      ])
        if (value) {
          const before = await this.capture(session),
            offset = await this.transcriptSize(session);
          // Native sender refuses an occupied draft/menu immediately; never clears input.
          const result = await this.cli([
            "session",
            "send",
            id,
            `/${kind} ${value}`,
            "--json",
            "--no-tag",
            "--no-wait",
            "--require-input-prompt",
            "--timeout",
            "8s",
          ]);
          if (
            result.success === false ||
            ["failed", "settled"].includes(result.state) ||
            ["refused", "failed", "typed_not_submitted"].includes(
              result.verdict,
            )
          )
            throw new Error(
              "Claude chưa áp dụng lựa chọn. Kiểm tra bản nháp / menu trong terminal.",
            );
          let outcome = null;
          for (let n = 0; n < 24 && !outcome; n++) {
            await this.sleep(250);
            outcome =
              (await this.reply(session, offset, kind)) ||
              screenReply(await this.capture(session), before, kind, value);
          }
          if (!outcome)
            throw new Error(
              "Chưa xác nhận được model / effort. Mở terminal xử lý thông báo của Claude rồi thử lại; prompt chưa được gửi.",
            );
          if (outcome.error)
            throw new Error(outcome.error + " Prompt chưa được gửi.");
          applied[kind] = kind === "effort" ? outcome.value : value;
          if (outcome.notice) applied.notice = outcome.notice;
          applied.at = Date.now();
          this.applied.set(id, applied);
          if (kind === "model")
            await this.cli(["session", "set", id, "model", value, "--json"]);
        }
      return applied;
    } finally {
      this.pending.delete(id);
    }
  }
}
module.exports = {
  ChatSettings,
  modelCatalog,
  initializeModels,
  screenSettings,
  transcriptSettings,
  commandResult,
};
