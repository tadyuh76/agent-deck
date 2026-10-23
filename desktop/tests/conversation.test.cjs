const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs/promises"),
  os = require("os"),
  path = require("path");
const {
  parseConversation,
  resolveReference,
  Conversations,
} = require("../backend/conversation.cjs");
test("Transcript follows active ancestry through system rows, joins tools, and preserves inline images", () => {
  const rows = [
    { uuid: "u1", type: "user", message: { content: "question" } },
    {
      uuid: "discarded",
      parentUuid: "u1",
      type: "assistant",
      message: { content: [{ type: "text", text: "old branch" }] },
    },
    { uuid: "system", parentUuid: "u1", type: "system" },
    {
      uuid: "a1",
      parentUuid: "system",
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hidden" },
          {
            type: "tool_use",
            id: "tool",
            name: "Read",
            input: { file_path: "src/a.ts" },
          },
        ],
      },
    },
    {
      uuid: "u2",
      parentUuid: "a1",
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tool", content: "result" },
        ],
      },
    },
    {
      uuid: "a2",
      parentUuid: "u2",
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "See `src/a.ts:4`" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAA=" },
          },
        ],
      },
    },
    {
      uuid: "side",
      parentUuid: "a2",
      type: "assistant",
      isSidechain: true,
      message: { content: "subagent" },
    },
  ];
  const result = parseConversation(
    rows.map(JSON.stringify).join("\n") + "\n{incomplete",
  );
  assert.equal(result.total, 3);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[1].state, "done");
  assert.equal(result.messages[1].file, "src/a.ts");
  assert.equal(result.messages[1].content[0].text, "result");
  assert.equal(result.messages[2].content[1].src, "data:image/png;base64,AAA=");
  assert(!JSON.stringify(result).includes("hidden"));
  assert(!JSON.stringify(result).includes("old branch"));
});
test("References support Windows and WSL paths, encoded spaces, and line numbers without escaping projects", () => {
  const projects = {
    web: "/mnt/s/Projects/Web App",
    mobile: "/mnt/s/Projects/Mobile",
  };
  assert.deepEqual(
    resolveReference("S:\\Projects\\Web App\\src\\a.ts:42", projects, "mobile"),
    { project: "web", path: "src/a.ts", line: 42 },
  );
  assert.equal(
    resolveReference("file:///mnt/s/Projects/Web%20App/a.png", projects, "web")
      .path,
    "a.png",
  );
  assert.throws(() => resolveReference("../outside", projects, "web"), /ngoài/);
  assert.throws(
    () => resolveReference("/etc/passwd", projects, "web"),
    /ngoài/,
  );
  assert.throws(
    () => resolveReference("javascript:alert(1)", projects, "web"),
    /dự án/,
  );
});
test("Chat delivery uses the verified queued sender and message files, rejects duplicate and stopped targets", async (t) => {
  let release, received;
  const cli = async (args) => {
    if (args[1] === "show")
      return { id: "s", tool: "claude", status: "waiting" };
    received = {
      args,
      text: await fs.readFile(args[args.indexOf("--message-file") + 1], "utf8"),
    };
    await new Promise((r) => (release = r));
    return { send_id: "queue-id", state: "queued" };
  };
  const chat = new Conversations({ cli, homes: [] });
  const task = chat.send("s", "literal `code`\nsecond line $()");
  while (!release) await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(chat.send("s", "duplicate"), /trước/);
  release();
  assert.equal((await task).send_id, "queue-id");
  assert.equal(received.text, "literal `code`\nsecond line $()");
  assert(received.args.includes("--require-input-prompt"));
  assert(received.args.includes("--no-tag"));
  assert(!received.args.includes("--no-wait"));
  const stopped = new Conversations({
    cli: async () => ({ tool: "claude", status: "stopped" }),
    homes: [],
  });
  await assert.rejects(stopped.send("s", "message"), /Mở phiên/);
});
test("Root filenames can include a line suffix", () => {
  assert.deepEqual(
    resolveReference("package.json:12", { web: "/project" }, "web"),
    { project: "web", path: "package.json", line: 12 },
  );
});
test("Parallel tool results on sibling branches finish their cards, and /compact keeps earlier history", () => {
  const use = (id) => ({ type: "tool_use", id, name: "Bash", input: {} });
  const rows = [
    { uuid: "q", type: "user", message: { content: "run two" } },
    {
      uuid: "u1",
      parentUuid: "q",
      type: "assistant",
      message: { content: [use("t1")] },
    },
    {
      uuid: "u2",
      parentUuid: "u1",
      type: "assistant",
      message: { content: [use("t2")] },
    },
    {
      uuid: "r1",
      parentUuid: "u1",
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: "one" }],
      },
    },
    {
      uuid: "r2",
      parentUuid: "u2",
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t2", content: "two" }],
      },
    },
    {
      uuid: "cb",
      parentUuid: null,
      logicalParentUuid: "r2",
      type: "system",
      subtype: "compact_boundary",
    },
    {
      uuid: "sum",
      parentUuid: "cb",
      type: "user",
      isCompactSummary: true,
      message: { content: "This session is being continued…" },
    },
    {
      uuid: "n",
      parentUuid: "sum",
      type: "user",
      message: { content: "next" },
    },
  ];
  const { messages } = parseConversation(
    rows.map((r) => JSON.stringify(r)).join("\n"),
  );
  assert.deepEqual(
    messages.map((m) => m.role + ":" + (m.state || m.content[0].text)),
    [
      "user:run two",
      "tool:done",
      "tool:done",
      "system:Hội thoại đã được tóm tắt (/compact)",
      "user:next",
    ],
  );
});
test("Slash commands show as the typed command and a muted output line", () => {
  const rows = [
    {
      uuid: "c",
      type: "user",
      message: {
        content:
          "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>",
      },
    },
    {
      uuid: "o",
      parentUuid: "c",
      type: "user",
      message: {
        content:
          "<local-command-stdout>Set model to `Opus 5.5`</local-command-stdout>",
      },
    },
  ];
  const { messages } = parseConversation(
    rows.map((r) => JSON.stringify(r)).join("\n"),
  );
  assert.deepEqual(
    messages.map((m) => [m.role, m.kind, m.content[0].text]),
    [
      ["user", undefined, "/model opus"],
      ["system", "output", "Set model to `Opus 5.5`"],
    ],
  );
});
