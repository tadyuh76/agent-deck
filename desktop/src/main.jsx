import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  lazy,
  Suspense,
} from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "@vscode/codicons/dist/codicon.css";
import "./style.css";
import "./review.css";
import { ChatView, MediaView } from "./ChatView";
import DiffWorkbench from "./DiffWorkbench";
import { AccountUsage } from "./AccountUsage";
import { isTerminalUndo } from "./keyboard.mjs";
import { poller, same } from "./polling.mjs";
import WorkspaceTools from "./WorkspaceTools.jsx";
import ProjectSidebar from "./ProjectSidebar.jsx";
import BrowserPanel from "./BrowserPanel.jsx";
import AgentsPanel from "./AgentsPanel.jsx";
const CodeView = lazy(() => import("./CodeView.jsx"));
const api = (method, args) => window.deck.call(method, args);
const Icon = ({ name, ...props }) => (
  <span className={"codicon codicon-" + name} aria-hidden="true" {...props} />
);
function Button({ icon, children, title, ...props }) {
  return (
    <button
      title={title || (typeof children === "string" ? children : undefined)}
      {...props}
    >
      {icon && <Icon name={icon} />} {children}
    </button>
  );
}
const getSaved = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
function TermView({ slot, workspace, fontSize, onFocus, onError, register }) {
  const host = useRef(),
    termRef = useRef(),
    fitRef = useRef();
  useEffect(() => {
    const term = new Terminal({
        cursorBlink: true,
        fontSize,
        fontFamily: '"Cascadia Mono", "Consolas", monospace',
        lineHeight: 1.12,
        scrollback: 10000,
        allowProposedApi: false,
        convertEol: false,
        theme: {
          background: "#191a1c",
          foreground: "#d9dadd",
          cursor: "#bed9b7",
          selectionBackground: "#4e684e80",
          black: "#191a1c",
          red: "#e58b8b",
          green: "#a5c99e",
          yellow: "#d7bf87",
          blue: "#8baad0",
          magenta: "#bb9bc8",
          cyan: "#8ac1be",
          white: "#d9dadd",
        },
      }),
      fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    termRef.current = term;
    fitRef.current = fit;
    register(slot, { term, fit, host: host.current });
    const off = window.deck.onEvent((event) => {
      if (event.type === "terminal-data" && event.slot === slot)
        term.write(event.data);
      if (event.type === "terminal-exit" && event.slot === slot)
        term.write(
          "\r\n\x1b[2mTerminal disconnected. Reopen this deck to reconnect.\x1b[0m\r\n",
        );
    });
    let alive = true,
      timer;
    const resize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (
          !alive ||
          host.current?.clientWidth < 40 ||
          host.current?.clientHeight < 30
        )
          return;
        try {
          fit.fit();
          api("terminalResize", {
            slot,
            cols: term.cols,
            rows: term.rows,
          }).catch(() => {});
        } catch {}
      }, 80);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    fit.fit();
    api("terminalStart", { slot, cols: term.cols, rows: term.rows })
      .then((result) => {
        if (alive && result.buffer) term.write(result.buffer);
      })
      .catch(onError);
    const input = term.onData((data) =>
      api("terminalInput", { slot, data }).catch(onError),
    );
    const focus = () => onFocus(slot);
    host.current.addEventListener("focusin", focus);
    host.current.addEventListener("pointerdown", focus);
    term.attachCustomKeyEventHandler((event) => {
      if (isTerminalUndo(event)) {
        // The backend turns Ctrl+Z into input undo for Claude panes only.
        if (event.type === "keydown")
          api("terminalInput", { slot, data: "\x1a" }).catch(onError);
        event.preventDefault();
        return false;
      }
      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.code === "KeyC" &&
        term.hasSelection()
      ) {
        if (event.type === "keydown") window.deck.copy(term.getSelection());
        return false;
      }
      if (event.ctrlKey && event.altKey) return false;
      if (
        event.ctrlKey &&
        event.shiftKey &&
        ["KeyZ", "KeyD", "KeyY"].includes(event.code)
      )
        return false;
      return true;
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      off();
      observer.disconnect();
      input.dispose();
      term.dispose();
      register(slot, null);
    };
  }, [workspace]);
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      if (host.current?.clientWidth > 40 && host.current?.clientHeight > 30) {
        fitRef.current?.fit();
        api("terminalResize", {
          slot,
          cols: termRef.current.cols,
          rows: termRef.current.rows,
        }).catch(() => {});
      }
    }
  }, [fontSize]);
  return (
    <div
      className="terminal-surface"
      ref={host}
      aria-label={"Terminal " + slot}
    />
  );
}
// Shows the selected terminal in the Chat panel at the panel's size, like
// the zoomed view. The same xterm moves here, so there is one pty and one
// size for Claude to draw at; it goes back to its tile on unmount.
function TerminalDock({ slot, entry }) {
  const dock = useRef();
  useEffect(() => {
    if (!entry) return;
    // React clears `dock.current` before this effect's cleanup runs, so the
    // container is captured here for the trip back to the tile.
    const { term, fit, host } = entry,
      element = term.element,
      container = dock.current;
    const fitTo = () => {
      try {
        fit.fit();
        api("terminalResize", { slot, cols: term.cols, rows: term.rows }).catch(
          () => {},
        );
      } catch {}
    };
    container.appendChild(element);
    let timer;
    const resize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (element.parentElement === container && container.clientWidth > 40)
          fitTo();
      }, 60);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      // A terminal disposed meanwhile (deck switch, reconnect) stays gone.
      if (element.parentElement === container && host.isConnected) {
        host.appendChild(element);
        fitTo();
      }
    };
  }, [entry]);
  return <div className="terminal-surface terminal-dock" ref={dock} />;
}
function Tree({ project, onOpen, onError }) {
  const [entries, setEntries] = useState([]),
    [expanded, setExpanded] = useState({}),
    [children, setChildren] = useState({}),
    [query, setQuery] = useState("");
  useEffect(() => {
    setExpanded({});
    setChildren({});
    setEntries([]);
    api("tree", { project, path: "" }).then(setEntries).catch(onError);
  }, [project]);
  async function toggle(entry) {
    if (!entry.directory) return onOpen(entry.path);
    if (!expanded[entry.path] && !children[entry.path]) {
      try {
        const items = await api("tree", { project, path: entry.path });
        setChildren((old) => ({ ...old, [entry.path]: items }));
      } catch (error) {
        onError(error);
        return;
      }
    }
    setExpanded((old) => ({ ...old, [entry.path]: !old[entry.path] }));
  }
  const render = (items, depth = 0) =>
    items
      .filter(
        (e) =>
          !query ||
          e.directory ||
          e.path.toLowerCase().includes(query.toLowerCase()),
      )
      .map((entry) => (
        <React.Fragment key={entry.path}>
          <button
            className="tree-row"
            style={{ paddingLeft: 10 + depth * 13 }}
            title={entry.path}
            onClick={() => toggle(entry)}
          >
            <Icon
              name={
                entry.directory
                  ? expanded[entry.path]
                    ? "chevron-down"
                    : "chevron-right"
                  : /\.(png|jpe?g|gif|webp|bmp)$/i.test(entry.name)
                    ? "file-media"
                    : "file-code"
              }
            />
            <span>{entry.name}</span>
          </button>
          {expanded[entry.path] &&
            render(children[entry.path] || [], depth + 1)}
        </React.Fragment>
      ));
  return (
    <>
      <div className="search">
        <Icon name="search" />
        <input
          aria-label="Lọc file đã mở"
          placeholder="Lọc tên file… hoặc nhập đường dẫn và Enter"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query.trim()) onOpen(query.trim());
          }}
        />
      </div>
      <div className="file-list">{render(entries)}</div>
    </>
  );
}
function App() {
  const [state, setState] = useState(null),
    [error, setError] = useState(""),
    [active, setActive] = useState(1),
    [zoom, setZoom] = useState(null),
    [layout, setLayout] = useState(getSaved("layout", "2x3")),
    [review, setReview] = useState(getSaved("review", true)),
    [project, setProject] = useState("web"),
    [followTerminal, setFollowTerminal] = useState(true),
    [info, setInfo] = useState(null),
    [mode, setMode] = useState("working"),
    [base, setBase] = useState(""),
    [target, setTarget] = useState(""),
    [mergeBase, setMergeBase] = useState(true),
    [changes, setChanges] = useState([]),
    [reviewTab, setReviewTab] = useState("changes"),
    [document, setDocument] = useState(null),
    [loading, setLoading] = useState(false),
    [dirty, setDirty] = useState(null),
    [sideBySide, setSideBySide] = useState(false),
    [expandedDiff, setExpandedDiff] = useState(false),
    [commit, setCommit] = useState(""),
    [ignoreWhitespace, setIgnoreWhitespace] = useState(
      getSaved("diffReviewPreferences", {}).ignoreWhitespace || false,
    ),
    [changesLoading, setChangesLoading] = useState(false),
    [fontSize, setFontSize] = useState(getSaved("fontSize", 12)),
    [power, setPower] = useState(false),
    [rightWidth, setRightWidth] = useState(getSaved("reviewWidth", 620)),
    [busy, setBusy] = useState(false);
  const [sessionMenu, setSessionMenu] = useState(null),
    [showArchived, setShowArchived] = useState(false),
    [deleteDialog, setDeleteDialog] = useState(null),
    [renameDialog, setRenameDialog] = useState(null),
    [chatRequest, setChatRequest] = useState(null),
    [chatMode, setChatMode] = useState(getSaved("chatMode", "terminal")),
    // Only re-renders the window when a terminal (re)registers.
    [, setTermVersion] = useState(0),
    [sessionBusy, setSessionBusy] = useState(false);
  const terms = useRef(new Map()),
    docRef = useRef(),
    stateRef = useRef(),
    activeRef = useRef(active),
    zoomRef = useRef(zoom),
    dirtyRef = useRef(dirty),
    changesRequest = useRef(0),
    changesSignature = useRef("");

  stateRef.current = state;
  activeRef.current = active;
  zoomRef.current = zoom;
  dirtyRef.current = dirty;
  // Failures stay until dismissed; confirmations fade after a few seconds.
  const [errorSticky, setErrorSticky] = useState(false);
  const onError = useCallback((e) => {
    setError(e?.message || String(e));
    setErrorSticky(true);
  }, []);
  const notify = useCallback((text) => {
    setError(text);
    setErrorSticky(false);
  }, []);
  useEffect(() => {
    if (!renameDialog) return;
    const field = globalThis.document.querySelector(".rename-dialog input");
    field?.focus();
    field?.select();
    const key = (event) => {
      if (event.key === "Escape" && !sessionBusy) {
        event.stopPropagation();
        setRenameDialog(null);
      }
      if (event.key === "Tab") {
        const items = [
          ...globalThis.document.querySelectorAll(
            ".rename-dialog input:not(:disabled), .rename-dialog button:not(:disabled)",
          ),
        ];
        if (event.shiftKey && globalThis.document.activeElement === items[0]) {
          event.preventDefault();
          items.at(-1)?.focus();
        } else if (
          !event.shiftKey &&
          globalThis.document.activeElement === items.at(-1)
        ) {
          event.preventDefault();
          items[0]?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [renameDialog?.session.id, sessionBusy]);
  async function renameConversation(event) {
    event.preventDefault();
    if (sessionBusy || !renameDialog?.title.trim()) return;
    setSessionBusy(true);
    try {
      const result = await api("renameSession", {
        id: renameDialog.session.id,
        title: renameDialog.title,
      });
      setState(result.snapshot);
      setRenameDialog(null);
    } catch (error) {
      onError(error);
    } finally {
      setSessionBusy(false);
    }
  }
  useEffect(() => {
    if (!sessionMenu) return;
    const close = (event) => {
      if (!event.target?.closest?.(".conversation-menu")) setSessionMenu(null);
    };
    const key = (event) => {
      if (event.key === "Escape") setSessionMenu(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", close);
    };
  }, [sessionMenu]);
  useEffect(() => {
    if (!deleteDialog) return;
    globalThis.document.querySelector(".delete-dialog .cancel-delete")?.focus();
    const key = (event) => {
      if (event.key === "Escape" && !sessionBusy) setDeleteDialog(null);
      if (event.key === "Tab") {
        const items = [
          ...globalThis.document.querySelectorAll(
            ".delete-dialog button:not(:disabled), .delete-dialog input:not(:disabled)",
          ),
        ];
        if (!items.length) return;
        const first = items[0],
          last = items.at(-1);
        if (event.shiftKey && globalThis.document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          globalThis.document.activeElement === last
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [deleteDialog?.session.id, sessionBusy]);
  async function changeSession(session, action, deleteHistory = true) {
    setSessionMenu(null);
    setSessionBusy(true);
    try {
      const result = await api("sessionAction", {
        id: session.id,
        action,
        deleteHistory,
      });
      setState(result.snapshot);
      setDeleteDialog(null);
      if (action === "unarchive") setShowArchived(false);
      if (action === "delete") {
        localStorage.removeItem("chat-draft-" + session.id);
        localStorage.removeItem("chat-receipt-" + session.id);
        localStorage.removeItem("chat-settings-" + session.id);
      }
      notify(
        (result.historyErrors?.length
          ? "Đã gỡ hội thoại; một số bản ghi chưa xóa được."
          : result.retainedShared
            ? "Đã xóa hội thoại. Lịch sử dùng chung với hội thoại khác được giữ lại."
            : action === "archive"
              ? "Đã archive hội thoại."
              : action === "unarchive"
                ? "Đã khôi phục hội thoại."
                : "Đã xóa hội thoại.") +
          (result.panelError
            ? " Terminal đang mở hội thoại này chưa được đặt lại; mở menu tài khoản của terminal đó."
            : ""),
      );
    } catch (error) {
      onError(error);
    } finally {
      setSessionBusy(false);
    }
  }
  function openSessionMenu(session, x, y) {
    setSessionMenu({
      session,
      x: Math.max(8, Math.min(x, window.innerWidth - 255)),
      y: Math.max(8, Math.min(y, window.innerHeight - 205)),
    });
  }
  const register = useCallback((slot, entry) => {
    entry ? terms.current.set(slot, entry) : terms.current.delete(slot);
    // The Chat panel borrows terminals; let it see new ones.
    setTermVersion((n) => n + 1);
  }, []);
  const focus = useCallback((slot) => {
    setActive(slot);
    setFollowTerminal(true);
    const panel = stateRef.current?.panels.find((p) => p.slot === slot);
    if (panel?.project && dirtyRef.current === null) setProject(panel.project);
  }, []);
  useEffect(() => {
    const panel = state?.panels.find((p) => p.slot === active);
    if (followTerminal && panel?.project && dirty === null)
      setProject(panel.project);
  }, [
    state?.panels.find((p) => p.slot === active)?.project,
    active,
    followTerminal,
    dirty,
  ]);
  useEffect(() => {
    // A folder that disappeared from the list (removed worktree) can't be read.
    if (state && !state.projects.some((p) => p.id === project))
      setProject(state.projects[0]?.id || "web");
  }, [state?.projects, project]);
  function chooseProject(id) {
    if (dirtyRef.current !== null)
      return onError(new Error("Lưu file đang sửa trước khi đổi thư mục."));
    setFollowTerminal(false);
    setProject(id);
    setReview(true);
    setReviewTab("changes");
  }
  function acceptLocation(result) {
    if (!result) return;
    if (result.snapshot) setState(result.snapshot);
    if (dirtyRef.current !== null)
      return onError(
        new Error("Lưu file đang sửa trước khi mở đường dẫn khác."),
      );
    setReview(true);
    if (result.kind === "directory") {
      chooseProject(result.project);
      setReviewTab("files");
    } else if (result.document) {
      const key = crypto.randomUUID();
      docRef.current = key;
      setDocument({
        ...result.document,
        project: result.project,
        line: result.line,
        key,
      });
      setLoading(false);
      setReviewTab("preview");
    }
  }
  function acceptWorkspaceUpdate(result) {
    if (result.snapshot) setState(result.snapshot);
    if (result.project) {
      chooseProject(result.project);
      setReviewTab("changes");
    }
    if (result.opened === false)
      notify("Đã tạo chat. Chọn hội thoại mới trong danh sách để mở.");
    if (result.info) {
      setInfo(result.info);
      refreshChanges();
    }
  }
  function focusTerm(slot) {
    focus(slot);
    setReview(true);
    setReviewTab("chat");
    if (zoomRef.current !== null) setZoom(slot);
    setTimeout(() => terms.current.get(slot)?.term.focus(), 60);
  }
  useEffect(() => {
    let alive = true,
      connecting = false;
    const connect = () => {
      if (connecting) return;
      connecting = true;
      api("initialize")
        .then((data) => {
          if (alive) {
            setState(data);
            setError("");
          }
        })
        .catch(onError)
        .finally(() => (connecting = false));
    };
    const off = window.deck.onEvent((event) => {
      if (event.type === "ready") connect();
      if (event.type === "backend-disconnected") {
        setState(null);
        setError(event.message);
      }
      if (event.type === "snapshot") setState(event.snapshot);
      if (event.type === "error") onError(new Error(event.message));
      if (event.type === "notice") notify(event.message);
      if (event.type === "focus-panel") focusTerm(event.slot);
      if (event.type === "zoom-panel") {
        setActive(event.slot);
        setZoom((old) => (old === event.slot ? null : event.slot));
      }
      if (event.type === "show-sidebar") documentGlobalFocus();
      if (event.type === "deck-changed") {
        setZoom(null);
        api("snapshot").then(setState).catch(onError);
      }
      if (event.type === "shutting-down") setBusy(true);
    });
    connect();
    return () => {
      alive = false;
      off();
    };
  }, []);
  function documentGlobalFocus() {
    globalThis.document.querySelector(".session-search")?.focus();
  }
  useEffect(() => {
    if (!error || !state || errorSticky) return;
    const timeout = setTimeout(() => setError(""), 8000);
    return () => clearTimeout(timeout);
  }, [error, !!state, errorSticky]);
  useEffect(() => {
    localStorage.setItem("layout", JSON.stringify(layout));
    localStorage.setItem("review", JSON.stringify(review));
    localStorage.setItem("fontSize", JSON.stringify(fontSize));
    localStorage.setItem("reviewWidth", JSON.stringify(rightWidth));
    localStorage.setItem("chatMode", JSON.stringify(chatMode));
  }, [layout, review, fontSize, rightWidth, chatMode]);
  useEffect(() => {
    let alive = true;
    setInfo(null);
    setChanges([]);
    docRef.current = crypto.randomUUID();
    setDocument(null);
    setDirty(null);
    api("gitInfo", { project })
      .then((data) => {
        if (alive) {
          setInfo(data);
          setBase(
            data.branches.includes("dev")
              ? "dev"
              : data.branches.includes("origin/dev")
                ? "origin/dev"
                : data.defaultBase,
          );
          setCommit("");
          setMode("working");
          setTarget("HEAD");
        }
      })
      .catch(onError);
    return () => {
      alive = false;
    };
  }, [project]);
  useEffect(() => {
    let alive = true;
    // The title bar shows the branch; the open review panel needs fresher refs.
    const stop = poller(
      () =>
        api("gitInfo", { project })
          .then((data) => {
            if (alive) {
              setInfo((old) => (same(old, data) ? old : data));
              if (dirtyRef.current === null) {
                setBase((old) =>
                  old === "HEAD" || data.branches.includes(old)
                    ? old
                    : data.defaultBase,
                );
                setTarget((old) =>
                  old === "HEAD" || data.branches.includes(old) ? old : "HEAD",
                );
              }
            }
          })
          .catch(() => {}),
      review ? 5000 : 15000,
    );
    return () => {
      alive = false;
      stop();
    };
  }, [project, review]);
  const options = {
    project,
    mode,
    base,
    target,
    mergeBase,
    commit,
    ignoreWhitespace,
  };
  const selectedRoot = state?.projects.find((p) => p.id === project)?.path;
  const refreshChanges = useCallback(async () => {
    // While WSL is disconnected keep its error on screen instead of polling.
    if (!stateRef.current) return;
    const request = ++changesRequest.current;
    if (!info?.isGit || info.root !== selectedRoot) {
      setChanges([]);
      setChangesLoading(false);
      return;
    }
    if (mode === "branches" && (!base || !target)) return;
    const signature = JSON.stringify({
      project,
      mode,
      base,
      target,
      mergeBase,
      commit,
      ignoreWhitespace,
    });
    if (changesSignature.current !== signature) {
      changesSignature.current = signature;
      setChanges([]);
      setChangesLoading(true);
    }
    try {
      const files = await api("changes", {
        project,
        mode,
        base,
        target,
        mergeBase,
        commit,
        ignoreWhitespace,
      });
      if (request === changesRequest.current)
        setChanges((old) => (same(old, files) ? old : files));
    } catch (error) {
      if (request === changesRequest.current) onError(error);
    } finally {
      if (request === changesRequest.current) setChangesLoading(false);
    }
  }, [
    project,
    mode,
    base,
    target,
    mergeBase,
    commit,
    ignoreWhitespace,
    info?.isGit,
    info?.head,
    selectedRoot,
  ]);
  useEffect(() => {
    refreshChanges();
    // The changed-file list only shows in the review panel.
    if (!review) return;
    return poller(refreshChanges, 5000);
  }, [refreshChanges, review]);
  useEffect(() => {
    setDocument(null);
  }, [project, mode, base, target, mergeBase, commit]);
  async function openFile(filePath, kind = "diff", oldPath) {
    if (dirty !== null && dirty !== document?.text) {
      onError(new Error("Lưu file đang sửa trước khi mở file khác."));
      return;
    }
    setLoading(true);
    setDocument(null);
    setDirty(null);
    const key = crypto.randomUUID();
    docRef.current = key;
    try {
      const data = await api(kind === "diff" ? "diff" : "file", {
        ...options,
        path: filePath,
        oldPath,
      });
      if (docRef.current === key)
        setDocument({
          ...data,
          oldPath,
          kind: data.kind || kind,
          key,
          project,
        });
    } catch (error) {
      if (docRef.current === key)
        setDocument({
          kind: "error",
          path: filePath,
          message: error.message,
          key,
        });
      onError(error);
    } finally {
      if (docRef.current === key) setLoading(false);
    }
  }
  const openChatReference = useCallback(
    async (reference, src) => {
      if (dirtyRef.current !== null)
        return onError(new Error("Lưu file đang sửa trước khi mở file khác."));
      const key = crypto.randomUUID();
      docRef.current = key;
      setDocument(null);
      setLoading(true);
      setReviewTab("preview");
      try {
        const result = src
          ? { document: { kind: "image", path: "Ảnh trong hội thoại", src } }
          : await api("openReference", {
              project:
                stateRef.current?.panels.find(
                  (p) => p.slot === activeRef.current,
                )?.project || "web",
              reference,
            });
        if (docRef.current === key)
          setDocument({
            ...result.document,
            project: result.project,
            line: result.line,
            key,
          });
      } catch (error) {
        if (docRef.current === key)
          setDocument({
            kind: "error",
            path: reference,
            message: error.message,
            key,
          });
        onError(error);
      } finally {
        if (docRef.current === key) setLoading(false);
      }
    },
    [onError],
  );
  useEffect(() => {
    if (document?.kind !== "diff" || !review) return;
    const key = document.key,
      stop = poller(
        () =>
          api("diff", {
            ...options,
            path: document.path,
            oldPath: document.oldPath,
          })
            .then((data) =>
              setDocument((old) =>
                old?.key !== key ||
                (data.revision && old.revision === data.revision)
                  ? old
                  : { ...old, ...data },
              ),
            )
            .catch(() => {}),
        5000,
      );
    return stop;
  }, [document?.key, project, mode, base, target, mergeBase, review]);
  async function save() {
    if (document?.kind !== "file" || document.readOnly || dirty === null)
      return;
    try {
      const result = await api("save", {
        project: document.project || project,
        path: document.path,
        text: dirty,
        version: document.version,
      });
      setDocument({ ...document, ...result, kind: "file", key: document.key });
      setDirty(null);
      refreshChanges();
      notify("Đã lưu " + result.path);
    } catch (error) {
      onError(error);
    }
  }
  useEffect(() => {
    const handler = () => save();
    window.addEventListener("deck-save", handler);
    return () => window.removeEventListener("deck-save", handler);
  }, [document, dirty, project]);
  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey && e.altKey && /^[1-6]$/.test(e.key)) {
        e.preventDefault();
        focusTerm(Number(e.key));
      }
      if (e.ctrlKey && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        setReview((old) => !old);
      }
      if (e.ctrlKey && e.shiftKey && e.code === "KeyZ") {
        e.preventDefault();
        setZoom((old) => (old === null ? activeRef.current : null));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  async function panelAction(slot, action) {
    try {
      await api("panelAction", { slot, action });
      focusTerm(slot);
    } catch (error) {
      onError(error);
    }
  }
  function resizeReview(e) {
    e.preventDefault();
    const start = e.clientX,
      width = rightWidth;
    function move(event) {
      setRightWidth(
        Math.max(
          360,
          Math.min(window.innerWidth - 650, width + start - event.clientX),
        ),
      );
    }
    function end() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  }
  const selectedProject = state?.projects.find((p) => p.id === project);
  const selectedPanel = state?.panels.find((p) => p.slot === active);
  // In terminal mode the Chat panel shows the selected terminal itself,
  // unless that terminal is already zoomed in the grid.
  const lifted =
    state && review && reviewTab === "chat" && chatMode === "terminal"
      ? zoom === active
        ? null
        : active
      : null;
  const selectedChange = changes.find((file) => file.path === document?.path);
  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand">
          <Icon name="layout" />
          <b>Agent Deck</b>
          <span className="muted">Workspace</span>
        </div>
        <div className="title-project">
          {selectedProject?.name || "Đang kết nối WSL…"}
          {info && (
            <>
              <span className="divider" />
              <Icon name="git-branch" />
              <span>{info.branch}</span>
            </>
          )}
        </div>
        <div className="window-buttons">
          <button
            aria-label="Thu nhỏ"
            onClick={() => window.deck.window("minimize")}
          >
            <Icon name="chrome-minimize" />
          </button>
          <button
            aria-label="Phóng to cửa sổ"
            onClick={() => window.deck.window("maximize")}
          >
            <Icon name="chrome-maximize" />
          </button>
          <button
            aria-label="Ẩn xuống system tray"
            title="Ẩn xuống system tray; agent tiếp tục chạy"
            onClick={() => window.deck.window("hide")}
          >
            <Icon name="chrome-close" />
          </button>
        </div>
      </header>
      <div className="workspace-body">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <span>WORKSPACES</span>
            <Button
              icon="add"
              title="Tạo deck mới"
              onClick={() => api("newDeck").then(setState).catch(onError)}
            />
          </div>
          <select
            aria-label="Deck hiện tại"
            className="deck-select"
            value={state?.workspace || "claude-desk-100"}
            onChange={(e) =>
              api("switchDeck", { workspace: e.target.value })
                .then(setState)
                .catch(onError)
            }
          >
            {(state?.decks || ["claude-desk-100"]).map((d, i) => (
              <option key={d} value={d}>
                Deck {i + 1} · 6 terminals
              </option>
            ))}
          </select>
          <ProjectSidebar
            state={state}
            active={active}
            selected={project}
            archived={showArchived}
            onArchived={(value) => {
              setShowArchived(value);
              setSessionMenu(null);
            }}
            onSelect={(id) => {
              if (dirty !== null)
                return onError(
                  new Error("Lưu file đang sửa trước khi đổi dự án."),
                );
              chooseProject(id);
            }}
            onOpenSession={(session, event) => {
              // An archived chat opens its menu; restoring is an explicit
              // choice there, not a side effect of a click.
              if (session.archived) {
                const rect = event.currentTarget.getBoundingClientRect();
                openSessionMenu(session, rect.right, rect.top);
              } else
                api("openSession", { id: session.id, slot: active }).catch(
                  onError,
                );
            }}
            onSessionMenu={openSessionMenu}
            onNewChat={(id) => {
              if (dirty !== null)
                return onError(
                  new Error("Lưu file đang sửa trước khi mở chat mới."),
                );
              const target = state?.projects.some((p) => p.id === id)
                ? id
                : project;
              chooseProject(target);
              setChatRequest({ project: target, slot: active, at: Date.now() });
            }}
            onOpenFolder={() =>
              window.deck.pickPath("folder").then(acceptLocation).catch(onError)
            }
          />
          <AccountUsage
            accounts={state?.accounts}
            onRefresh={() => api("refreshUsage").catch(onError)}
            onLogin={(account) => api("login", { account }).catch(onError)}
          />
          <div className="sidebar-bottom">
            <Button
              icon="question"
              title="Ctrl+Alt+1…6: chọn terminal · Ctrl+Shift+Z: zoom · Ctrl+Shift+D: code/diff"
              onClick={() =>
                notify(
                  "Ctrl+Alt+1…6: chọn terminal · Ctrl+Shift+Z: zoom · Ctrl+Shift+D: bật/tắt code-diff · Ctrl+Shift+C: copy terminal",
                )
              }
            >
              Phím tắt
            </Button>
            <Button
              icon="power"
              title="Menu thoát"
              onClick={() => setPower(!power)}
            />
          </div>
          {power && (
            <div className="power-menu">
              <button
                onClick={() => {
                  window.deck.window("hide");
                  setPower(false);
                }}
              >
                Ẩn xuống system tray
              </button>
              <button onClick={() => window.deck.window("quitKeep")}>
                Đóng app, giữ agent chạy
              </button>
              <button
                className="danger"
                onClick={() => window.deck.window("quit")}
              >
                Thoát hoàn toàn · dừng tất cả agent
              </button>
            </div>
          )}
        </aside>
        <main className="terminal-area">
          <div className="toolbar">
            <div className="toolbar-title">
              <Icon name="terminal" />
              <b>{zoom ? "Terminal " + zoom : "6 terminals"}</b>
              <span className="muted">{zoom ? "Focus" : "Overview"}</span>
            </div>
            <div className="toolbar-actions">
              <select
                aria-label="Bố cục terminal"
                value={layout}
                onChange={(e) => setLayout(e.target.value)}
              >
                <option value="2x3">2 cột × 3 hàng</option>
                <option value="3x2">3 cột × 2 hàng</option>
              </select>
              <Button
                icon="remove"
                title="Giảm cỡ chữ"
                onClick={() => setFontSize((old) => Math.max(9, old - 1))}
              />
              <span className="font-size">{fontSize}</span>
              <Button
                icon="add"
                title="Tăng cỡ chữ"
                onClick={() => setFontSize((old) => Math.min(20, old + 1))}
              />
              <Button
                icon={zoom ? "screen-normal" : "screen-full"}
                title={
                  zoom ? "Hiện cả 6 terminal" : "Phóng to terminal đang chọn"
                }
                onClick={() => setZoom((old) => (old === null ? active : null))}
              />
              <Button
                className={review ? "active" : ""}
                icon="layout-panel-right"
                title="Bật/tắt khung code và diff"
                onClick={() => setReview(!review)}
              />
            </div>
          </div>
          {!state ? (
            <div className="connecting">
              <Icon name="loading" />
              Đang kết nối các phiên Agent Deck…
              {error && (
                <Button
                  onClick={() =>
                    api("initialize")
                      .then((data) => {
                        setState(data);
                        setError("");
                      })
                      .catch(onError)
                  }
                >
                  Thử kết nối lại
                </Button>
              )}
            </div>
          ) : (
            <div
              className={
                "terminal-grid layout-" + layout + (zoom ? " zooming" : "")
              }
            >
              {state.panels.map((p) => (
                <section
                  key={state.workspace + "-" + p.slot}
                  className={
                    "terminal-tile " +
                    (active === p.slot ? "focused " : "") +
                    (zoom === p.slot ? "zoomed" : "")
                  }
                  onPointerDown={() => {
                    focus(p.slot);
                    setReview(true);
                    setReviewTab("chat");
                  }}
                >
                  <div className="terminal-heading">
                    <button
                      className="terminal-name"
                      title="Chọn terminal"
                      onClick={() => focusTerm(p.slot)}
                    >
                      <span className="slot-number">{p.slot}</span>
                      <b>
                        {p.session && p.view === "chat"
                          ? p.session.account
                          : "Claude"}
                      </b>
                      <span className="terminal-project">
                        {p.path?.split("/").pop()}
                      </span>
                    </button>
                    <div className="terminal-tools">
                      <Button
                        icon="debug-continue"
                        title="Khôi phục Claude nếu bị suspend"
                        onClick={() =>
                          api("recoverTerminal", { slot: p.slot })
                            .then((result) =>
                              notify(
                                result.recovered
                                  ? "Đã khôi phục Claude."
                                  : "Claude hiện không bị suspend.",
                              ),
                            )
                            .catch(onError)
                        }
                      />
                      <span
                        className={
                          "status-dot " + (p.session?.status || "offline")
                        }
                      />
                      <Button
                        icon="account"
                        title="Menu tài khoản / chat mới"
                        onClick={() => panelAction(p.slot, "menu")}
                      />
                      <Button
                        icon="arrow-swap"
                        title="Chuyển chat sang tài khoản khác"
                        onClick={() => panelAction(p.slot, "continue")}
                      />
                      <Button
                        icon={zoom === p.slot ? "screen-normal" : "screen-full"}
                        title="Phóng to / thu nhỏ"
                        onClick={() => {
                          focus(p.slot);
                          setZoom(zoom === p.slot ? null : p.slot);
                        }}
                      />
                    </div>
                  </div>
                  <TermView
                    slot={p.slot}
                    workspace={state.workspace}
                    fontSize={fontSize}
                    onFocus={focus}
                    onError={onError}
                    register={register}
                  />
                  {lifted === p.slot && (
                    <div className="terminal-lifted">
                      <Icon name="layout-sidebar-right" />
                      Đang hiển thị ở khung Chat
                    </div>
                  )}
                  {p.view === "empty" && (
                    <div className="account-overlay">
                      <Icon name="terminal" />
                      <strong>Bắt đầu hội thoại</strong>
                      <select
                        aria-label={"Dự án terminal " + p.slot}
                        value={p.project}
                        onChange={(e) =>
                          api("panelAction", {
                            slot: p.slot,
                            action: "project",
                            project: e.target.value,
                          }).catch(onError)
                        }
                      >
                        {state.projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                      <div>
                        {state.accounts.map((a) => (
                          <button
                            key={a.slot}
                            disabled={a.usage.status !== "ready"}
                            title={a.email}
                            onClick={() =>
                              api("panelAction", {
                                slot: p.slot,
                                action: "account",
                                account: a.slot,
                              })
                                .then(() => focusTerm(p.slot))
                                .catch(onError)
                            }
                          >
                            <span
                              className={
                                "status-dot " +
                                (a.usage.status === "ready"
                                  ? "ready"
                                  : "offline")
                              }
                            />
                            {a.name}
                          </button>
                        ))}
                      </div>
                      <small>Chọn tài khoản để mở chat trong dự án này</small>
                    </div>
                  )}
                </section>
              ))}
            </div>
          )}
        </main>
        {review && (
          <>
            <div
              className="resize-divider"
              role="separator"
              aria-label="Đổi độ rộng preview"
              onPointerDown={resizeReview}
            />
            <aside
              className={
                "review-panel " +
                (expandedDiff && reviewTab === "changes" ? "expanded-diff" : "")
              }
              style={{ width: rightWidth }}
            >
              <div className="review-header">
                <div>
                  <Button
                    className={reviewTab === "chat" ? "tab active" : "tab"}
                    icon="comment-discussion"
                    onClick={() => setReviewTab("chat")}
                  >
                    Chat <span className="count">{active}</span>
                  </Button>
                  <Button
                    className={reviewTab === "changes" ? "tab active" : "tab"}
                    icon="git-pull-request"
                    onClick={() => setReviewTab("changes")}
                  >
                    Changes <span className="count">{changes.length}</span>
                  </Button>
                  <Button
                    className={reviewTab === "files" ? "tab active" : "tab"}
                    icon="files"
                    onClick={() => setReviewTab("files")}
                  >
                    Files
                  </Button>
                  <Button
                    className={reviewTab === "browser" ? "tab active" : "tab"}
                    icon="globe"
                    title="Trình duyệt mà các agent đang dùng"
                    onClick={() => setReviewTab("browser")}
                  >
                    Browser
                  </Button>
                  <Button
                    className={reviewTab === "agents" ? "tab active" : "tab"}
                    icon="organization"
                    title="Agent con và tác vụ nền của terminal đang chọn"
                    onClick={() => setReviewTab("agents")}
                  >
                    Agents
                  </Button>
                  {reviewTab === "preview" && (
                    <Button
                      className="tab active"
                      icon="open-preview"
                      onClick={() => setReviewTab("preview")}
                    >
                      Preview
                    </Button>
                  )}
                </div>
                <Button
                  icon="refresh"
                  title="Làm mới danh sách thay đổi"
                  onClick={() => {
                    api("gitInfo", { project, force: true })
                      .then(setInfo)
                      .catch(onError);
                    refreshChanges();
                  }}
                />
              </div>
              {/* Folder, branch and worktree tools serve Files / Changes;
                  the Chat tab gives their height to the terminal. */}
              {!["chat", "browser", "agents"].includes(reviewTab) && (
                <WorkspaceTools
                  state={state}
                  project={project}
                  info={info}
                  follow={followTerminal}
                  onFollow={setFollowTerminal}
                  onProject={chooseProject}
                  onLocation={acceptLocation}
                  onUpdated={acceptWorkspaceUpdate}
                  onError={onError}
                  dirty={dirty !== null}
                  active={active}
                  request={chatRequest}
                  onRequestDone={() => setChatRequest(null)}
                />
              )}
              {reviewTab === "agents" ? (
                <AgentsPanel panel={selectedPanel} onError={onError} />
              ) : reviewTab === "browser" ? (
                <BrowserPanel onError={onError} />
              ) : reviewTab === "chat" ? (
                <ChatView
                  key={state?.workspace + ":" + active}
                  panel={selectedPanel}
                  workspace={state?.workspace}
                  onOpen={openChatReference}
                  onError={onError}
                  mode={chatMode}
                  onMode={setChatMode}
                  onAgents={() => setReviewTab("agents")}
                  terminal={
                    lifted ? (
                      <TerminalDock
                        slot={lifted}
                        entry={terms.current.get(lifted)}
                      />
                    ) : null
                  }
                  onTerminal={() => {
                    setZoom(active);
                    terms.current.get(active)?.term.focus();
                  }}
                />
              ) : reviewTab === "changes" ? (
                <DiffWorkbench
                  info={info}
                  files={changes}
                  options={options}
                  loading={changesLoading}
                  onCompare={(patch) => {
                    if (dirty !== null)
                      return onError(
                        new Error("Lưu file đang sửa trước khi đổi phạm vi."),
                      );
                    if (patch.mode !== undefined) setMode(patch.mode);
                    if (patch.base !== undefined) setBase(patch.base);
                    if (patch.target !== undefined) setTarget(patch.target);
                    if (patch.commit !== undefined) setCommit(patch.commit);
                    if (patch.mergeBase !== undefined)
                      setMergeBase(patch.mergeBase);
                    if (patch.ignoreWhitespace !== undefined)
                      setIgnoreWhitespace(patch.ignoreWhitespace);
                  }}
                  onRefresh={() => {
                    api("gitInfo", { project, force: true })
                      .then(setInfo)
                      .catch(onError);
                    refreshChanges();
                  }}
                  onOpen={(name) => {
                    setReviewTab("preview");
                    openFile(name, "file");
                  }}
                  onError={onError}
                  expanded={expandedDiff}
                  onExpand={() => setExpandedDiff((old) => !old)}
                  onClose={() => {
                    setExpandedDiff(false);
                    setReview(false);
                  }}
                />
              ) : (
                <>
                  {reviewTab === "files" ? (
                    <Tree
                      project={project}
                      onError={onError}
                      onOpen={(name) => openFile(name, "file")}
                    />
                  ) : null}
                  <>
                    <div className="editor-heading">
                      <span title={document?.absolutePath || document?.path}>
                        {document ? (
                          <>
                            <Icon name="file-code" />
                            {document.path.split("/").pop()}
                            {document.readOnly && (
                              <small
                                className="readonly-label"
                                title={document.notice}
                              >
                                {document.notice || "Chỉ xem"}
                              </small>
                            )}
                            {dirty !== null && (
                              <span className="dirty-dot">●</span>
                            )}
                          </>
                        ) : (
                          "Code preview"
                        )}
                      </span>
                      <div>
                        {document?.absolutePath && (
                          <Button
                            icon="folder-opened"
                            title={
                              "Xem Git / Files tại " + document.absolutePath
                            }
                            onClick={() => {
                              chooseProject(document.project);
                              setReviewTab(
                                state?.projects.find(
                                  (p) => p.id === document.project,
                                )?.kind === "folder"
                                  ? "files"
                                  : "changes",
                              );
                            }}
                          />
                        )}
                        {document?.kind === "diff" &&
                          selectedChange &&
                          !selectedChange.binary && (
                            <span className="line-counts">
                              <span className="added">
                                +{selectedChange.added}
                              </span>
                              <span className="deleted">
                                −{selectedChange.removed}
                              </span>
                            </span>
                          )}
                        {document?.kind === "diff" && (
                          <>
                            <Button
                              icon="split-horizontal"
                              className={sideBySide ? "active" : ""}
                              title="Đổi giữa diff hai cột và một cột"
                              onClick={() => setSideBySide(!sideBySide)}
                            />
                            <Button
                              icon="edit"
                              title="Mở file hiện tại để chỉnh sửa"
                              onClick={() => openFile(document.path, "file")}
                            />
                          </>
                        )}
                        {document?.kind === "file" && !document.readOnly && (
                          <Button
                            icon="save"
                            disabled={dirty === null}
                            title="Lưu file (Ctrl+S)"
                            onClick={save}
                          />
                        )}
                      </div>
                    </div>
                    {(document?.kind === "diff" ||
                      document?.kind === "image-diff") && (
                      <div className="diff-labels">
                        <span>{document.originalLabel}</span>
                        <Icon name="arrow-right" />
                        <span>{document.modifiedLabel}</span>
                      </div>
                    )}
                    <div className="editor-content">
                      {document && ["file", "diff"].includes(document.kind) && (
                        <Suspense
                          fallback={
                            <div className="editor-loading">
                              Đang mở trình soạn thảo…
                            </div>
                          }
                        >
                          <CodeView
                            document={document}
                            sideBySide={sideBySide}
                            onDirty={setDirty}
                            onError={onError}
                          />
                        </Suspense>
                      )}{" "}
                      {document &&
                        ["image", "image-diff", "binary"].includes(
                          document.kind,
                        ) && <MediaView document={document} />}
                      {document?.kind === "large" && (
                        <div className="editor-empty">
                          <Icon name="file" />
                          <strong>File quá lớn để xem diff</strong>
                          <p>Trình xem diff hỗ trợ file văn bản tối đa 2 MB.</p>
                        </div>
                      )}
                      {document?.kind === "error" && (
                        <div className="editor-empty">
                          <Icon name="error" />
                          <strong>Không mở được file</strong>
                          <p>{document.message}</p>
                        </div>
                      )}
                      {document?.kind === "choices" && (
                        <div className="reference-choices">
                          <p>
                            Nhiều file có tên {document.path}. Chọn file để mở:
                          </p>
                          {document.matches.map((item) => (
                            <button
                              key={item.path}
                              onClick={() => openChatReference(item.reference)}
                            >
                              <Icon name="file-code" />
                              {item.path}
                            </button>
                          ))}
                        </div>
                      )}
                      {!document && !loading && (
                        <div className="editor-empty">
                          <Icon name="diff" />
                          <strong>Xem code ngay cạnh agent</strong>
                          <p>
                            Chọn file trong Changes để xem diff,
                            <br />
                            hoặc mở Files để xem và sửa code.
                          </p>
                          <span>
                            Thay đổi chưa commit · Staged · Branch ↔ Branch
                          </span>
                        </div>
                      )}
                      {loading && (
                        <div className="editor-loading">
                          <Icon name="loading" /> Đang đọc file…
                        </div>
                      )}
                    </div>
                  </>
                </>
              )}
            </aside>
          </>
        )}
      </div>
      <footer className="statusbar">
        <span>
          <i className={"status-dot " + (state ? "ready" : "offline")} />
          {state ? "WSL · Ubuntu 24.04" : "Đang kết nối"}
        </span>
        <span>
          {state?.sessions.filter((s) => s.status === "running").length || 0}{" "}
          đang chạy · {state?.sessions.length || 0} hội thoại
        </span>
        <span className="status-right">
          Ctrl+Alt+1…6 chọn terminal
          <span className="divider" />
          Đóng cửa sổ → system tray
        </span>
      </footer>
      {error && (
        <div
          role={errorSticky ? "alert" : "status"}
          className={"toast" + (errorSticky ? " toast-error" : "")}
        >
          <Icon name="info" />
          <span>{error}</span>
          <button aria-label="Đóng thông báo" onClick={() => setError("")}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {sessionMenu && (
        <div
          className="conversation-menu"
          role="menu"
          aria-label="Menu hội thoại"
          style={{ left: sessionMenu.x, top: sessionMenu.y }}
        >
          <div className="conversation-menu-title">
            {sessionMenu.session.title}
          </div>
          <button
            role="menuitem"
            disabled={sessionBusy}
            onClick={() => {
              setRenameDialog({
                session: sessionMenu.session,
                title: sessionMenu.session.title,
              });
              setSessionMenu(null);
            }}
          >
            <Icon name="edit" />
            Đổi tên hội thoại…
          </button>
          <button
            role="menuitem"
            disabled={sessionBusy}
            onClick={() =>
              changeSession(
                sessionMenu.session,
                sessionMenu.session.archived ? "unarchive" : "archive",
              )
            }
          >
            <Icon
              name={sessionMenu.session.archived ? "folder-opened" : "archive"}
            />
            {sessionMenu.session.archived
              ? "Khôi phục hội thoại"
              : "Archive hội thoại"}
          </button>
          <div className="menu-rule" />
          <button
            role="menuitem"
            className="danger"
            disabled={sessionBusy}
            onClick={() => {
              setDeleteDialog({
                session: sessionMenu.session,
                deleteHistory: true,
              });
              setSessionMenu(null);
            }}
          >
            <Icon name="trash" />
            Xóa hội thoại…
          </button>
        </div>
      )}
      {deleteDialog && (
        <div
          className="dialog-overlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !sessionBusy)
              setDeleteDialog(null);
          }}
        >
          <div
            className="delete-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-title"
          >
            <Icon name="trash" />
            <h2 id="delete-title">Xóa hội thoại?</h2>
            <strong>{deleteDialog.session.title}</strong>
            <p>Phiên này sẽ dừng và được xóa khỏi Agent Deck.</p>
            {deleteDialog.session.tool === "claude" && (
              <label className="delete-history">
                <input
                  type="checkbox"
                  disabled={sessionBusy}
                  checked={deleteDialog.deleteHistory}
                  onChange={(event) =>
                    setDeleteDialog((old) => ({
                      ...old,
                      deleteHistory: event.target.checked,
                    }))
                  }
                />
                Xóa cả bản ghi hội thoại Claude trên máy
              </label>
            )}
            <p className="muted">
              Bản ghi đã xóa không thể khôi phục. Mã nguồn dự án được giữ
              nguyên.
            </p>
            <div className="dialog-actions">
              <button
                className="cancel-delete"
                disabled={sessionBusy}
                onClick={() => setDeleteDialog(null)}
              >
                Hủy
              </button>
              <button
                className="confirm-delete"
                disabled={sessionBusy}
                onClick={() =>
                  changeSession(
                    deleteDialog.session,
                    "delete",
                    deleteDialog.deleteHistory,
                  )
                }
              >
                {sessionBusy ? "Đang xóa…" : "Xóa hội thoại"}
              </button>
            </div>
          </div>
        </div>
      )}
      {renameDialog && (
        <div
          className="dialog-overlay"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !sessionBusy)
              setRenameDialog(null);
          }}
        >
          <form
            className="delete-dialog rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-title"
            onSubmit={renameConversation}
          >
            <h2 id="rename-title">Đổi tên hội thoại</h2>
            <input
              aria-label="Tên hội thoại"
              maxLength={120}
              value={renameDialog.title}
              disabled={sessionBusy}
              onChange={(event) =>
                setRenameDialog((old) => ({
                  ...old,
                  title: event.target.value,
                }))
              }
            />
            <p className="muted">
              Tên bạn đặt sẽ được giữ khi Claude tiếp tục hội thoại.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                disabled={sessionBusy}
                onClick={() => setRenameDialog(null)}
              >
                Hủy
              </button>
              <button
                type="submit"
                className="save-rename"
                disabled={sessionBusy || !renameDialog.title.trim()}
              >
                {sessionBusy ? "Đang lưu…" : "Lưu tên"}
              </button>
            </div>
          </form>
        </div>
      )}
      {busy && (
        <div className="shutdown-overlay">
          <Icon name="loading" />
          <b>Đang đóng Agent Deck…</b>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<App />);
