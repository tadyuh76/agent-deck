const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs/promises"),
  os = require("os"),
  path = require("path");
const { MessageQueue, readiness } = require("../backend/message-queue.cjs");
const { Transcript } = require("../backend/agent-activity.cjs");
function fixture(t) {
  const sent = [],
    events = [],
    released = [];
  let clock = 1000,
    row = {
      id: "s",
      status: "running",
      substate: "running",
      tmux_session: "agentdeck_x",
    },
    landed = new Set();
  const queue = new MessageQueue({
    file: path.join(
      os.tmpdir(),
      "deck-queue-" + process.pid + "-" + Math.random(),
    ),
    conversations: {
      send: async (id, text, options) => {
        sent.push({ text, reserved: options.reserved });
        return { send_id: "d" + sent.length, state: "queued" };
      },
      status: async (sendId) => ({
        state: landed.has(sendId) ? "landed" : "typing",
      }),
    },
    attachments: {
      selected: async () => [{ name: "a.png" }],
      committed: async () => {},
      release: async (id, tag) => released.push(tag),
    },
    row: () => row,
    refresh: async () => {},
    paneReady: async () => row.status !== "error",
    emit: (event) => events.push(event),
    now: () => clock,
  });
  t.after(() => fs.rm(queue.file, { force: true }));
  return {
    queue,
    sent,
    events,
    released,
    set: (next) => (row = { ...row, ...next }),
    land: (id) => landed.add(id),
    advance: (ms) => (clock += ms),
  };
}
test("Queued messages wait for an idle Claude and go out one turn at a time", async (t) => {
  const f = fixture(t);
  await f.queue.enqueue("s", { text: "first" });
  await f.queue.enqueue("s", { text: "second" });
  await f.queue.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.queue.view("s").items[0].waiting, "Claude đang xử lý");
  f.set({ status: "waiting", substate: "idle-at-empty-prompt" });
  await f.queue.tick();
  assert.deepEqual(
    f.sent.map((m) => m.text),
    ["first"],
  );
  assert(
    f.events.some(
      (e) => e.type === "chat-delivered" && e.receipt.text === "first",
    ),
  );
  // Still looks idle (stale status) but the first message has not started its turn.
  await f.queue.tick();
  assert.equal(f.sent.length, 1);
  f.land("d1");
  await f.queue.tick();
  f.advance(5000);
  f.set({ status: "running", substate: "running" });
  await f.queue.tick();
  assert.equal(f.sent.length, 1);
  f.set({ status: "waiting", substate: "idle-at-empty-prompt" });
  await f.queue.tick();
  assert.deepEqual(
    f.sent.map((m) => m.text),
    ["first", "second"],
  );
});
test("Steer sends at once into a running turn; menus and stopped sessions hold the queue", async (t) => {
  const f = fixture(t);
  const { items } = await f.queue.enqueue("s", {
    text: "now",
    attachments: ["a1"],
  });
  await f.queue.steer("s", items[0].qid);
  assert.deepEqual(f.sent, [{ text: "now", reserved: "q:" + items[0].qid }]);
  assert.equal(f.queue.view("s").items.length, 0);
  f.set({ status: "waiting", substate: "interactive-menu" });
  assert.equal(
    readiness({ status: "waiting", substate: "interactive-menu" }).ready,
    false,
  );
  f.set({ status: "error", substate: "unknown-exit" });
  const held = await f.queue.enqueue("s", { text: "later" });
  await assert.rejects(f.queue.steer("s", held.items[0].qid), /không chạy/);
  const removed = await f.queue.remove("s", held.items[0].qid);
  assert.equal(removed.item.text, "later");
  assert.deepEqual(f.released.at(-1), "q:" + held.items[0].qid);
  assert.equal(
    readiness({ status: "running", substate: "background-work" }).ready,
    true,
  );
});
test("Sub-agent and background shell states come from the transcript", () => {
  const t = new Transcript(),
    row = (r) => t.row({ timestamp: "2026-10-23T06:00:00Z", ...r });
  row({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "u1",
          name: "Agent",
          input: {
            description: "QA chat",
            prompt: "Check chat",
            subagent_type: "Explore",
            run_in_background: true,
          },
        },
        {
          type: "tool_use",
          id: "u2",
          name: "Agent",
          input: { description: "Inline", prompt: "Do it" },
        },
        {
          type: "tool_use",
          id: "u3",
          name: "Bash",
          input: { command: "npm run dev", run_in_background: true },
        },
      ],
    },
  });
  row({
    type: "user",
    toolUseResult: { backgroundTaskId: "b9" },
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "u1",
          content: [
            {
              type: "text",
              text: "Async agent launched successfully.\nagentId: a77",
            },
          ],
        },
        { type: "tool_result", tool_use_id: "u2", content: "All done" },
        {
          type: "tool_result",
          tool_use_id: "u3",
          content: "Command running in background with ID: b9.",
        },
      ],
    },
  });
  assert.equal(t.agents.get("u1").status, "running");
  assert.equal(t.agents.get("u1").agentId, "a77");
  assert.equal(t.agents.get("u2").status, "completed");
  assert.equal(t.shells.get("b9").status, "running");
  row({
    type: "attachment",
    attachment: {
      type: "queued_command",
      prompt:
        '<task-notification>\n<task-id>a77</task-id>\n<tool-use-id>u1</tool-use-id>\n<status>failed</status>\n<summary>Agent "QA chat" failed</summary>',
    },
  });
  row({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "u4",
          name: "TaskStop",
          input: { task_id: "b9" },
        },
      ],
    },
  });
  row({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "u4", content: "stopped" }],
    },
  });
  assert.equal(t.agents.get("u1").status, "failed");
  assert.equal(t.shells.get("b9").status, "killed");
});
