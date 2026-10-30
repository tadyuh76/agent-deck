const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  protocol,
  net,
  shell,
  clipboard,
  dialog,
} = require("electron");
const { spawn } = require("child_process");
const { createBrowserBridge } = require("./browser-view.cjs");
const path = require("path"),
  fs = require("fs"),
  { pathToFileURL } = require("url");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "deck",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
app.setName("Agent Deck");
let window,
  tray,
  worker,
  quitting = false,
  requestId = 0,
  ready = false;
let workerReady = null,
  restartTimer = null,
  restartAttempts = 0,
  closing = false,
  startupOutput = [];
const pending = new Map();
let log;
const allowed = new Set([
  "initialize",
  "snapshot",
  "terminalStart",
  "terminalInput",
  "terminalResize",
  "panelAction",
  "openSession",
  "switchDeck",
  "newDeck",
  "gitInfo",
  "gitCommits",
  "changes",
  "tree",
  "file",
  "save",
  "diff",
  "login",
  "chatHistory",
  "chatSend",
  "chatSendStatus",
  "chatRestoreDraft",
  "chatQueue",
  "chatEnqueue",
  "chatQueueRemove",
  "chatQueueRetry",
  "chatQueueSteer",
  "chatAgents",
  "chatModels",
  "chatApplySettings",
  "renameSession",
  "attachmentStage",
  "attachmentDrafts",
  "attachmentRemove",
  "attachmentOpen",
  "openReference",
  "sessionAction",
  "recoverTerminal",
  "refreshUsage",
  "openLocation",
  "worktreeCreate",
  "branchSwitch",
  "newConversation",
  "claudeExtensions",
  "claudePluginToggle",
]);
// Agent Deck's own browser, shown in the Browser tab (Windows side only).
const browser = createBrowserBridge({ emit: (data) => emit(data) });
function record(message) {
  try {
    fs.appendFileSync(log, new Date().toISOString() + " " + message + "\n");
  } catch {}
}
function plain(text) {
  // Older wsl.exe builds ignore WSL_UTF8; drop the NULs of their UTF-16 text.
  return String(text).replace(/\0/g, "").trim();
}
function emit(data) {
  if (window && !window.isDestroyed())
    window.webContents.send("deck:event", data);
}
async function call(method, args = {}) {
  if (method !== "shutdown") {
    if (!worker) {
      // Background polls must not respawn WSL; only initialize (startup or
      // the retry button) and show() reconnect.
      if (method !== "initialize")
        throw new Error(
          restartTimer
            ? "Kết nối WSL bị ngắt. Đang kết nối lại…"
            : "WSL backend is not connected. Reopen Agent Deck.",
        );
      restartAttempts = 0;
      startWorker();
    }
    if (!ready) await workerReady;
  }
  return new Promise((resolve, reject) => {
    if (!worker?.stdin.writable)
      return reject(
        new Error("WSL backend is not connected. Reopen Agent Deck."),
      );
    const id = ++requestId,
      timer = setTimeout(
        () => {
          pending.delete(id);
          reject(new Error("Action timed out: " + method));
        },
        method === "shutdown"
          ? 20000
          : method === "worktreeCreate"
            ? 180000
            : 60000,
      );
    const started = Date.now();
    pending.set(id, {
      resolve: (result) => {
        if (method === "initialize") {
          restartAttempts = 0;
          record("Startup initialize: " + (Date.now() - started) + " ms");
        }
        resolve(result);
      },
      reject,
      timer,
    });
    worker.stdin.write(JSON.stringify({ id, method, args }) + "\n");
  });
}
// The WSL distribution and Linux user the installer recorded; installs made
// before it recorded them ran Ubuntu-24.04 as the distribution's default user.
function wslTarget() {
  let saved = {};
  try {
    const file = path.join(
      process.env.LOCALAPPDATA || "",
      "AgentDeck",
      "desktop-install.json",
    );
    // Windows PowerShell writes UTF-8 with a byte order mark.
    saved = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {}
  return {
    distribution: saved.distribution || "Ubuntu-24.04",
    user: saved.linuxUser || "",
  };
}
function startWorker() {
  if (worker || quitting) return;
  clearTimeout(restartTimer);
  restartTimer = null;
  ready = false;
  startupOutput = [];
  const started = Date.now();
  let resolveReady, rejectReady;
  workerReady = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // The worker starts before the renderer calls initialize.
  void workerReady.catch(() => {});
  const target = wslTarget();
  worker = spawn(
    "wsl.exe",
    [
      "--distribution",
      target.distribution,
      ...(target.user ? ["--user", target.user] : []),
      // Paths are relative to the Linux user's home, so the same app works
      // for any user name without a shell or quoting.
      "--cd",
      "~",
      "--exec",
      ".local/bin/node",
      ".local/share/agent-deck/desktop/backend.cjs",
    ],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      // wsl.exe prints its own errors as UTF-16 unless asked for UTF-8.
      env: { ...process.env, WSL_UTF8: "1" },
    },
  );
  const current = worker;
  // Decode as text so multi-byte characters split across chunks stay intact.
  worker.stdout.setEncoding("utf8");
  worker.stderr.setEncoding("utf8");
  const startupTimer = setTimeout(() => {
    rejectReady(
      new Error("WSL khởi động quá lâu. Thử kết nối lại Agent Deck."),
    );
    current.kill();
  }, 45000);
  let buffer = "";
  worker.stdout.on("data", (chunk) => {
    buffer += chunk;
    // Walk the chunk by offset and cut the remainder once: slicing the
    // buffer after every line made a chunk of many lines quadratic.
    let start = 0,
      end;
    const lines = [];
    while ((end = buffer.indexOf("\n", start)) >= 0) {
      lines.push(buffer.slice(start, end));
      start = end + 1;
    }
    buffer = buffer.slice(start);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.id !== undefined) {
          const task = pending.get(item.id);
          if (task) {
            clearTimeout(task.timer);
            pending.delete(item.id);
            item.error
              ? task.reject(new Error(item.error))
              : task.resolve(item.result);
          }
        } else {
          if (item.type === "ready") {
            ready = true;
            clearTimeout(startupTimer);
            record("Startup WSL backend: " + (Date.now() - started) + " ms");
            resolveReady();
          }
          if (item.type === "show-window") show();
          emit(item);
        }
      } catch {
        const text = plain(line);
        if (text && !ready) startupOutput.push(text);
        if (text) record("Worker output: " + text.slice(0, 500));
      }
    }
  });
  worker.stderr.on("data", (data) => {
    const text = plain(data);
    if (text && !ready) startupOutput.push(text);
    if (text) record(text);
  });
  worker.stdin.on("error", (error) => record("Worker input: " + error.message));
  worker.on("error", (error) => {
    clearTimeout(startupTimer);
    rejectReady(error);
    record(error.stack);
    emit({ type: "error", message: error.message });
  });
  worker.on("close", (code) => {
    if (worker !== current) return;
    clearTimeout(startupTimer);
    ready = false;
    worker = null;
    rejectReady(new Error("WSL backend exited"));
    record("WSL backend exited: " + code);
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error("WSL backend exited"));
    }
    pending.clear();
    const reason = startupOutput.join(" ").slice(0, 400);
    if (!quitting)
      emit({
        type: "backend-disconnected",
        message:
          (restartAttempts < 2
            ? "Kết nối WSL bị ngắt. Đang kết nối lại…"
            : "Không kết nối được WSL. Bấm Thử kết nối lại để mở lại agent.") +
          (reason ? " WSL: " + reason : ""),
      });
    if (!quitting && restartAttempts < 2)
      restartTimer = setTimeout(startWorker, 1000 * ++restartAttempts);
  });
}
function show() {
  if (!worker && !quitting && !closing) {
    restartAttempts = 0;
    startWorker();
  }
  window?.show();
  window?.focus();
}
async function quit(stopAgents) {
  if (quitting || closing) return;
  closing = true;
  emit({ type: "shutting-down" });
  if (stopAgents && !worker) {
    // Stopping agents needs the WSL side; reconnect briefly instead of
    // exiting with every agent still running.
    restartAttempts = 0;
    startWorker();
    await Promise.race([
      workerReady,
      new Promise((resolve) => setTimeout(resolve, 20000)),
    ]).catch((error) => record("Shutdown reconnect: " + error.message));
  }
  quitting = true;
  clearTimeout(restartTimer);
  let stopped = false;
  try {
    await call("shutdown", { stopAgents });
    stopped = true;
  } catch (error) {
    record(error.message);
  }
  if (stopAgents && !stopped)
    dialog.showMessageBoxSync({
      type: "warning",
      title: "Agent Deck",
      message: "Không dừng được các agent.",
      detail:
        "Không kết nối được WSL nên các phiên có thể vẫn chạy. Mở lại Agent Deck rồi chọn Thoát hoàn toàn lần nữa.",
    });
  worker?.stdin.end();
  worker?.kill();
  browser.stop();
  tray?.destroy();
  app.exit(0);
}
function trayIcon() {
  // A small six-panel grid stays legible in the notification area.
  const size = 32,
    pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const inside =
        x >= 4 &&
        x < 28 &&
        y >= 3 &&
        y < 29 &&
        x !== 15 &&
        x !== 16 &&
        y !== 10 &&
        y !== 11 &&
        y !== 20 &&
        y !== 21;
      if (inside) {
        const i = (y * size + x) * 4;
        pixels[i] = 166;
        pixels[i + 1] = 205;
        pixels[i + 2] = 164;
        pixels[i + 3] = 255;
      }
    }
  return nativeImage.createFromBitmap(pixels, {
    width: size,
    height: size,
    scaleFactor: 1,
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", show);
  app
    .whenReady()
    .then(async () => {
      log = path.join(app.getPath("userData"), "desktop.log");
      // Keep one previous log instead of growing without limit.
      try {
        if (fs.statSync(log).size > 2 * 1024 * 1024)
          fs.renameSync(log, log + ".1");
      } catch {}
      protocol.handle("deck", (request) => {
        const url = new URL(request.url);
        if (url.host !== "app")
          return new Response("Not found", { status: 404 });
        const root = path.join(__dirname, "dist"),
          file = path.resolve(root, "." + decodeURIComponent(url.pathname));
        if (file !== root && !file.startsWith(root + path.sep))
          return new Response("Forbidden", { status: 403 });
        return net.fetch(pathToFileURL(file).href);
      });
      window = new BrowserWindow({
        width: 1680,
        height: 1040,
        minWidth: 1000,
        minHeight: 680,
        title: "Agent Deck",
        backgroundColor: "#151617",
        frame: false,
        show: false,
        icon: trayIcon(),
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
      Menu.setApplicationMenu(null);
      // The backend slows its polling while the window sits in the tray.
      const visibility = (hidden) =>
        ready && call("visibility", { hidden }).catch(() => {});
      window.on("hide", () => visibility(true));
      window.on("minimize", () => visibility(true));
      window.on("show", () => visibility(false));
      window.on("restore", () => visibility(false));
      window.on("close", (event) => {
        if (!quitting) {
          event.preventDefault();
          window.hide();
        }
      });
      window.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https:\/\/(?:code\.claude\.com|claude\.ai)\//.test(url))
          shell.openExternal(url);
        return { action: "deny" };
      });
      window.webContents.on("will-navigate", (event, url) => {
        if (!url.startsWith("deck://app/")) event.preventDefault();
      });
      window.webContents.session.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false),
      );
      window.webContents.on("render-process-gone", (_event, details) =>
        record("Renderer exited: " + details.reason),
      );
      window.webContents.on("console-message", (_event, details) => {
        if (details?.level === "error") record("Renderer: " + details.message);
      });
      window.webContents.on("context-menu", (_event, params) => {
        if (!window.webContents.getURL().startsWith("deck://app/")) return;
        const template = [];
        if (params.isEditable)
          template.push(
            { role: "undo", label: "Hoàn tác" },
            { role: "redo", label: "Làm lại" },
            { type: "separator" },
            { role: "cut", label: "Cắt" },
            { role: "copy", label: "Sao chép" },
            { role: "paste", label: "Dán" },
            { type: "separator" },
            { role: "selectAll", label: "Chọn tất cả" },
          );
        else if (params.selectionText)
          template.push({ role: "copy", label: "Sao chép" });
        if (template.length) Menu.buildFromTemplate(template).popup({ window });
      });
      startWorker();
      tray = new Tray(trayIcon());
      tray.setToolTip("Agent Deck — 6 terminals");
      record("Tray bounds: " + JSON.stringify(tray.getBounds()));
      tray.on("double-click", show);
      tray.on("click", show);
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Mở Agent Deck", click: show },
          { label: "Ẩn xuống system tray", click: () => window.hide() },
          { type: "separator" },
          { label: "Đóng ứng dụng, giữ agent chạy", click: () => quit(false) },
          {
            label: "Thoát hoàn toàn — dừng tất cả agent",
            click: () => quit(true),
          },
        ]),
      );
      ipcMain.handle("deck:call", async (event, method, args) => {
        if (
          !event.senderFrame?.url.startsWith("deck://app/") ||
          !allowed.has(method)
        )
          throw new Error("Action not allowed");
        return call(method, args);
      });
      ipcMain.handle("deck:browser", (event, action, args) => {
        if (!event.senderFrame?.url.startsWith("deck://app/"))
          throw new Error("Action not allowed");
        return browser.handle(action, args);
      });
      ipcMain.handle("deck:pickPath", async (event, kind) => {
        if (
          !event.senderFrame?.url.startsWith("deck://app/") ||
          !["file", "folder"].includes(kind)
        )
          throw new Error("Action not allowed");
        const result = await dialog.showOpenDialog(window, {
          title:
            kind === "folder"
              ? "Mở thư mục / worktree trên máy"
              : "Mở file trên máy",
          properties: kind === "folder" ? ["openDirectory"] : ["openFile"],
        });
        if (result.canceled || !result.filePaths.length) return null;
        return call("openLocation", {
          path: result.filePaths[0],
          pin: kind === "folder",
        });
      });
      ipcMain.on("deck:window", (event, action) => {
        if (!event.senderFrame?.url.startsWith("deck://app/")) return;
        if (action === "minimize") window.minimize();
        if (action === "maximize")
          window.isMaximized() ? window.unmaximize() : window.maximize();
        if (action === "hide") window.hide();
        if (action === "quit") void quit(true);
        if (action === "quitKeep") void quit(false);
      });
      ipcMain.on("deck:copy", (event, text) => {
        if (
          event.senderFrame?.url.startsWith("deck://app/") &&
          typeof text === "string" &&
          text.length < 4 * 1024 * 1024
        )
          clipboard.writeText(text);
      });
      await window.loadURL("deck://app/index.html");
      window.maximize();
      window.show();
    })
    .catch((error) => {
      record(error.stack);
      app.exit(1);
    });
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      void quit(false);
    }
  });
  app.on("window-all-closed", () => {});
  app.on("activate", show);
}
