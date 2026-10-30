// Terminal output on its way to the window. Claude streams hundreds of small
// chunks a second; copying a 512 KB history for each one, and sending each as
// its own message through WSL, Electron and IPC, cost far more than the text.
const LIMIT = 512 * 1024;
// The last LIMIT characters of one terminal, joined only when asked for.
class Scrollback {
  constructor(limit = LIMIT) {
    this.limit = limit;
    this.chunks = [];
    this.size = 0;
  }
  push(data) {
    this.chunks.push(data);
    this.size += data.length;
    // Trim once well past the limit, so the join runs rarely.
    if (this.size > this.limit * 1.5) this.text();
  }
  text() {
    let all = this.chunks.join("");
    if (all.length > this.limit) all = all.slice(-this.limit);
    this.chunks = all ? [all] : [];
    this.size = all.length;
    return all;
  }
}
// Collects each terminal's output for `delay` ms and sends it as one event.
class OutputBatcher {
  constructor(send, delay = 8) {
    this.send = send;
    this.delay = delay;
    this.pending = new Map();
    this.timer = null;
  }
  push(slot, data) {
    const queued = this.pending.get(slot);
    if (queued) queued.push(data);
    else this.pending.set(slot, [data]);
    this.timer ??= setTimeout(() => this.flush(), this.delay);
  }
  // Sends what is queued, for one terminal or all of them.
  flush(slot) {
    for (const [key, parts] of this.pending)
      if (slot === undefined || key === slot) {
        this.pending.delete(key);
        this.send(key, parts.join(""));
      }
    if (!this.pending.size) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  // Forgets queued output, for one terminal or all of them.
  drop(slot) {
    if (slot === undefined) this.pending.clear();
    else this.pending.delete(slot);
    if (!this.pending.size) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
module.exports = { Scrollback, OutputBatcher, LIMIT };
