const fs = require("fs/promises"),
  { randomUUID } = require("crypto");
// Messages written while Claude is busy (or not running yet) wait here, in
// the desktop backend, and go out one by one when the session is ready. The
// agent-deck sender itself types as soon as it sees an input prompt, which
// Claude absorbs into the running turn: that is "steer", not "queue".
const BLOCKED = {
  "interactive-menu": "Claude đang chờ bạn chọn trong menu / quyền",
  "usage-limit": "Tài khoản đã hết hạn mức",
  "auth-401": "Claude cần đăng nhập lại",
  "model-unavailable": "Model đang không khả dụng",
};
function readiness(row) {
  if (!row)
    return { ready: false, live: false, reason: "Không tìm thấy hội thoại" };
  if (["stopped", "error"].includes(row.status) || !row.status)
    return {
      ready: false,
      live: false,
      reason:
        BLOCKED[row.substate] ||
        "Claude không chạy trong terminal. Mở lại hội thoại để tiếp tục.",
    };
  if (BLOCKED[row.substate])
    return { ready: false, live: true, reason: BLOCKED[row.substate] };
  // A finished turn with agents or shells still running in the background
  // can take the next message.
  if (row.status === "running" && row.substate !== "background-work")
    return { ready: false, live: true, reason: "Claude đang xử lý" };
  return { ready: true, live: true, reason: "" };
}
class MessageQueue {
  constructor({
    file,
    conversations,
    attachments,
    row,
    refresh,
    paneReady,
    emit,
    now = Date.now,
  }) {
    Object.assign(this, {
      file,
      conversations,
      attachments,
      row,
      refresh,
      paneReady,
      emit,
      now,
    });
    this.queues = new Map();
    this.inflight = new Map();
    this.busy = false;
  }
  async load() {
    try {
      const saved = JSON.parse(await fs.readFile(this.file, "utf8"));
      for (const [id, items] of Object.entries(saved))
        if (Array.isArray(items) && items.length)
          // A send interrupted by a restart is not known to have gone out.
          this.queues.set(
            id,
            items.map((item) =>
              item.state === "sending"
                ? {
                    ...item,
                    state: "error",
                    error:
                      "Chưa rõ đã gửi hay chưa. Kiểm tra terminal rồi thử lại.",
                  }
                : item,
            ),
          );
    } catch {}
  }
  async save() {
    const data = Object.fromEntries(
      [...this.queues].filter(([, items]) => items.length),
    );
    const temp = this.file + "." + randomUUID() + ".tmp";
    await fs.writeFile(temp, JSON.stringify(data), { mode: 0o600 });
    await fs.rename(temp, this.file);
  }
  view(id) {
    const row = this.row(id);
    return {
      items: (this.queues.get(id) || []).map(
        ({ qid, text, names, state, error, createdAt, waiting }) => ({
          qid,
          text,
          names,
          state,
          error,
          createdAt,
          waiting,
        }),
      ),
      readiness: readiness(row),
      sending: this.inflight.has(id),
    };
  }
  changed(id) {
    this.emit({ type: "chat-queue", id, queue: this.view(id) });
  }
  find(id, qid) {
    const item = (this.queues.get(id) || []).find((i) => i.qid === qid);
    if (!item) throw new Error("Tin nhắn không còn trong hàng chờ");
    return item;
  }
  async enqueue(id, { text = "", attachments = [], settings } = {}) {
    if (
      typeof text !== "string" ||
      (!text.trim() && !attachments.length) ||
      Buffer.byteLength(text) > 100000
    )
      throw new Error("Tin nhắn phải có nội dung và không quá 100 KB");
    const files = attachments.length
      ? await this.attachments.selected(id, attachments)
      : [];
    const qid = randomUUID();
    // Reserved files leave the draft but stay with this queued message.
    if (files.length) await this.attachments.committed(files, "q:" + qid);
    const list = this.queues.get(id) || [];
    list.push({
      qid,
      text,
      attachments,
      names: files.map((f) => f.name),
      settings,
      state: "queued",
      createdAt: this.now(),
    });
    this.queues.set(id, list);
    await this.save();
    this.changed(id);
    void this.tick();
    return this.view(id);
  }
  async remove(id, qid) {
    const item = this.find(id, qid);
    if (item.state === "sending") throw new Error("Tin nhắn đang được gửi");
    await this.attachments.release(id, "q:" + qid).catch(() => []);
    this.queues.set(
      id,
      this.queues.get(id).filter((i) => i.qid !== qid),
    );
    await this.save();
    this.changed(id);
    return {
      item: { text: item.text, attachments: item.attachments },
      queue: this.view(id),
    };
  }
  async retry(id, qid) {
    const item = this.find(id, qid);
    Object.assign(item, { state: "queued", error: null });
    await this.save();
    this.changed(id);
    void this.tick();
    return this.view(id);
  }
  // Send now, into the running turn if Claude is busy.
  async steer(id, qid) {
    await this.refresh();
    const item = this.find(id, qid),
      state = readiness(this.row(id));
    if (!state.live || !(await this.paneReady(this.row(id))))
      throw new Error(state.reason || "Claude chưa chạy trong terminal");
    await this.dispatch(id, item, true);
    return this.view(id);
  }
  async dispatch(id, item, force = false) {
    item.state = "sending";
    item.error = null;
    this.changed(id);
    try {
      const result = await this.conversations.send(id, item.text, {
        attachments: item.attachments,
        settings: item.settings,
        reserved: "q:" + item.qid,
      });
      this.queues.set(
        id,
        (this.queues.get(id) || []).filter((i) => i.qid !== item.qid),
      );
      this.inflight.set(id, { sendId: result.send_id, at: this.now() });
      await this.save();
      this.emit({
        type: "chat-delivered",
        id,
        receipt: { ...result, text: item.text },
      });
    } catch (error) {
      Object.assign(item, { state: "error", error: error.message });
      await this.save();
      if (force) throw error;
    } finally {
      this.changed(id);
    }
  }
  // A delivered message must start its turn before the next one may go.
  async settled(id) {
    const flight = this.inflight.get(id);
    if (!flight) return true;
    if (!flight.done) {
      const status = await this.conversations
        .status(flight.sendId)
        .catch(() => ({}));
      if (status.state === "failed") flight.done = 0;
      else if (status.state === "landed" || status.settled)
        flight.done = this.now();
      else if (this.now() - flight.at > 30 * 60000) flight.done = 0;
    }
    if (flight.done === undefined) return false;
    if (flight.done && this.now() - flight.done < 4000) return false;
    this.inflight.delete(id);
    return true;
  }
  async tick() {
    if (this.busy) return;
    if (![...this.queues.values()].some((l) => l.length) && !this.inflight.size)
      return;
    this.busy = true;
    try {
      await this.refresh();
      for (const [id, list] of this.queues) {
        if (!(await this.settled(id)) || !list.length) continue;
        const head = list[0];
        if (head.state !== "queued") continue;
        const row = this.row(id),
          state = readiness(row);
        const waiting = state.ready ? "" : state.reason;
        if (head.waiting !== waiting) {
          head.waiting = waiting;
          this.changed(id);
        }
        if (state.ready && (await this.paneReady(row)))
          await this.dispatch(id, head);
      }
      for (const id of this.inflight.keys())
        if (!this.queues.get(id)?.length) await this.settled(id);
    } finally {
      this.busy = false;
    }
  }
}
module.exports = { MessageQueue, readiness };
