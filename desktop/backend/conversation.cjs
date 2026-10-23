const fs = require("fs/promises"),
  path = require("path");
const MAX_READ = 12 * 1024 * 1024;
const clip = (value, max = 16000) => String(value ?? "").slice(0, max);
function textBlocks(text) {
  const attachments = [];
  let value = clip(text, 100000).replace(
    /@\/[^\s<>`]+\/desktop-attachments\/[\w-]+\/([a-f0-9-]{36})-([a-zA-Z0-9._-]+)/g,
    (_all, id, name) => {
      attachments.push({ type: "attachment", id, name });
      return "";
    },
  );
  if (attachments.length) value = value.trim();
  return [...(value ? [{ type: "text", text: value }] : []), ...attachments];
}
function blocks(value) {
  if (typeof value === "string") return textBlocks(value);
  if (!Array.isArray(value)) return [];
  return value.flatMap((b) => {
    if (b.type === "text") return textBlocks(b.text);
    if (
      b.type === "image" &&
      b.source?.type === "base64" &&
      /^image\/(png|jpeg|gif|webp)$/.test(b.source.media_type) &&
      b.source.data?.length < 8 * 1024 * 1024
    )
      return [
        {
          type: "image",
          src: `data:${b.source.media_type};base64,${b.source.data}`,
        },
      ];
    return [];
  });
}
// Slash commands are stored as tagged user rows; show them the way Claude Code
// does: the typed command, then its output as a muted line.
function slashCommand(content) {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content) && content.length === 1
        ? content[0]?.text
        : null;
  if (typeof text !== "string") return null;
  const tag = (name) =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
  const name = tag("command-name");
  if (name)
    return {
      role: "user",
      text: [name, tag("command-args")].filter(Boolean).join(" "),
    };
  const output = tag("local-command-stdout") ?? tag("local-command-stderr");
  if (output !== undefined)
    return output ? { role: "system", kind: "output", text: output } : {};
  return null;
}
function parseConversation(text, limit = 120) {
  const rows = [];
  for (const line of text.split("\n")) {
    try {
      const r = JSON.parse(line);
      if (!r.isSidechain && r.uuid) rows.push(r);
    } catch {}
  }
  const byId = new Map(rows.map((r) => [r.uuid, r]));
  // Follow the current transcript branch, excluding replaced replies after resume/rewind.
  let leaf = rows.findLast((r) => ["user", "assistant"].includes(r.type));
  const chain = [],
    seen = new Set();
  while (leaf && !seen.has(leaf.uuid)) {
    seen.add(leaf.uuid);
    chain.push(leaf);
    // /compact starts a new root; its boundary row links to the old branch.
    leaf =
      byId.get(leaf.parentUuid) ||
      (leaf.subtype === "compact_boundary"
        ? byId.get(leaf.logicalParentUuid)
        : undefined);
  }
  chain.reverse();
  // Parallel tool calls put each result on its own branch, off the chain.
  const results = new Map();
  for (const r of rows)
    if (Array.isArray(r.message?.content))
      for (const b of r.message.content)
        if (b.type === "tool_result") results.set(b.tool_use_id, b);
  const messages = [],
    tools = new Map();
  for (const r of chain) {
    if (r.subtype === "compact_boundary") {
      messages.push({
        id: r.uuid,
        role: "system",
        timestamp: r.timestamp,
        content: [
          { type: "text", text: "Hội thoại đã được tóm tắt (/compact)" },
        ],
      });
      continue;
    }
    if (
      r.isMeta ||
      r.isCompactSummary ||
      !["user", "assistant"].includes(r.type)
    )
      continue;
    const command = r.type === "user" && slashCommand(r.message?.content);
    if (command) {
      if (command.text)
        messages.push({
          id: r.uuid,
          role: command.role,
          kind: command.kind,
          timestamp: r.timestamp,
          content: [{ type: "text", text: command.text }],
        });
      continue;
    }
    const content =
      typeof r.message?.content === "string"
        ? [{ type: "text", text: r.message.content }]
        : r.message?.content || [];
    const visible = blocks(content);
    if (visible.length)
      messages.push({
        id: r.uuid,
        role: r.type,
        timestamp: r.timestamp,
        content: visible,
      });
    for (const b of content) {
      if (b.type === "tool_use") {
        const input = b.input || {},
          file = input.file_path || input.path || input.notebook_path;
        const card = {
          id: b.id,
          role: "tool",
          name: b.name,
          timestamp: r.timestamp,
          file: typeof file === "string" ? file : undefined,
          summary: clip(
            input.description ||
              file ||
              input.command ||
              input.pattern ||
              b.name,
            220,
          ),
          input: clip(JSON.stringify(input, null, 2)),
          content: [],
          state: "running",
        };
        tools.set(b.id, card);
        messages.push(card);
      }
    }
  }
  for (const [id, tool] of tools) {
    const result = results.get(id);
    if (result) {
      tool.content = blocks(result.content);
      tool.state = result.is_error ? "error" : "done";
    }
  }
  return {
    messages: messages.slice(-limit),
    hasMore: messages.length > limit,
    total: messages.length,
  };
}
function resolveReference(value, projects, selected) {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0"))
    throw new Error("Invalid file reference");
  let name = value.replace(/^file:\/\//, "");
  try {
    name = decodeURIComponent(name);
  } catch {}
  name = name.replace(/\\/g, "/");
  if (/^\/[a-z]:\//i.test(name)) name = name.slice(1);
  if (/^[a-z]:\//i.test(name))
    name = "/mnt/" + name[0].toLowerCase() + name.slice(2);
  const location = /(?:#L|:)(\d+)(?::\d+)?$/.exec(name);
  if (location) name = name.slice(0, location.index);
  if (/^[a-z][\w+.-]*:/i.test(name)) throw new Error("Chỉ mở file trong dự án");
  const absolute = path.posix.isAbsolute(name);
  const project = absolute
    ? Object.keys(projects).find(
        (id) => name === projects[id] || name.startsWith(projects[id] + "/"),
      )
    : selected;
  if (!projects[project])
    throw new Error("File nằm ngoài hai dự án đã cấu hình");
  const relative = absolute
    ? path.posix.relative(projects[project], name)
    : name.replace(/^\.\//, "");
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    path.posix.isAbsolute(relative)
  )
    throw new Error("File nằm ngoài dự án");
  return {
    project,
    path: relative,
    line: location ? Number(location[1]) : undefined,
  };
}
class Conversations {
  constructor({ cli, homes, attachments, applySettings }) {
    this.cli = cli;
    this.homes = homes;
    this.meta = new Map();
    this.cache = new Map();
    this.sending = new Set();
    this.attachments = attachments;
    this.applySettings = applySettings;
  }
  async session(id) {
    if (typeof id !== "string" || !/^[\w-]+$/.test(id))
      throw new Error("Invalid session");
    const cached = this.meta.get(id);
    if (cached && Date.now() - cached.at < 4000) return cached.value;
    const value = await this.cli(["session", "show", id, "--json"]);
    this.meta.set(id, { at: Date.now(), value });
    return value;
  }
  async transcript(session) {
    const uuid = session.claude_session_id;
    if (!/^[a-f0-9-]{36}$/i.test(uuid || "")) return null;
    const candidates = [session.transcript_path];
    const encoded = session.path?.replace(/[^a-zA-Z0-9-]/g, "-");
    for (const home of this.homes)
      candidates.push(
        path.join(home, "projects", encoded || "", uuid + ".jsonl"),
      );
    const allowed = await Promise.all(
      this.homes.map((home) =>
        fs.realpath(path.join(home, "projects")).catch(() => null),
      ),
    );
    for (const file of candidates.filter(Boolean)) {
      try {
        const real = await fs.realpath(file);
        if (
          allowed.some((root) => root && real.startsWith(root + path.sep)) &&
          path.basename(real) === uuid + ".jsonl"
        )
          return real;
      } catch {}
    }
    return null;
  }
  async history(id, { limit = 120, revision } = {}) {
    limit = Math.max(20, Math.min(1500, Number(limit) || 120));
    const session = await this.session(id),
      file = await this.transcript(session);
    const publicSession = {
      id: session.id,
      title: session.title,
      account: session.account,
      status: session.status,
      tool: session.tool,
    };
    if (!file)
      return {
        session: publicSession,
        messages: [],
        revision: "empty",
        hasMore: false,
      };
    const stat = await fs.stat(file),
      stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${limit}`;
    if (revision === stamp)
      return { session: publicSession, revision: stamp, unchanged: true };
    let cached = this.cache.get(file);
    if (cached?.stamp !== stamp) {
      const handle = await fs.open(file, "r");
      let text;
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_READ));
        await handle.read(
          buffer,
          0,
          buffer.length,
          Math.max(0, stat.size - buffer.length),
        );
        text = buffer.toString("utf8");
        if (stat.size > buffer.length)
          text = text.slice(text.indexOf("\n") + 1);
      } finally {
        await handle.close();
      }
      cached = {
        stamp,
        ...parseConversation(text, limit),
        truncated: stat.size > MAX_READ,
      };
      this.cache.set(file, cached);
      if (this.cache.size > 12)
        this.cache.delete(this.cache.keys().next().value);
    }
    return { session: publicSession, ...cached, revision: stamp };
  }
  async send(id, text, { attachments = [], settings, reserved } = {}) {
    if (
      typeof text !== "string" ||
      (!text.trim() && !attachments.length) ||
      Buffer.byteLength(text) > 100000
    )
      throw new Error("Tin nhắn phải có nội dung và không quá 100 KB");
    if (this.sending.has(id)) throw new Error("Đang gửi tin nhắn trước");
    this.sending.add(id);
    let folder;
    try {
      const session = await this.session(id);
      if (
        session.tool !== "claude" ||
        !["running", "waiting", "idle"].includes(session.status)
      )
        throw new Error("Mở phiên Claude trong terminal trước khi gửi");
      const files = attachments.length
        ? await this.attachments.selected(id, attachments, reserved)
        : [];
      if (settings) await this.applySettings(id, settings);
      const message = [
        text.trim() || "Xem các tệp đính kèm sau:",
        ...files.map((f) => "@" + f.file),
      ].join("\n\n");
      folder = await fs.mkdtemp("/tmp/agent-deck-message-");
      const file = path.join(folder, "message.txt");
      await fs.writeFile(file, files.length ? message : text, { mode: 0o600 });
      // The durable sender guards occupied composers and verifies transcript delivery.
      // Never press Enter ourselves or clear the operator’s existing draft.
      const result = await this.cli([
        "session",
        "send",
        id,
        "--message-file",
        file,
        "--json",
        "--no-tag",
        "--require-input-prompt",
      ]);
      if (result.success === false || result.state === "failed")
        throw new Error(result.error || "Chưa gửi được tin nhắn");
      // Queue acceptance is irreversible: a bookkeeping failure must not invite a duplicate send.
      if (files.length)
        await this.attachments.committed(files, result.send_id).catch(() => {});
      return result;
    } finally {
      this.sending.delete(id);
      if (folder) await fs.rm(folder, { recursive: true, force: true });
    }
  }
  async restore(id, sendId) {
    const status = await this.status(sendId);
    if (status.session_id !== id)
      throw new Error("Tin nhắn thuộc hội thoại khác");
    // Only "failed" proves nothing was typed; a settled send may have landed.
    if (status.state !== "failed" || status.settled)
      throw new Error(
        "Tin có thể đã vào terminal nên không khôi phục bản nháp",
      );
    return { attachments: await this.attachments.release(id, sendId) };
  }
  status(sendId) {
    if (typeof sendId !== "string" || !/^[\w-]+$/.test(sendId))
      throw new Error("Invalid delivery ID");
    return this.cli(["session", "send-status", sendId, "--json"]);
  }
}
module.exports = { Conversations, parseConversation, resolveReference };
