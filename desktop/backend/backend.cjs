const fs = require("fs"),
  fsp = require("fs/promises"),
  path = require("path"),
  os = require("os"),
  net = require("net"),
  readline = require("readline"),
  { execFile, spawn } = require("child_process"),
  { promisify } = require("util"),
  pty = require("node-pty");
const { Repository } = require("./repository.cjs"),
  run = promisify(execFile),
  home = os.homedir(),
  root = home + "/.config/agent-deck";
const { stopServers, stopHelpers } = require("./lifecycle.cjs");
const { Conversations } = require("./conversation.cjs");
const { Workspaces } = require("./workspaces.cjs");
const { SessionActions } = require("./session-actions.cjs");
const { Attachments } = require("./attachments.cjs");
const { ConversationTitles } = require("./conversation-titles.cjs");
const { ChatSettings } = require("./chat-settings.cjs");
const { usageSummary } = require("./usage-summary.cjs");
const { Scrollback, OutputBatcher } = require("./terminal-output.cjs");
const { MessageQueue } = require("./message-queue.cjs");
const { AgentActivity } = require("./agent-activity.cjs");
const {
  terminalInput: safeTerminalInput,
  recoverClaude,
} = require("./terminal-control.cjs");
const paths = require(root + "/paths"),
  panels = require(root + "/panels"),
  registry = require(root + "/account-registry"),
  extensions = require(root + "/claude-skills");
const projects = JSON.parse(
  fs.readFileSync(root + "/windows-projects.json", "utf8"),
);
const workspaces = new Workspaces({
  defaults: projects,
  file: root + "/desktop-folders.json",
  run,
  tmux: paths.mux,
});
const workspaceReady = workspaces.initialize();
let sessionContexts = new Map();
const attachments = new Attachments(root + "/desktop-attachments");
const conversations = new Conversations({
  cli: (args) => cli(args),
  homes: [home + "/.claude", ...registry.accounts.map((a) => a.home)],
  attachments,
  applySettings: (id, selection) => chatSettings.apply(id, selection),
});
const conversationTitles = new ConversationTitles({ cli, conversations });
const chatSettings = new ChatSettings({
  cli,
  conversations,
  accounts: registry.accounts,
  paths,
  env: require(root + "/terminal-env"),
  run,
});
// Claude must really be running in the pane before anything is typed: a send
// into a pane that is still restarting is lost without trace.
async function paneReady(row) {
  if (!/^agentdeck_[\w-]+$/.test(row?.tmux_session || "")) return false;
  try {
    const { stdout } = await run(
      paths.mux,
      [
        "-L",
        "agent-deck-managed",
        "display-message",
        "-p",
        "-t",
        row.tmux_session,
        "#{pane_current_command}",
      ],
      { encoding: "utf8", timeout: 3000 },
    );
    return stdout.trim() === "claude";
  } catch {
    return false;
  }
}
const messageQueue = new MessageQueue({
  file: root + "/desktop-queue.json",
  conversations,
  attachments,
  row: (id) => sessions.find((s) => s.id === id),
  refresh: () => updateSessions(),
  paneReady,
  emit: (data) => send(data),
});
const queueReady = messageQueue.load();
const agentActivity = new AgentActivity({ conversations });
const sessionActions = new SessionActions({
  cli,
  conversations,
  clearPanels: clearSessionPanels,
  attachments,
});
let usageForceAt = 0;
async function clearSessionPanels(id) {
  const workspaces = fs
    .readdirSync(root + "/panels")
    .filter((name) => panels.WORKSPACE.test(name));
  for (const deck of workspaces)
    for (let slot = 1; slot <= 6; slot++) {
      const panel = panels.read(deck, slot);
      if (panel.lastId !== id && panel.chatId !== id) continue;
      panels.write(deck, slot, {
        lastId: "",
        chatId: "",
        showing: false,
        view: "empty",
      });
      try {
        panels.request({ ...panel, workspace: deck, slot }, { menu: true });
      } catch {}
    }
}
function chatSession(slot, id) {
  const panel = panels.read(workspace, slotNumber(slot));
  if (panel.view !== "chat" || panel.chatId !== id)
    throw new Error("Hội thoại đã đổi. Chọn lại terminal trước khi gửi.");
  return id;
}
// Windows Terminal of the signed-in Windows user, found once.
let terminalApp = null;
async function windowsTerminal() {
  terminalApp ??= (async () => {
    const { stdout } = await run(
      "/mnt/c/Windows/System32/cmd.exe",
      ["/d", "/c", "echo %LOCALAPPDATA%"],
      { cwd: "/mnt/c", encoding: "utf8", timeout: 10000 },
    );
    const local = (
      await run("/usr/bin/wslpath", ["-u", stdout.trim()], { encoding: "utf8" })
    ).stdout.trim();
    const file = local + "/Microsoft/WindowsApps/wt.exe";
    if (!fs.existsSync(file))
      throw new Error("Cần Windows Terminal để mở cửa sổ đăng nhập");
    return file;
  })().catch((error) => {
    terminalApp = null;
    throw error;
  });
  return terminalApp;
}
function sessionAccount(session) {
  const account = registry.accounts.find(
    (a) =>
      a.tool === "claude" &&
      (a.slot === session.account || a.name === session.account),
  );
  if (!account) throw new Error("Không tìm được tài khoản Claude");
  return account;
}
const socket = root + "/desktop.sock",
  stateFile = root + "/desktop-state.json";
let workspace = "claude-desk-100",
  active = 1,
  stopping = false,
  initialized = false,
  initializing = null,
  sessions = [],
  lastSessions = 0,
  refreshing = null,
  reconciling = null;
try {
  const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (/^claude-desk-1\d{2,}$/.test(saved.workspace))
    workspace = saved.workspace;
} catch {}
const terminals = new Map(),
  buffers = new Map();
function send(data) {
  if (!process.stdout.destroyed)
    process.stdout.write(JSON.stringify(data) + "\n");
}
function event(type, data = {}) {
  send({ type, ...data });
}
const output = new OutputBatcher((slot, data) =>
  event("terminal-data", { slot, data }),
);
function repo(id) {
  return workspaces.repo(id);
}
function slotNumber(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 6)
    throw new Error("Invalid terminal");
  return n;
}
async function cli(args) {
  return JSON.parse(
    (
      await run(paths.deck, args, {
        encoding: "utf8",
        env: {
          ...require(root + "/terminal-env"),
          AGENTDECK_PROFILE: "default",
        },
        timeout: 45000,
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout,
  );
}
async function updateSessions(force = false) {
  if (refreshing) return refreshing;
  if (!force && Date.now() - lastSessions < 3000) return sessions;
  refreshing = cli(["list", "--json"])
    .then((rows) => {
      sessions = rows;
      lastSessions = Date.now();
      // Naming can read transcripts and invoke the CLI several times. Keep it
      // off the path that connects the terminals, and allow only one pass.
      if (!reconciling)
        reconciling = conversationTitles
          .reconcile(rows)
          .catch((error) =>
            console.error("Conversation titles: " + error.message),
          )
          .finally(() => (reconciling = null));
      return rows;
    })
    .finally(() => (refreshing = null));
  return refreshing;
}
function seed() {
  for (let n = 1; n <= 6; n++) {
    const current = panels.read(workspace, n);
    if (current.path || current.lastId) continue;
    const old =
      workspace === "claude-desk-100" ? panels.read("claude-desk", n) : {};
    const { pid, tty, view, chatId, ...saved } = old;
    panels.write(workspace, n, {
      ...saved,
      path: saved.path || (n % 2 ? projects.web : projects.mobile),
      showing: !!saved.showing,
    });
  }
}
function startTerminal(slot, cols = 80, rows = 24) {
  slot = slotNumber(slot);
  const previous = terminals.get(slot);
  if (previous) {
    // The history already holds what is still queued; a reopened view would
    // otherwise print it twice.
    output.drop(slot);
    return { buffer: buffers.get(slot)?.text() || "" };
  }
  const env = {
    ...require(root + "/terminal-env"),
    AGENT_DECK_WORKSPACE: workspace,
    AGENT_DECK_DESKTOP_SOCKET: socket,
    AGENTDECK_PROFILE: "default",
    TERM: "xterm-256color",
  };
  delete env.TMUX;
  const terminal = pty.spawn(
    "/bin/bash",
    [
      home + "/.local/bin/agent-deck-run",
      workspace,
      root + "/panel.js",
      String(slot),
      "--restore",
    ],
    {
      name: "xterm-256color",
      cols: Math.max(20, Math.min(500, cols)),
      rows: Math.max(6, Math.min(200, rows)),
      cwd: home,
      env,
    },
  );
  terminals.set(slot, terminal);
  const history = new Scrollback();
  buffers.set(slot, history);
  terminal.onData((data) => {
    // A terminal killed by a deck switch can still flush its last output.
    if (terminals.get(slot) !== terminal) return;
    history.push(data);
    output.push(slot, data);
  });
  terminal.onExit(({ exitCode }) => {
    if (terminals.get(slot) === terminal) {
      terminals.delete(slot);
      output.flush(slot);
      event("terminal-exit", { slot, exitCode });
    }
  });
  return { buffer: "" };
}
async function snapshot() {
  await updateSessions();
  const live = await workspaces.livePaths(),
    contexts = await Promise.all(
      sessions
        .filter((s) => !s.archived)
        .map(async (s) => [
          s.id,
          await workspaces.sessionContext(s, s.path, live),
        ]),
    );
  sessionContexts = new Map(contexts);
  const panelRows = await Promise.all(
    Array.from({ length: 6 }, async (_, i) => {
      const slot = i + 1,
        s = panels.read(workspace, slot),
        session = sessions.find((row) => row.id === (s.chatId || s.lastId));
      const context =
        sessionContexts.get(session?.id) ||
        (await workspaces.sessionContext(
          null,
          s.path || (slot % 2 ? projects.web : projects.mobile),
        ));
      return { ...s, ...context, slot, session };
    }),
  );
  // New worktrees appear on the next snapshot; discovery must not hold up all
  // six terminals while Git probes every repository on a Windows drive.
  void workspaces
    .discover()
    .catch((error) => console.error("Workspace discovery: " + error.message));
  const accountUsage = require(root + "/account-usage"),
    usage = accountUsage.read();
  const expired = Object.values(usage.accounts || {}).some(
    (value) => usageSummary(value).expired,
  );
  const force = expired && Date.now() - usageForceAt > 60000;
  if (force) usageForceAt = Date.now();
  accountUsage.refresh(force);
  return {
    workspace,
    active,
    projects: workspaces.list(),
    accounts: registry.accounts.map((a) => ({
      slot: a.slot,
      name: a.name,
      email: a.email,
      usage: usage.accounts?.[a.slot] || { status: "checking" },
      quota: usageSummary(usage.accounts?.[a.slot]),
    })),
    sessions: sessions.map((s) => ({ ...s, ...sessionContexts.get(s.id) })),
    panels: panelRows,
    decks: fs
      .readdirSync(root + "/panels")
      .filter((name) => /^claude-desk-1\d{2,}$/.test(name))
      .sort(),
  };
}
async function switchDeck(next) {
  if (!/^claude-desk-1\d{2,}$/.test(next)) throw new Error("Invalid deck");
  for (const terminal of terminals.values()) terminal.kill();
  terminals.clear();
  buffers.clear();
  output.drop();
  workspace = next;
  fs.writeFileSync(stateFile, JSON.stringify({ workspace }), { mode: 0o600 });
  seed();
  event("deck-changed", { workspace });
  return snapshot();
}
async function shutdown(stopAgents) {
  if (stopping) return;
  stopping = true;
  clearInterval(ticker);
  clearInterval(queueTicker);
  for (const terminal of terminals.values())
    try {
      terminal.kill();
    } catch {}
  terminals.clear();
  if (stopAgents) {
    // Only the two servers owned by this Agent Deck installation are stopped.
    await stopServers(paths.mux, [
      "agent-deck-managed",
      "agent-deck-workspace",
    ]);
    stopHelpers(root, paths.deck);
  }
  server.close();
  // A newer backend may already own the path; only remove our own socket.
  try {
    if (fs.statSync(socket).ino === socketInode) fs.unlinkSync(socket);
  } catch {}
}
const methods = {
  async initialize() {
    if (!initializing) {
      initializing = (async () => {
        seed();
        await Promise.all([
          workspaceReady,
          run(process.execPath, [root + "/workspace.js", "configure"], {
            env: {
              ...require(root + "/terminal-env"),
              AGENT_DECK_WORKSPACE: workspace,
              AGENT_DECK_DESKTOP_SOCKET: socket,
              AGENTDECK_PROFILE: "default",
            },
            timeout: 15000,
          }),
        ]);
        await run(
          paths.mux,
          [
            "-L",
            "agent-deck-managed",
            "set-environment",
            "-g",
            "PATH",
            require(root + "/terminal-env").PATH,
          ],
          { timeout: 3000 },
        ).catch(() => {});
        await updateSessions(true);
        const initial = await snapshot();
        initialized = true;
        // Use cached account data on a warm restart. Expired quotas are still
        // refreshed by snapshot(), and suspended agents recover in the background.
        setImmediate(() => {
          if (stopping) return;
          void Promise.allSettled(
            sessions
              .filter(
                (s) => s.tool === "claude" && !s.archived && s.tmux_session,
              )
              .map((s) => recoverClaude(paths.mux, s.tmux_session)),
          );
        });
        return initial;
      })().catch((error) => {
        initializing = null;
        throw error;
      });
      return initializing;
    }
    await initializing;
    return snapshot();
  },
  snapshot,
  terminalStart: ({ slot, cols, rows }) => startTerminal(slot, cols, rows),
  terminalInput: ({ slot, data }) => {
    if (typeof data !== "string" || data.length > 1024 * 1024)
      throw new Error("Invalid input");
    active = slotNumber(slot);
    // Ctrl+Z becomes input undo unless the pane is known to run another
    // tool (Codex, a shell); an unlisted new chat is treated as Claude so
    // it is never suspended.
    const panel = panels.read(workspace, active),
      tool =
        panel.view === "chat" &&
        sessions.find((s) => s.id === panel.chatId)?.tool;
    terminals
      .get(active)
      ?.write(tool && tool !== "claude" ? data : safeTerminalInput(data));
    return true;
  },
  terminalResize: ({ slot, cols, rows }) => {
    slot = slotNumber(slot);
    if (Number.isFinite(cols) && Number.isFinite(rows))
      terminals
        .get(slot)
        ?.resize(
          Math.max(20, Math.min(500, Math.floor(cols))),
          Math.max(6, Math.min(200, Math.floor(rows))),
        );
    return true;
  },
  async recoverTerminal({ slot }) {
    const panel = panels.read(workspace, slotNumber(slot));
    await updateSessions(true);
    const session = sessions.find(
      (s) => s.id === (panel.chatId || panel.lastId),
    );
    if (!session?.tmux_session || session.tool !== "claude")
      throw new Error("Mở hội thoại Claude trước khi khôi phục");
    return recoverClaude(paths.mux, session.tmux_session);
  },
  async sessionAction({ id, action, deleteHistory }) {
    const result = await sessionActions.mutate(id, action, { deleteHistory });
    await updateSessions(true);
    const data = await snapshot();
    event("snapshot", { snapshot: data });
    return { ...result, snapshot: data };
  },
  visibility({ hidden: value }) {
    hidden = value === true;
    // Push the current state as soon as the window comes back.
    if (!hidden) lastPushed = "";
    return true;
  },
  refreshUsage() {
    require(root + "/account-usage").refresh(true);
    return true;
  },
  panelAction: ({ slot, action, account, project }) => {
    slot = slotNumber(slot);
    active = slot;
    const panel = { ...panels.read(workspace, slot), workspace, slot };
    if (action === "focus") {
      event("focus-panel", { slot });
      return true;
    }
    if (action === "menu" || action === "continue") {
      if (
        !panels.request(
          panel,
          action === "menu" ? { menu: true } : { continue: true },
        )
      )
        throw new Error("Panel is starting; try again");
      return true;
    }
    if (action === "project") {
      const selected = repo(project);
      if (panel.view === "chat" || panel.view === "opening")
        throw new Error(
          "Use the account menu before changing this panel’s project",
        );
      panels.write(workspace, slot, { path: selected.root });
      panels.request(panel, { menu: true });
      return true;
    }
    if (action === "account") {
      const index = registry.accounts.findIndex((a) => a.slot === account);
      if (index < 0) throw new Error("Unknown account");
      if (panel.view !== "empty")
        throw new Error("Open the account menu to start a new chat");
      terminals.get(slot)?.write(String(index + 1));
      return true;
    }
    throw new Error("Unknown panel action");
  },
  async openSession({ id, slot }) {
    active = slotNumber(slot || active);
    await updateSessions(true);
    const row = sessions.find((s) => s.id === id);
    if (!row) throw new Error("Session no longer exists");
    const existing = Array.from({ length: 6 }, (_, i) => i + 1).find((n) => {
      const s = panels.read(workspace, n);
      return s.chatId === id && s.view === "chat";
    });
    if (existing) {
      event("focus-panel", { slot: existing });
      return true;
    }
    const panel = {
      ...panels.read(workspace, active),
      slot: active,
      workspace,
    };
    if (!panels.request(panel, { open: id }))
      throw new Error("Panel is starting; try again");
    event("focus-panel", { slot: active });
    return true;
  },
  switchDeck: ({ workspace: next }) => switchDeck(next),
  async newDeck() {
    let n = 101;
    while (fs.existsSync(root + "/panels/claude-desk-" + n)) n++;
    return switchDeck("claude-desk-" + n);
  },
  async gitInfo({ project, force }) {
    if (force) await workspaces.discover(true);
    return repo(project).info(force === true);
  },
  async openLocation({ path, project, pin = true }) {
    const result = await workspaces.open(path, { project, pin });
    const next = await snapshot();
    event("snapshot", { snapshot: next });
    return { ...result, snapshot: next };
  },
  async worktreeCreate({ project, ...options }) {
    const created = await repo(project).createWorktree(options);
    const entry = await workspaces.add(created.path, {
      pinned: true,
      kind: "worktree",
      parent: project,
    });
    await workspaces.save();
    await workspaces.discover(true);
    const next = await snapshot();
    event("snapshot", { snapshot: next });
    return { ...created, project: entry.id, snapshot: next };
  },
  async branchSwitch({ project, branch }) {
    await snapshot();
    if (
      sessions.some(
        (s) =>
          s.status === "running" &&
          sessionContexts.get(s.id)?.project === project,
      )
    )
      throw new Error(
        "Có agent đang xử lý trong thư mục này. Đợi agent xong hoặc tạo worktree riêng.",
      );
    const info = await repo(project).switchBranch(branch);
    await workspaces.discover(true);
    const next = await snapshot();
    event("snapshot", { snapshot: next });
    return { info, snapshot: next };
  },
  async newConversation({ project, slot, account }) {
    slot = slotNumber(slot);
    const folder = repo(project).root,
      a = registry.accounts.find(
        (a) => a.slot === account && a.tool === "claude",
      );
    if (!a) throw new Error("Chọn tài khoản Claude");
    const auth = JSON.parse(
      (
        await run(paths.claude, ["auth", "status"], {
          env: {
            ...require(root + "/terminal-env"),
            CLAUDE_CONFIG_DIR: a.home,
          },
          timeout: 25000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout,
    );
    if (!auth.loggedIn || auth.email !== a.email)
      throw new Error("Đăng nhập đúng tài khoản trước khi mở chat");
    await updateSessions(true);
    let n = 1,
      title = "New conversation";
    while (sessions.some((s) => s.path === folder && s.title === title))
      title = "New conversation (" + ++n + ")";
    const created = await cli([
      "add",
      folder,
      "-c",
      "claude",
      "--account",
      a.slot,
      "--title",
      title,
      "--no-parent",
      "--json",
    ]);
    const id = created.id || created.session_id;
    if (!id) throw new Error("Claude chưa trả mã hội thoại");
    await cli(["session", "set-title-lock", id, "off", "--json"]);
    const panel = { ...panels.read(workspace, slot), slot, workspace };
    const opened = panels.request(panel, { open: id });
    await updateSessions(true);
    const next = await snapshot();
    event("snapshot", { snapshot: next });
    if (opened) event("focus-panel", { slot });
    return { id, opened, snapshot: next };
  },
  changes: ({ project, ...options }) => repo(project).changes(options),
  gitCommits: ({ project, ...options }) => repo(project).commits(options),
  tree: ({ project, path }) => repo(project).tree(path),
  file: ({ project, path }) => repo(project).file(path),
  save: ({ project, path, text, version }) =>
    workspaces.writable(project).save(path, text, version),
  diff: ({ project, path, ...options }) => repo(project).diff(path, options),
  chatHistory: ({ slot, id, ...options }) =>
    conversations.history(chatSession(slot, id), options),
  async chatSend({ slot, id, text, attachments: files, settings }) {
    const target = chatSession(slot, id);
    await updateSessions();
    if (!(await paneReady(sessions.find((s) => s.id === target))))
      throw new Error(
        "Claude chưa chạy trong terminal này. Tin được giữ lại; gửi vào hàng chờ để tự gửi khi Claude sẵn sàng.",
      );
    return conversations.send(target, text, { attachments: files, settings });
  },
  chatQueue: async ({ slot, id }) => {
    await queueReady;
    return messageQueue.view(chatSession(slot, id));
  },
  chatEnqueue: async ({ slot, id, text, attachments: files, settings }) => {
    await queueReady;
    return messageQueue.enqueue(chatSession(slot, id), {
      text,
      attachments: files,
      settings,
    });
  },
  chatQueueRemove: ({ slot, id, qid }) =>
    messageQueue.remove(chatSession(slot, id), qid),
  chatQueueRetry: ({ slot, id, qid }) =>
    messageQueue.retry(chatSession(slot, id), qid),
  chatQueueSteer: ({ slot, id, qid }) =>
    messageQueue.steer(chatSession(slot, id), qid),
  chatAgents: ({ slot, id }) => agentActivity.list(chatSession(slot, id)),
  chatModels: ({ slot, id, force }) =>
    chatSettings.catalog(chatSession(slot, id), force === true),
  chatApplySettings: ({ slot, id, settings }) =>
    chatSettings.apply(chatSession(slot, id), settings),
  attachmentStage: ({ slot, id, ...file }) =>
    attachments.stage(chatSession(slot, id), file),
  attachmentDrafts: ({ slot, id }) => attachments.drafts(chatSession(slot, id)),
  attachmentRemove: ({ slot, id, attachment }) =>
    attachments.remove(chatSession(slot, id), attachment),
  attachmentOpen: async ({ id, attachment }) => {
    await conversations.session(id);
    return attachments.open(id, attachment);
  },
  async renameSession({ id, title }) {
    const result = await conversationTitles.rename(id, title);
    await updateSessions(true);
    const next = await snapshot();
    event("snapshot", { snapshot: next });
    return { ...result, snapshot: next };
  },
  // Skills, slash commands and plugins of the account running this chat.
  async claudeExtensions({ slot, id }) {
    const session = await conversations.session(chatSession(slot, id)),
      account = sessionAccount(session);
    return {
      account: account.name,
      ...extensions.catalog(account.home, session.path),
    };
  },
  // Takes effect in new chats, or after /reload-plugins in a running one.
  async claudePluginToggle({ slot, id, plugin, enabled }) {
    if (typeof plugin !== "string" || !/^[\w.-]+@[\w.-]+$/.test(plugin))
      throw new Error("Plugin không hợp lệ");
    const account = sessionAccount(
      await conversations.session(chatSession(slot, id)),
    );
    await run(
      paths.claude,
      ["plugin", enabled ? "enable" : "disable", plugin, "--scope", "user"],
      {
        env: { ...process.env, CLAUDE_CONFIG_DIR: account.home },
        timeout: 60000,
      },
    );
    return extensions.plugins(account.home).find((p) => p.id === plugin);
  },
  chatSendStatus: ({ id }) => conversations.status(id),
  chatRestoreDraft: ({ slot, id, sendId }) =>
    conversations.restore(chatSession(slot, id), sendId),
  async openReference({ project, reference }) {
    const result = await workspaces.open(reference, { project });
    if (result.kind === "directory")
      throw new Error("Đây là thư mục. Dùng Mở thư mục để xem cây file.");
    event("snapshot", { snapshot: await snapshot() });
    return result;
  },
  async login({ account }) {
    const a = registry.accounts.find((a) => a.slot === account);
    if (!a) throw new Error("Unknown account");
    spawn(
      await windowsTerminal(),
      [
        "new-tab",
        "--title",
        "Agent Deck - " + a.name + " login",
        "wsl.exe",
        "-d",
        process.env.WSL_DISTRO_NAME || "Ubuntu-24.04",
        "-u",
        os.userInfo().username,
        "--exec",
        home + "/.local/bin/agent-deck-login",
        a.slot.toLowerCase(),
      ],
      { detached: true, stdio: "ignore" },
    ).unref();
    return true;
  },
  async shutdown({ stopAgents }) {
    await shutdown(stopAgents === true);
    return true;
  },
};
const server = net.createServer((connection) => {
  let input = "";
  connection.on("data", async (chunk) => {
    input += chunk;
    const end = input.indexOf("\n");
    if (end < 0) return;
    try {
      const message = JSON.parse(input.slice(0, end));
      let slot = active;
      if (message.tty) {
        for (let n = 1; n <= 6; n++)
          if (panels.read(workspace, n).tty === message.tty) slot = n;
      }
      let result = {};
      switch (message.cmd) {
        case "ping":
          break;
        case "active":
          result = { slot: active };
          break;
        case "focus":
        case "focus-panel":
          active = slot;
          event("focus-panel", { slot });
          break;
        case "flash":
          event("flash-panel", { slot });
          break;
        case "zoom":
          event("zoom-panel", { slot });
          break;
        case "list-view":
          event("show-sidebar", { mode: message.mode });
          break;
        case "notify":
          event("notice", { message: message.text });
          break;
        case "new":
          await methods.newDeck();
          break;
        case "open":
        case "show":
          event("show-window");
          break;
        default:
          throw new Error("Unknown desktop action");
      }
      connection.end(JSON.stringify({ ok: true, ...result }) + "\n");
    } catch (error) {
      connection.end(
        JSON.stringify({ ok: false, error: error.message }) + "\n",
      );
    }
  });
  connection.on("error", () => {});
});
try {
  fs.unlinkSync(socket);
} catch {}
let socketInode;
server.listen(socket, () => {
  fs.chmodSync(socket, 0o600);
  socketInode = fs.statSync(socket).ino;
  event("ready");
});
const input = readline.createInterface({ input: process.stdin });
input.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    if (!Object.hasOwn(methods, request.method))
      throw new Error("Unknown method");
    if (request.method !== "initialize") await workspaceReady;
    const result = await methods[request.method](request.args || {});
    send({ id: request.id, result });
    if (request.method === "shutdown") setTimeout(() => process.exit(0), 100);
  } catch (error) {
    send({ id: request?.id, error: error.message });
  }
});
input.on("close", () => shutdown(false).finally(() => process.exit(0)));
process.on("SIGTERM", () => shutdown(false).finally(() => process.exit(0)));
let ticking = false,
  hidden = false,
  ticks = 0,
  lastPushed = "";
const queueTicker = setInterval(
  () =>
    void queueReady
      .then(() => messageQueue.tick())
      .catch((error) => console.error("Message queue: " + error.message)),
  2000,
);
const ticker = setInterval(async () => {
  if (!initialized || stopping || ticking) return;
  // Behind the tray nobody watches; refresh every 15 s instead of every 3 s.
  if (hidden && ++ticks % 5) return;
  ticking = true;
  try {
    const next = await snapshot(),
      // The countdown is recomputed by the window; ignore it when comparing.
      signature = JSON.stringify(next, (key, value) =>
        key === "remainingMs" ? undefined : value,
      );
    if (signature !== lastPushed) {
      lastPushed = signature;
      event("snapshot", { snapshot: next });
    }
  } catch (error) {
    event("error", { message: error.message });
  } finally {
    ticking = false;
  }
}, 3000);
