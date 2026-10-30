// Main-process side of the Browser tab: lists the pages of Agent Deck's
// browser, streams the selected one with the DevTools screencast and replays
// the viewer's mouse and keyboard input on it.
const host = require("./browser-host.cjs");
class Target {
  static async open(url) {
    const target = new Target(new WebSocket(url));
    await new Promise((resolve, reject) => {
      target.ws.onopen = resolve;
      target.ws.onerror = () => reject(new Error("Không kết nối được tab"));
    });
    return target;
  }
  constructor(ws) {
    this.ws = ws;
    this.serial = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (message) => {
      const data = JSON.parse(message.data),
        task = this.pending.get(data.id);
      if (task) {
        this.pending.delete(data.id);
        data.error
          ? task.reject(new Error(data.error.message))
          : task.resolve(data.result);
      } else this.handlers.get(data.method)?.(data.params);
    };
    ws.onclose = () => {
      for (const task of this.pending.values())
        task.reject(new Error("Tab đã đóng"));
      this.pending.clear();
      this.handlers.get("closed")?.();
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, handler) {
    this.handlers.set(method, handler);
  }
  close() {
    this.handlers.clear();
    try {
      this.ws.close();
    } catch {}
  }
}
async function pages() {
  const list = await (await fetch(host.endpoint + "/json/list")).json();
  return list
    .filter((t) => t.type === "page")
    .map(({ id, title, url, webSocketDebuggerUrl }) => ({
      id,
      title,
      url,
      webSocketDebuggerUrl,
    }));
}
const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const EDIT_COMMANDS = {
  a: "selectAll",
  c: "copy",
  v: "paste",
  x: "cut",
  z: "undo",
  y: "redo",
};
function createBrowserBridge({ emit }) {
  let watched = null;
  function stop() {
    watched?.target.close();
    watched = null;
  }
  async function watch({ id, width, height }) {
    stop();
    const page = (await pages()).find((p) => p.id === id);
    if (!page) throw new Error("Tab không còn mở");
    const target = await Target.open(page.webSocketDebuggerUrl),
      current = { id, target };
    watched = current;
    const frame = (data, metadata) => {
      if (watched === current)
        emit({ type: "browser-frame", id, data, metadata });
    };
    target.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      frame(data, metadata);
      target.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    target.on("Page.frameNavigated", ({ frame: f }) => {
      if (!f.parentId) emit({ type: "browser-navigated", id, url: f.url });
    });
    target.on("closed", () => {
      if (watched === current) {
        watched = null;
        emit({ type: "browser-closed", id });
      }
    });
    await target.send("Page.enable");
    // A still frame first: a minimised window sends no screencast frames.
    const metrics = await target.send("Page.getLayoutMetrics");
    const shot = await target.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
    });
    frame(shot.data, {
      deviceWidth: metrics.cssVisualViewport.clientWidth,
      deviceHeight: metrics.cssVisualViewport.clientHeight,
    });
    await target.send("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: Math.max(320, Math.min(2560, Math.round(width || 1280))),
      maxHeight: Math.max(240, Math.min(1600, Math.round(height || 800))),
    });
    return { id, url: page.url };
  }
  async function input(event) {
    const target = watched?.target;
    if (!target) return false;
    const modifiers = (event.modifiers || []).reduce(
      (sum, name) => sum | (MODIFIERS[name] || 0),
      0,
    );
    if (event.kind === "mouse")
      await target.send("Input.dispatchMouseEvent", {
        type: event.type,
        x: event.x,
        y: event.y,
        button: event.button || "none",
        buttons: event.buttons || 0,
        clickCount: event.clickCount || 0,
        deltaX: event.deltaX || 0,
        deltaY: event.deltaY || 0,
        modifiers,
      });
    else if (event.kind === "text")
      await target.send("Input.insertText", { text: String(event.text) });
    else if (event.kind === "key") {
      const command =
        modifiers & (MODIFIERS.ctrl | MODIFIERS.meta) &&
        EDIT_COMMANDS[String(event.key).toLowerCase()];
      await target.send("Input.dispatchKeyEvent", {
        type: event.type,
        key: event.key,
        code: event.code,
        text: event.text,
        unmodifiedText: event.text,
        windowsVirtualKeyCode: event.keyCode,
        nativeVirtualKeyCode: event.keyCode,
        modifiers,
        ...(command && event.type === "keyDown" ? { commands: [command] } : {}),
      });
    }
    return true;
  }
  async function navigate({ url }) {
    const target = watched?.target;
    if (!target) throw new Error("Chọn một tab trước");
    let address = String(url || "").trim();
    if (!/^[a-z][\w+.-]*:/i.test(address))
      address = /^[\w-]+(\.[\w-]+)+|^localhost\b/.test(address)
        ? "http://" + address
        : "https://www.google.com/search?q=" + encodeURIComponent(address);
    if (!/^(https?|about):/i.test(address))
      throw new Error("Chỉ mở địa chỉ http, https hoặc about:");
    await target.send("Page.navigate", { url: address });
    return true;
  }
  async function history(step) {
    const target = watched?.target;
    if (!target) return false;
    const { currentIndex, entries } = await target.send(
      "Page.getNavigationHistory",
    );
    const entry = entries[currentIndex + step];
    if (entry)
      await target.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    return !!entry;
  }
  return {
    async handle(action, args = {}) {
      switch (action) {
        case "status": {
          const info = await host.version();
          if (!info) return { running: false, pages: [] };
          return {
            running: true,
            browser: info.Browser,
            pages: (await pages()).map(({ id, title, url }) => ({
              id,
              title,
              url,
            })),
          };
        }
        case "launch":
          await host.ensureBrowser();
          return true;
        case "watch":
          return watch(args);
        case "stop":
          stop();
          return true;
        case "input":
          return input(args);
        case "navigate":
          return navigate(args);
        case "back":
          return history(-1);
        case "forward":
          return history(1);
        case "reload":
          if (watched) await watched.target.send("Page.reload");
          return true;
        case "newTab": {
          await host.ensureBrowser();
          const response = await fetch(
            host.endpoint + "/json/new?about:blank",
            { method: "PUT" },
          );
          return (await response.json()).id;
        }
        case "front":
          if (watched)
            await fetch(host.endpoint + "/json/activate/" + watched.id);
          return true;
        default:
          throw new Error("Unknown browser action");
      }
    },
    stop,
  };
}
module.exports = { createBrowserBridge };
