const fs = require("fs/promises");
const placeholder = (title) =>
  /^(?:new conversation|hội thoại mới)(?:\s*\(\d+\))?$/i.test(
    String(title || "").trim(),
  );
function promptTitle(text) {
  for (const line of text.split("\n"))
    try {
      const row = JSON.parse(line);
      if (row.type !== "user" || row.isMeta || row.isSidechain) continue;
      const content = row.message?.content;
      let value =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join(" ")
            : "";
      value = value
        .replace(/^\[agent-deck from:[^\]]+\]\s*/, "")
        .replace(/<\/?pasted_content\b[^>]*>/g, "")
        .trim();
      if (
        !value ||
        /^(?:<(?:(?:local-command|command-|system-reminder|task-notification|system)|ide_|context)|\/(?:model|effort|clear|rename|compact|help)(?:\s|$))/i.test(
          value,
        )
      )
        continue;
      value = value
        .replace(/@\/[^\s]+\/([a-f0-9-]{36}-)?([^\s/]+)\s*/g, "$2 ")
        .replace(/[`#*_]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const chars = Array.from(value);
      return chars.length > 72
        ? chars
            .slice(0, 69)
            .join("")
            .replace(/\s+\S*$/, "") + "…"
        : value;
    } catch {}
  return null;
}
class ConversationTitles {
  constructor({ cli, conversations }) {
    this.cli = cli;
    this.conversations = conversations;
    this.tail = Promise.resolve();
    this.checked = new Map();
  }
  exclusive(fn) {
    const task = this.tail.then(fn);
    this.tail = task.catch(() => {});
    return task;
  }
  rename(id, title) {
    return this.exclusive(async () => {
      if (
        typeof title !== "string" ||
        !title.trim() ||
        Array.from(title.trim()).length > 120 ||
        /[\x00-\x1f\x7f]/.test(title)
      )
        throw new Error("Tên hội thoại cần 1–120 ký tự trên một dòng");
      if (!/^[\w-]+$/.test(id || "")) throw new Error("Invalid conversation");
      const s = await this.cli(["session", "show", id, "--json"]);
      if (s.id !== id) throw new Error("Hội thoại đã thay đổi");
      const result = await this.cli([
        "session",
        "set",
        id,
        "title",
        title.trim(),
        "--json",
      ]);
      if (result.success === false)
        throw new Error(result.error || "Không đổi được tên");
      this.conversations.meta.delete(id);
      return { id, title: title.trim() };
    });
  }
  reconcile(rows) {
    return this.exclusive(async () => {
      let changed = false;
      for (const row of rows) {
        if (
          row.archived ||
          row.tool !== "claude" ||
          !placeholder(row.title) ||
          Date.now() - (this.checked.get(row.id) || 0) < 15000
        )
          continue;
        this.checked.set(row.id, Date.now());
        try {
          const s = await this.cli(["session", "show", row.id, "--json"]);
          if (s.title_locked || !placeholder(s.title)) continue;
          const file = await this.conversations.transcript(s);
          if (!file) continue;
          const handle = await fs.open(file, "r");
          let text;
          try {
            const b = Buffer.alloc(
              Math.min((await handle.stat()).size, 2 * 1024 * 1024),
            );
            await handle.read(b, 0, b.length, 0);
            text = b.toString("utf8");
          } finally {
            await handle.close();
          }
          let title = promptTitle(text);
          if (!title) continue;
          if (
            rows.some(
              (other) =>
                other.id !== s.id &&
                other.path === s.path &&
                other.title === title,
            )
          )
            title += " · " + s.id.slice(0, 4);
          // Re-check after reading: an operator rename always takes precedence.
          const latest = await this.cli(["session", "show", s.id, "--json"]);
          if (latest.title_locked || latest.title !== s.title) continue;
          const result = await this.cli([
            "session",
            "set",
            s.id,
            "title",
            title,
            "--json",
          ]);
          if (result.success !== false) {
            // `session set title` locks the title like a manual rename; an
            // automatic name must stay open to Claude's own /rename sync.
            await this.cli([
              "session",
              "set-title-lock",
              s.id,
              "off",
              "--json",
            ]);
            row.title = title;
            this.conversations.meta.delete(s.id);
            changed = true;
          }
        } catch {}
      }
      return changed;
    });
  }
}
module.exports = { ConversationTitles, promptTitle, placeholder };
