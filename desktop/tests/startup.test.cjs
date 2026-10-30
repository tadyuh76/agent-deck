const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path"),
  vm = require("vm"),
  { EventEmitter } = require("events"),
  { promisify } = require("util");
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function backendFixture() {
  const configured = deferred(),
    workspace = deferred(),
    discovery = deferred(),
    titles = deferred(),
    recovery = deferred(),
    input = new EventEmitter(),
    output = [],
    calls = [],
    immediate = [];
  const root = "/home/test/.config/agent-deck";
  const rows = [
    {
      id: "first-chat",
      tool: "claude",
      path: "/project",
      tmux_session: "agentdeck_first",
      title: "New conversation",
    },
  ];
  let configureCalls = 0,
    initializeCalls = 0,
    titleCalls = 0,
    recoveryCalls = 0;
  const execFile = () => {};
  execFile[promisify.custom] = async (file, args) => {
    calls.push(args);
    if (args[0] === root + "/workspace.js") {
      configureCalls++;
      await configured.promise;
    }
    return { stdout: args[0] === "list" ? JSON.stringify(rows) : "{}" };
  };
  class Workspaces {
    initialize() {
      initializeCalls++;
      return workspace.promise;
    }
    async livePaths() {
      return new Map();
    }
    async sessionContext() {
      return { project: "web", workingPath: "/project" };
    }
    discover() {
      return discovery.promise;
    }
    list() {
      return [{ id: "web", path: "/project" }];
    }
  }
  class ConversationTitles {
    reconcile() {
      titleCalls++;
      return titles.promise;
    }
  }
  const empty = class {};
  const modules = {
    fs: {
      readFileSync: (name) => {
        if (name.endsWith("windows-projects.json"))
          return '{"web":"/project","mobile":"/project"}';
        throw new Error("No saved state");
      },
      readdirSync: () => [],
      unlinkSync() {},
      chmodSync() {},
      statSync: () => ({ ino: 1 }),
    },
    "fs/promises": {},
    path,
    os: { homedir: () => "/home/test" },
    net: { createServer: () => ({ listen: (_, cb) => cb(), close() {} }) },
    readline: { createInterface: () => input },
    child_process: { execFile, spawn() {} },
    util: { promisify },
    "node-pty": {},
    "./repository.cjs": {},
    "./lifecycle.cjs": {},
    "./conversation.cjs": { Conversations: empty },
    "./workspaces.cjs": { Workspaces },
    "./session-actions.cjs": { SessionActions: empty },
    "./attachments.cjs": { Attachments: empty },
    "./conversation-titles.cjs": { ConversationTitles },
    "./chat-settings.cjs": { ChatSettings: empty },
    "./usage-summary.cjs": { usageSummary: () => ({ expired: false }) },
    "./terminal-output.cjs": require("../backend/terminal-output.cjs"),
    "./message-queue.cjs": {
      MessageQueue: class {
        load = async () => {};
        tick = async () => {};
      },
    },
    "./agent-activity.cjs": { AgentActivity: class {} },
    "./terminal-control.cjs": {
      recoverClaude: () => {
        recoveryCalls++;
        return recovery.promise;
      },
    },
    [root + "/paths"]: { mux: "/tmux", deck: "/deck" },
    [root + "/panels"]: {
      read: () => ({ path: "/project" }),
      WORKSPACE: /^claude-desk/,
    },
    [root + "/account-registry"]: { accounts: [] },
    [root + "/claude-skills"]: { catalog() {}, plugins: () => [] },
    [root + "/terminal-env"]: { PATH: "/bin" },
    [root + "/account-usage"]: {
      read: () => ({ accounts: {} }),
      refresh: () => {},
    },
  };
  const context = vm.createContext({
    require(name) {
      assert(Object.hasOwn(modules, name), name);
      return modules[name];
    },
    process: {
      execPath: "/node",
      stdout: { write: (value) => output.push(JSON.parse(value)) },
      stdin: {},
      on() {},
    },
    console,
    Buffer,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout,
    clearTimeout,
    setImmediate: (fn) => immediate.push(fn),
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../backend/backend.cjs"), "utf8"),
    context,
  );
  return {
    configured,
    workspace,
    discovery,
    titles,
    recovery,
    immediate,
    output,
    calls,
    request: (id, method = "initialize") =>
      input.emit("line", JSON.stringify({ id, method })),
    counts: () => ({
      configureCalls,
      initializeCalls,
      titleCalls,
      recoveryCalls,
    }),
  };
}
test("Initial connection overlaps configuration and folder loading, without waiting for titles, discovery or recovery", async () => {
  const f = backendFixture();
  f.request(1);
  f.request(2);
  assert.equal(f.counts().configureCalls, 1);
  assert.equal(f.counts().initializeCalls, 1);
  f.configured.resolve();
  f.workspace.resolve();
  await flush();
  assert.equal(f.output.filter((x) => x.id === 1).length, 1);
  assert.equal(f.output.find((x) => x.id === 1).result.panels.length, 6);
  assert.equal(f.output.find((x) => x.id === 2).result.sessions.length, 1);
  assert.equal(f.calls.filter((args) => args[0] === "list").length, 1);
  assert.equal(f.counts().titleCalls, 1);
  assert.equal(f.counts().recoveryCalls, 0);
  f.immediate.forEach((fn) => fn());
  assert.equal(f.counts().recoveryCalls, 1);
  f.discovery.resolve();
  f.titles.resolve();
  f.recovery.resolve();
});
test("A failed startup can be retried, without leaving initialization stuck", async () => {
  const f = backendFixture();
  f.request(1);
  f.workspace.resolve();
  f.configured.reject(new Error("Configure failed"));
  await flush();
  assert.match(f.output.find((x) => x.id === 1).error, /Configure failed/);
  f.request(2);
  await flush();
  assert.equal(f.counts().configureCalls, 2);
  assert.match(f.output.find((x) => x.id === 2).error, /Configure failed/);
});

function desktopFixture() {
  const workers = [],
    timers = [],
    log = [];
  const context = vm.createContext({
    require(name) {
      if (name === "electron")
        return {
          app: {
            setName() {},
            requestSingleInstanceLock: () => false,
            quit() {},
          },
          protocol: { registerSchemesAsPrivileged() {} },
        };
      if (name === "child_process")
        return {
          spawn: () => {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.stdout.setEncoding = child.stderr.setEncoding = () => {};
            child.stdin = new EventEmitter();
            child.stdin.writable = true;
            child.writes = [];
            child.stdin.write = (text) => child.writes.push(JSON.parse(text));
            child.kill = () => child.emit("close", 1);
            workers.push(child);
            return child;
          },
        };
      if (name === "fs")
        return { appendFileSync: (_, message) => log.push(message) };
      if (name === "./browser-view.cjs")
        return {
          createBrowserBridge: () => ({ handle: async () => true, stop() {} }),
        };
      return require(name);
    },
    console,
    Buffer,
    URL,
    process: { env: {} },
    setTimeout: (fn, delay) => {
      const timer = { fn, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cancelled = true;
    },
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../main.cjs"), "utf8") +
      "\nglobalThis.client = { call, startWorker, show };",
    context,
  );
  const events = [];
  vm.runInContext(
    "window = { show() {}, focus() {}, isDestroyed: () => false, webContents: { send: (_, d) => globalThis.sent(d) } };",
    Object.assign(context, { sent: (data) => events.push(data) }),
  );
  return { ...context.client, workers, timers, log, events };
}
test("Desktop waits for the WSL ready handshake before sending requests", async () => {
  const f = desktopFixture(),
    request = f.call("initialize"),
    worker = f.workers[0];
  assert.equal(worker.writes.length, 0);
  worker.stdout.emit("data", '{"type":"rea');
  worker.stdout.emit("data", 'dy"}\n');
  await flush();
  assert.equal(worker.writes.length, 1);
  worker.stdout.emit(
    "data",
    JSON.stringify({ id: worker.writes[0].id, result: { panels: 6 } }) + "\n",
  );
  assert.equal((await request).panels, 6);
});
test("Backend failure rejects waiting calls and automatically restarts; reopening reconnects after retries are exhausted", async () => {
  const f = desktopFixture(),
    request = f.call("initialize"),
    rejected = assert.rejects(request, /exited/);
  f.workers[0].emit("close", 1);
  await rejected;
  const restart = f.timers.find((t) => t.delay === 1000 && !t.cancelled);
  assert(restart);
  restart.fn();
  assert.equal(f.workers.length, 2);
  f.workers[1].emit("close", 1);
  f.timers.find((t) => t.delay === 2000 && !t.cancelled).fn();
  f.workers[2].emit("close", 1);
  assert.equal(f.workers.length, 3);
  f.show();
  assert.equal(f.workers.length, 4);
});
test("Background requests never respawn WSL after retries are exhausted; only a retry does", async () => {
  const f = desktopFixture();
  f.call("initialize").catch(() => {});
  f.workers[0].stdout.emit(
    "data",
    "I\0n\0s\0u\0f\0f\0i\0c\0i\0e\0n\0t\0 \0r\0e\0s\0o\0u\0r\0c\0e\0s\0\n",
  );
  f.workers[0].emit("close", 1);
  f.timers.find((t) => t.delay === 1000).fn();
  f.workers[1].emit("close", 1);
  f.timers.find((t) => t.delay === 2000).fn();
  f.workers[2].emit("close", 1);
  await assert.rejects(f.call("gitInfo"), /not connected/);
  await assert.rejects(f.call("changes"), /not connected/);
  assert.equal(f.workers.length, 3);
  assert.match(
    f.events.find((e) => e.type === "backend-disconnected").message,
    /WSL: Insufficient resources/,
  );
  f.call("initialize").catch(() => {});
  assert.equal(f.workers.length, 4);
});
test("Restoring a live panel reads its conversation once and attaches without restarting the agent", async () => {
  const calls = [],
    state = { lastId: "chat-id", showing: true },
    stdin = new EventEmitter(),
    stdout = new EventEmitter();
  Object.assign(stdin, { setRawMode() {}, resume() {}, pause() {} });
  stdout.write = () => {};
  const modules = {
    fs: { readdirSync: () => [] },
    path,
    child_process: {
      spawn: () => {
        calls.push("attach");
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        return child;
      },
    },
    readline: { emitKeypressEvents() {} },
    "./paths": { root: "/config", deck: "/deck", mux: "/tmux" },
    "./panels": {
      WORKSPACE: /^claude-desk$/,
      read: () => state,
      write: (_, __, values) => Object.assign(state, values),
      terminal: () => "/dev/pts/1",
      folder: () => "",
    },
    "./account-registry": { accounts: [], onChange() {} },
    "./account-usage": { read: () => ({}), refresh() {} },
    "./session-catalog": {},
    "./panel-labels": { label() {} },
    "./terminal-env": {},
    "./folders": { defaultFolder: "/project" },
    "./providers": { of: () => ({ continues: "claude" }), list: {} },
    "./accounts-setup": {},
    "./settings": { read: () => ({}), write() {} },
    "./watcher": { codeStamp: () => "stamp" },
    "./continuation": {
      cli: async (args) => {
        calls.push(args);
        return JSON.stringify({
          id: "chat-id",
          path: "/project",
          tool: "claude",
          tmux_session: "agentdeck_live",
        });
      },
      running: () => true,
      stoppedByLimit: () => 0,
    },
  };
  const context = vm.createContext({
    require: (name) => {
      assert(Object.hasOwn(modules, name), name);
      return modules[name];
    },
    process: {
      argv: ["node", "panel.js", "1", "--restore"],
      env: {},
      on() {},
      stdin,
      stdout,
    },
    console,
    setInterval: () => ({ unref() {} }),
    setTimeout,
    Buffer,
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "../../deck/panel.js"), "utf8"),
    context,
  );
  await flush();
  assert.equal(calls.filter(Array.isArray).length, 1);
  assert.equal(calls.at(-1), "attach");
  assert.equal(state.view, "chat");
  assert.equal(state.chatId, "chat-id");
  assert(state.showing);
});
