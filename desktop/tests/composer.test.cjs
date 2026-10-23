const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs/promises"),
  os = require("os"),
  path = require("path");
const { Attachments, MAX_FILE } = require("../backend/attachments.cjs");
const {
  ConversationTitles,
  promptTitle,
  placeholder,
} = require("../backend/conversation-titles.cjs");
const { Conversations } = require("../backend/conversation.cjs");
const {
  modelCatalog,
  commandResult,
  ChatSettings,
  screenSettings,
  transcriptSettings,
} = require("../backend/chat-settings.cjs");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
async function vault(t) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "deck-attachments-test-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return new Attachments(dir);
}
test("Attachment drafts survive reload, use opaque session-owned tokens, sniff images, and keep queued files readable", async (t) => {
  const store = await vault(t),
    image = await store.stage("s1", {
      name: "Ảnh bàn phím.png",
      data: png.toString("base64"),
    }),
    file = await store.stage("s1", {
      name: "../../notes.md",
      data: Buffer.from("Review this").toString("base64"),
    });
  assert.equal(image.mime, "image/png");
  assert(image.src.startsWith("data:image/png;base64,"));
  assert.equal(file.name, "notes.md");
  assert.equal((await new Attachments(store.root).drafts("s1")).length, 2);
  await assert.rejects(store.read("s2", image.id));
  await assert.rejects(store.read("s1", "../../etc/passwd"));
  const selected = await store.selected("s1", [image.id, file.id]);
  assert(selected.every((f) => f.file.startsWith(store.root + "/s1/")));
  await store.committed(selected);
  assert.deepEqual(await store.drafts("s1"), []);
  assert.equal((await store.open("s1", image.id)).kind, "image");
  assert.equal((await store.open("s1", file.id)).text, "Review this");
  await assert.rejects(store.remove("s1", image.id), /đã gửi/);
  await assert.rejects(store.selected("s1", [image.id]), /đã gửi/);
});
test("Attachment validation enforces file/count/total limits, rejects symlink escape and fake image MIME", async (t) => {
  const store = await vault(t);
  await assert.rejects(
    store.stage("s", {
      name: "huge",
      data: "A".repeat(Math.ceil(MAX_FILE / 3) * 4 + 4),
    }),
    /20 MB/,
  );
  await assert.rejects(
    store.stage("s", { name: "broken", data: "a===" }),
    /encoding/,
  );
  const fake = await store.stage("s", {
    name: "fake.png",
    data: Buffer.from("not an image").toString("base64"),
  });
  assert(!fake.src);
  assert.equal(fake.mime, "application/octet-stream");
  await store.remove("s", fake.id);
  assert.deepEqual(await store.drafts("s"), []);
  for (let n = 0; n < 12; n++)
    await store.stage("s", { name: "file" + n, data: "YQ==" });
  await assert.rejects(
    store.stage("s", { name: "too-many", data: "YQ==" }),
    /12 tệp/,
  );
  await fs.symlink(os.tmpdir(), path.join(store.root, "escape"));
  await assert.rejects(store.drafts("escape"), /Unsafe/);
});
test("Attachment-only messages queue real durable paths; no prompt is sent after setting failure", async (t) => {
  const store = await vault(t),
    a = await store.stage("s", {
      name: "asset.png",
      data: png.toString("base64"),
    });
  let message,
    sendCount = 0;
  const cli = async (args) => {
    if (args[1] === "show")
      return { id: "s", tool: "claude", status: "waiting" };
    sendCount++;
    message = await fs.readFile(
      args[args.indexOf("--message-file") + 1],
      "utf8",
    );
    return { send_id: "receipt", state: "queued" };
  };
  const chat = new Conversations({
    cli,
    homes: [],
    attachments: store,
    applySettings: async () => {
      throw new Error("blocked draft");
    },
  });
  await assert.rejects(
    chat.send("s", "hello", { settings: { model: "opus" } }),
    /blocked/,
  );
  assert.equal(sendCount, 0);
  await chat.send("s", "", { attachments: [a.id] });
  assert(message.includes("@" + store.root + "/s/"));
  assert.equal(sendCount, 1);
  assert.deepEqual(await store.drafts("s"), []);
  assert((await store.open("s", a.id)).src);
});
test("First prompt naming skips system/tool/sidechain/local commands and handles Unicode and placeholder variants", () => {
  const rows = [
    { type: "user", isMeta: true, message: { content: "ignore" } },
    { type: "user", isSidechain: true, message: { content: "ignore" } },
    {
      type: "user",
      message: { content: [{ type: "tool_result", content: "ignore" }] },
    },
    {
      type: "user",
      message: { content: "<local-command-stdout>Set model to Opus" },
    },
    { type: "user", message: { content: "/effort high" } },
    {
      type: "user",
      message: {
        content: [{ type: "text", text: "Sửa lỗi đăng nhập\ncho ứng dụng 📱" }],
      },
    },
  ];
  assert.equal(
    promptTitle(rows.map(JSON.stringify).join("\n")),
    "Sửa lỗi đăng nhập cho ứng dụng 📱",
  );
  assert(placeholder("New conversation (3)"));
  assert(!placeholder("My new conversation"));
  assert(
    Array.from(
      promptTitle(
        JSON.stringify({
          type: "user",
          message: { content: "Thiết kế giao diện ứng dụng ".repeat(30) },
        }),
      ),
    ).length <= 72,
  );
});
test("Auto-name locks the first title, avoids duplicates, and never overwrites manual titles; rename is native and validated", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deck-titles-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "transcript");
  await fs.writeFile(
    file,
    JSON.stringify({ type: "user", message: { content: "Fix layout" } }),
  );
  const state = {
      s: { id: "s", path: "/web", title: "New conversation", tool: "claude" },
      locked: {
        id: "locked",
        title: "New conversation",
        tool: "claude",
        title_locked: true,
      },
      named: { id: "named", title: "User title", tool: "claude" },
    },
    calls = [];
  const cli = async (args) => {
    calls.push(args);
    const s = state[args[2]];
    if (args[1] === "show") return { ...s };
    if (args[1] === "set") {
      s.title = args[4];
      s.title_locked = true;
      return { success: true };
    }
  };
  const service = new ConversationTitles({
    cli,
    conversations: { meta: new Map(), transcript: async () => file },
  });
  await service.reconcile(
    [
      ...Object.values(state),
      { id: "other", path: "/web", title: "Fix layout" },
    ].map((s) => ({ ...s })),
  );
  assert.equal(state.s.title, "Fix layout · s");
  assert.equal(state.locked.title, "New conversation");
  assert.equal(state.named.title, "User title");
  await service.rename("s", "Tên của tôi");
  assert.equal(state.s.title, "Tên của tôi");
  await service.reconcile(Object.values(state));
  assert.equal(state.s.title, "Tên của tôi");
  await assert.rejects(service.rename("s", "line\nbreak"), /một dòng/);
  await assert.rejects(service.rename("s", " ".repeat(4)), /1–120/);
});
test("Model catalog uses native capability levels; commands need an acknowledgement rather than an echoed slash command", () => {
  const models = modelCatalog({
    models: [
      {
        value: "opus",
        resolvedModel: "claude-opus-5-5",
        displayName: "Opus 5.5",
        supportsEffort: true,
        supportedEffortLevels: ["low", "xhigh", "evil"],
      },
      { value: "bad\ncommand", displayName: "Invalid" },
    ],
  });
  assert.equal(models.length, 1);
  assert.deepEqual(models[0].efforts, ["low", "xhigh"]);
  assert.equal(commandResult("❯ /model opus", "model"), null);
  assert.equal(
    commandResult("⎿ Set model to Opus 5.5 and saved as your default", "model")
      .value,
    "Opus 5.5",
  );
  assert.match(
    commandResult(
      "Model 'opus' is restricted by your organization's settings.",
      "model",
    ).error,
    /restricted/,
  );
  assert.equal(
    commandResult(
      "Set effort level to high (saved as your default for new sessions): Comprehensive",
      "effort",
    ).value,
    "high",
  );
  const capped = commandResult(
    "Effort 'max' exceeds the cap for opus set by your settings or organization; set to 'high' instead (this session only): x",
    "effort",
  );
  assert.equal(capped.value, "high");
  assert.match(capped.notice, /giới hạn/);
  assert.match(
    commandResult(
      "Not applied: CLAUDE_CODE_EFFORT_LEVEL=low overrides effort this session",
      "effort",
    ).error,
    /CLAUDE_CODE_EFFORT_LEVEL=low/,
  );
  assert.equal(
    promptTitle(
      JSON.stringify({
        type: "user",
        message: {
          content: '<pasted_content id="a">Copy email v3</pasted_content>',
        },
      }),
    ),
    "Copy email v3",
  );
});
test("Live settings refuse busy/draft/menu targets and do not claim success from transport alone", async () => {
  let sent = 0,
    output = "❯ ",
    busy = false;
  const service = new ChatSettings({
    cli: async (args) => {
      if (args[1] === "send") {
        sent++;
        return { success: true };
      }
      return { success: true };
    },
    conversations: {
      meta: new Map(),
      session: async () => ({
        id: "s",
        tool: "claude",
        status: busy ? "running" : "waiting",
        account: "Huy",
        tmux_session: "agentdeck_fixture",
      }),
    },
    accounts: [{ slot: "Huy", home: "/fixture" }],
    paths: { claude: "/claude", home: "/tmp", mux: "/tmux" },
    env: {},
    run: async () => ({ stdout: output }),
    probe: async () => [
      {
        value: "opus",
        name: "Opus 5.5",
        supportsEffort: true,
        efforts: ["low", "high"],
      },
    ],
    sleep: async () => {},
  });
  busy = true;
  await assert.rejects(service.apply("s", { model: "opus" }), /Đợi Claude/);
  assert.equal(sent, 0);
  busy = false;
  await assert.rejects(service.apply("s", { model: "opus" }), /Chưa xác nhận/);
  assert.equal(sent, 1);
  assert.equal(service.applied.size, 0);
  await assert.rejects(
    service.apply("s", { model: "opus", effort: "max" }),
    /không hỗ trợ/,
  );
  assert.equal(sent, 1);
  service.cli = async (args) => {
    if (args[1] === "send") {
      output += "\n❯ /model opus\n  ⎿  Set model to Opus 5.5";
      sent++;
    }
    return { success: true };
  };
  assert.equal((await service.apply("s", { model: "opus" })).model, "opus");
});
test("Current model comes from Claude's footer or transcript, not the start-up banner", () => {
  const models = [
    { name: "Opus 5.5", value: "opus", resolved: "claude-opus-5-5" },
    { name: "Sonnet 5.5", value: "sonnet", resolved: "claude-sonnet-5-5" },
  ];
  const screen = screenSettings(
    " ▝▜██ Opus 5.5 · Team\n────────\n❯ \n────────\n  Sonnet 5.5 · low effort\n",
    models,
  );
  assert.equal(screen.footerModel.name, "Sonnet 5.5");
  assert.equal(screen.footerEffort, "low");
  const row = (value) => JSON.stringify(value),
    command = (text) =>
      row({
        type: "user",
        message: { content: "<local-command-stdout>" + text },
      });
  const recent = transcriptSettings(
    [
      row({ type: "assistant", message: { model: "claude-opus-5-5" } }),
      command("Set model to Sonnet 5.5"),
      command("Effort 'max' exceeds the cap; set to 'high' instead"),
    ].join("\n"),
    models,
  );
  assert.equal(recent.model.name, "Sonnet 5.5");
  assert.equal(recent.effort, "high");
});
test("Only a failed delivery returns its files to the draft", async (t) => {
  const store = await vault(t);
  let status = { session_id: "s1", state: "typed", settled: true };
  const conversations = new Conversations({
    cli: async (args) =>
      args[1] === "show"
        ? {
            id: "s1",
            tool: "claude",
            status: "waiting",
            claude_session_id: "x",
          }
        : args[1] === "send"
          ? { send_id: "d1", state: "queued", verdict: "queued" }
          : status,
    homes: [],
    attachments: store,
  });
  const file = await store.stage("s1", {
    name: "a.txt",
    data: Buffer.from("a").toString("base64"),
  });
  await conversations.send("s1", "hi", { attachments: [file.id] });
  assert.equal((await store.drafts("s1")).length, 0);
  await assert.rejects(conversations.restore("s1", "d1"), /không khôi phục/);
  status = { session_id: "s1", state: "failed" };
  assert.equal((await conversations.restore("s1", "d1")).attachments.length, 1);
  assert.equal((await store.drafts("s1")).length, 1);
});
test("Effort is confirmed from the transcript reply, including an organization cap", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deck-effort-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "t.jsonl"),
    reply = (text) =>
      JSON.stringify({
        type: "user",
        message: { content: "<local-command-stdout>" + text },
      }) + "\n";
  await fs.writeFile(file, reply("Set effort level to low: old reply"));
  let answer = "";
  const service = new ChatSettings({
    cli: async (args) => {
      if (args[1] === "send") await fs.appendFile(file, reply(answer));
      return { success: true };
    },
    conversations: {
      meta: new Map(),
      transcript: async () => file,
      session: async () => ({
        id: "s",
        tool: "claude",
        status: "waiting",
        account: "Huy",
        tmux_session: "agentdeck_fixture",
      }),
    },
    accounts: [{ slot: "Huy", home: "/fixture" }],
    paths: { claude: "/claude", home: "/tmp", mux: "/tmux" },
    env: {},
    run: async () => ({ stdout: "" }),
    probe: async () => [],
    sleep: async () => {},
  });
  answer =
    "Effort 'max' exceeds the cap for opus set by your settings or organization; set to 'high' instead (this session only): x";
  const capped = await service.apply("s", { effort: "max" });
  assert.equal(capped.effort, "high");
  assert.match(capped.notice, /high thay cho max/);
  answer = "Failed to set effort level: settings file is read-only";
  await assert.rejects(service.apply("s", { effort: "low" }), /read-only/);
});
