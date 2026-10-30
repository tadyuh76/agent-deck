const fs = require("fs/promises"),
  path = require("path");
const nativeIds = (session) => [
  ...new Set(
    [session.claude_session_id, ...(session.transcript_ids || [])].filter(
      (id) => /^[a-f0-9-]{36}$/i.test(id || ""),
    ),
  ),
];
class SessionActions {
  constructor({ cli, conversations, clearPanels, attachments }) {
    this.cli = cli;
    this.conversations = conversations;
    this.clearPanels = clearPanels;
    this.pending = new Set();
    this.attachments = attachments;
  }
  async mutate(id, action, { deleteHistory = true } = {}) {
    if (
      !/^[\w-]+$/.test(id || "") ||
      !["archive", "unarchive", "delete"].includes(action)
    )
      throw new Error("Invalid conversation action");
    if (this.pending.has(id)) throw new Error("Hội thoại đang được cập nhật");
    this.pending.add(id);
    try {
      const session = await this.cli(["session", "show", id, "--json"]);
      if (session.id !== id) throw new Error("Hội thoại đã thay đổi");
      const files = [],
        retained = [];
      if (action === "delete" && deleteHistory && session.tool === "claude") {
        const others = await this.cli([
          "list",
          "--json",
          "--include-superseded",
        ]);
        const shared = new Set(
          others.filter((s) => s.id !== id).flatMap(nativeIds),
        );
        for (const uuid of nativeIds(session)) {
          if (shared.has(uuid)) {
            retained.push(uuid);
            continue;
          }
          const file = await this.conversations.transcript({
            ...session,
            claude_session_id: uuid,
            transcript_path:
              uuid === session.claude_session_id
                ? session.transcript_path
                : undefined,
          });
          if (file && !files.includes(file)) files.push(file);
        }
      }
      const result = await this.cli(
        action === "delete"
          ? ["session", "remove", id, "--force", "--json"]
          : ["session", action, id, "--json"],
      );
      if (result.success === false)
        throw new Error(result.error || "Không cập nhật được hội thoại");
      const failures = [];
      // The session is already gone; a panel that fails to reset must not
      // leave its history behind or report the whole action as failed.
      let panelError = false;
      if (action !== "unarchive")
        await this.clearPanels(id).catch(() => (panelError = true));
      for (const file of files) {
        try {
          await fs.unlink(file).catch((e) => {
            if (e.code !== "ENOENT") throw e;
          });
          // Claude keeps this session's tool/subagent logs next to the JSONL.
          const folder = file.slice(0, -".jsonl".length);
          const info = await fs.lstat(folder).catch((e) => {
            if (e.code === "ENOENT") return null;
            throw e;
          });
          if (info?.isDirectory() && !info.isSymbolicLink()) {
            const real = await fs.realpath(folder);
            if (
              real !== path.resolve(folder) ||
              !real.startsWith(path.dirname(file) + path.sep)
            )
              throw new Error("Unsafe session folder");
            await fs.rm(real, { recursive: true, force: true });
          }
          this.conversations.cache?.delete(file);
        } catch {
          failures.push(path.basename(file));
        }
      }
      this.conversations.meta?.delete(id);
      const deletedTranscripts = files.length - failures.length;
      if (
        action === "delete" &&
        deleteHistory &&
        !retained.length &&
        this.attachments
      ) {
        await this.attachments
          .purge(id)
          .catch(() => failures.push("attachments"));
      }
      return {
        id,
        action,
        deletedTranscripts,
        retainedShared: retained.length,
        historyErrors: failures,
        panelError,
      };
    } finally {
      this.pending.delete(id);
    }
  }
}
module.exports = { SessionActions, nativeIds };
