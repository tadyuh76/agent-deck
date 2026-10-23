import React, { useEffect, useRef, useState } from "react";
import { poller } from "./polling.mjs";
import {
  ExtensionsDialog,
  SlashMenu,
  slashMatches,
  slashQuery,
  useExtensions,
} from "./ClaudeExtensions.jsx";
const api = (method, args) => window.deck.call(method, args);
const Icon = ({ name }) => (
  <span className={"codicon codicon-" + name} aria-hidden="true" />
);
const key = (id) => "chat-settings-" + id;
const size = (bytes) =>
  bytes >= 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(1) + " MB"
    : Math.max(1, Math.round(bytes / 1024)) + " KB";
const readFile = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Không đọc được " + file.name));
    reader.readAsDataURL(file);
  });
export function AttachmentPreview({ document, onClose }) {
  useEffect(() => {
    const key = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        e.preventDefault();
        globalThis.document
          .querySelector(".attachment-preview header button")
          ?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div
      className="dialog-overlay attachment-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="attachment-preview"
        role="dialog"
        aria-modal="true"
        aria-label={"Xem " + document.path}
      >
        <header>
          <strong>{document.path}</strong>
          <button autoFocus title="Đóng xem trước" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        {document.kind === "image" ? (
          <img src={document.src} alt={document.path} />
        ) : document.kind === "text" ? (
          <pre>{document.text}</pre>
        ) : (
          <div className="attachment-binary">
            <Icon name="file" />
            <p>Tệp đã đính kèm · {size(document.bytes || 0)}</p>
            <small>Claude có thể đọc tệp khi bạn gửi tin nhắn.</small>
          </div>
        )}
      </section>
    </div>
  );
}
export default function ChatComposer({
  id,
  slot,
  workspace,
  draft,
  onDraft,
  sending,
  onSubmit,
  // "send" when Claude is idle, "queue" while it works or is not running;
  // `onSteer` pushes a message into the running turn right away.
  mode = "send",
  onQueue,
  onSteer,
  canSteer = false,
  restoredAt,
  status,
  onError,
  onTerminal,
}) {
  const [files, setFiles] = useState([]),
    [uploading, setUploading] = useState(false),
    [loadingDrafts, setLoadingDrafts] = useState(false),
    [models, setModels] = useState([]),
    [loadingModels, setLoadingModels] = useState(false),
    [modelError, setModelError] = useState(""),
    [choice, setChoice] = useState({ model: "", effort: "", dirty: false }),
    [applying, setApplying] = useState(false),
    [notice, setNotice] = useState(""),
    [preview, setPreview] = useState(null),
    [dragging, setDragging] = useState(false);
  const [actual, setActual] = useState({});
  const extensions = useExtensions(slot, id),
    [slashIndex, setSlashIndex] = useState(0),
    [slashClosed, setSlashClosed] = useState(""),
    [showExtensions, setShowExtensions] = useState(false);
  const query = slashQuery(draft),
    slashOpen = query !== null && slashClosed !== draft && !!id,
    slashItems = slashOpen ? slashMatches(extensions.data, query) : [];
  useEffect(() => {
    if (query !== null) extensions.load();
    setSlashIndex(0);
  }, [query, id]);
  function insertCommand(item) {
    onDraft("/" + item.name + " " + draft.replace(/^\/\S*\s*/, ""));
    setShowExtensions(false);
    requestAnimationFrame(() => textarea.current?.focus());
  }
  const current = useRef(id),
    input = useRef(),
    textarea = useRef();
  current.current = id;
  function remember(value) {
    setChoice(value);
    if (id) localStorage.setItem(key(id), JSON.stringify(value));
  }
  async function loadModels(force = false, quiet = false) {
    if (!id) return;
    const target = id;
    if (!quiet) {
      setLoadingModels(true);
      setModelError("");
    }
    try {
      const data = await api("chatModels", { slot, id, force });
      if (current.current === target) {
        setModels(data.models);
        setActual({
          model: data.currentModel,
          effort: data.currentEffort,
          checked: true,
        });
      }
    } catch (e) {
      if (current.current === target && !quiet) setModelError(e.message);
    } finally {
      if (current.current === target && !quiet) setLoadingModels(false);
    }
  }
  useEffect(() => {
    setFiles([]);
    setModels([]);
    setPreview(null);
    setUploading(false);
    setLoadingDrafts(false);
    setApplying(false);
    setNotice("");
    setDragging(false);
    setActual({});
    setShowExtensions(false);
    // Only a pending, not yet applied choice is kept; otherwise the menus
    // show what the session is actually using.
    try {
      const saved = JSON.parse(localStorage.getItem(key(id)) || "null");
      setChoice(saved?.dirty ? saved : { model: "", effort: "", dirty: false });
    } catch {
      setChoice({ model: "", effort: "", dirty: false });
    }
    if (!id) return;
    let alive = true;
    setLoadingDrafts(true);
    api("attachmentDrafts", { slot, id })
      .then((data) => {
        if (alive) setFiles(data);
      })
      .catch(onError)
      .finally(() => {
        if (alive) setLoadingDrafts(false);
      });
    loadModels();
    // /model or /effort typed in the terminal changes the session too.
    const stop = poller(() => loadModels(false, true), 15000);
    return () => {
      alive = false;
      stop();
    };
  }, [id, slot, workspace]);
  useEffect(() => {
    if (!id || !restoredAt) return;
    const target = id;
    api("attachmentDrafts", { slot, id })
      .then((data) => {
        if (current.current === target) setFiles(data);
      })
      .catch(onError);
  }, [restoredAt]);
  async function addFiles(list) {
    if (!id || uploading || sending || loadingDrafts || applying) return;
    const target = id,
      selected = Array.from(list || []);
    if (!selected.length) return;
    setUploading(true);
    setNotice("");
    try {
      for (const file of selected) {
        if (file.size > 20 * 1024 * 1024)
          throw new Error(file.name + ": mỗi tệp tối đa 20 MB");
        if (current.current !== target) break;
        const data = await readFile(file),
          item = await api("attachmentStage", {
            slot,
            id: target,
            name: file.name || "clipboard.png",
            data,
          });
        if (current.current === target) setFiles((old) => [...old, item]);
      }
    } catch (e) {
      onError(e);
    } finally {
      if (current.current === target) setUploading(false);
      if (input.current) input.current.value = "";
    }
  }
  async function remove(file) {
    const target = id;
    try {
      await api("attachmentRemove", { slot, id, attachment: file.id });
      if (current.current === target)
        setFiles((old) => old.filter((f) => f.id !== file.id));
    } catch (e) {
      onError(e);
    }
  }
  async function open(file) {
    const target = id;
    try {
      const doc = await api("attachmentOpen", { id, attachment: file.id });
      if (current.current === target) setPreview(doc);
    } catch (e) {
      onError(e);
    }
  }
  async function apply() {
    if (!choice.dirty || applying || sending) return;
    const target = id;
    setApplying(true);
    setNotice("");
    try {
      const result = await api("chatApplySettings", {
        slot,
        id,
        settings: { model: choice.model, effort: choice.effort },
      });
      localStorage.removeItem(key(target));
      if (current.current === target) {
        setChoice({ model: "", effort: "", dirty: false });
        setNotice(result?.notice || "Đã áp dụng trong Claude.");
        loadModels();
      }
    } catch (e) {
      onError(e);
      if (current.current === target)
        setNotice("Chưa áp dụng · kiểm tra terminal.");
    } finally {
      if (current.current === target) setApplying(false);
    }
  }
  async function send(kind = mode) {
    if (
      !id ||
      sending ||
      uploading ||
      applying ||
      (!draft.trim() && !files.length)
    )
      return;
    // Model / effort changes need an idle Claude, so they cannot steer.
    if (kind === "steer" && (!canSteer || choice.dirty)) return;
    const target = id,
      selection = choice.dirty
        ? { model: choice.model, effort: choice.effort }
        : undefined;
    const deliver =
      kind === "queue" ? onQueue : kind === "steer" ? onSteer : onSubmit;
    const success = await deliver({
      attachments: files.map((f) => f.id),
      settings: selection,
    });
    if (success) {
      localStorage.removeItem(key(target));
      if (current.current === target) {
        setFiles([]);
        setChoice({ model: "", effort: "", dirty: false });
        loadModels(false, true);
        setNotice("");
        textarea.current?.focus();
      }
    }
  }
  const chosen = models.find((m) => m.value === choice.model),
    efforts = chosen
      ? chosen.efforts
      : ["low", "medium", "high", "xhigh", "max"],
    disabled = !id || sending || applying || loadingDrafts;
  return (
    <>
      <div
        className={
          "chat-composer enhanced-composer " + (dragging ? "drag-over" : "")
        }
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {files.length > 0 && (
          <div className="attachment-list" aria-label="Tệp sẽ gửi">
            {files.map((file) => (
              <div className="attachment-card" key={file.id}>
                <button
                  className="attachment-open"
                  title={"Xem " + file.name}
                  onClick={() => open(file)}
                >
                  {file.src ? (
                    <img src={file.src} alt={file.name} />
                  ) : (
                    <Icon
                      name={/\.pdf$/i.test(file.name) ? "file-pdf" : "file"}
                    />
                  )}
                  <span>
                    <strong>{file.name}</strong>
                    <small>{size(file.bytes)}</small>
                  </span>
                </button>
                <button
                  className="attachment-remove"
                  title={"Gỡ " + file.name}
                  disabled={disabled || uploading}
                  onClick={() => remove(file)}
                >
                  <Icon name="close" />
                </button>
              </div>
            ))}
          </div>
        )}
        {slashOpen && (
          <SlashMenu
            items={slashItems}
            active={slashIndex}
            loading={extensions.loading}
            error={extensions.error}
            onPick={insertCommand}
            onHover={setSlashIndex}
          />
        )}
        <textarea
          ref={textarea}
          aria-label={"Tin nhắn terminal " + slot}
          placeholder={
            dragging
              ? "Thả tệp để đính kèm"
              : id
                ? "Nhắn Claude… Dán ảnh hoặc kéo tệp vào đây"
                : "Mở hội thoại ở terminal trước"
          }
          disabled={disabled}
          value={draft}
          onChange={(e) => onDraft(e.target.value)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files || []);
            if (!pasted.length) return;
            e.preventDefault();
            const text = e.clipboardData.getData("text/plain");
            if (text) {
              const field = e.currentTarget,
                onward =
                  draft.slice(0, field.selectionStart) +
                  text +
                  draft.slice(field.selectionEnd);
              onDraft(onward);
            }
            addFiles(pasted);
          }}
          onKeyDown={(e) => {
            if (slashOpen && !e.nativeEvent.isComposing) {
              const count = slashItems.length;
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setSlashClosed(draft);
                return;
              }
              if (count && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                e.preventDefault();
                setSlashIndex(
                  (i) => (i + (e.key === "ArrowDown" ? 1 : count - 1)) % count,
                );
                return;
              }
              if (
                count &&
                (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey))
              ) {
                e.preventDefault();
                insertCommand(slashItems[Math.min(slashIndex, count - 1)]);
                return;
              }
            }
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              send(e.ctrlKey || e.metaKey ? "steer" : mode);
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-options">
            <input
              ref={input}
              type="file"
              multiple
              hidden
              aria-label="Chọn tệp đính kèm"
              onChange={(e) => addFiles(e.target.files)}
            />
            <button
              className="attach-button"
              title="Thêm ảnh hoặc tệp (tối đa 20 MB/tệp)"
              disabled={disabled || uploading}
              onClick={() => input.current?.click()}
            >
              <Icon name={uploading ? "loading" : "add"} />
            </button>
            <button
              className="attach-button"
              title="Skills, lệnh và plugin của Claude (gõ / trong ô chat)"
              disabled={!id}
              onClick={() => setShowExtensions(true)}
            >
              <Icon name="extensions" />
            </button>
            <label className="composer-select">
              <Icon name="sparkle" />
              <select
                aria-label="Model Claude"
                title="Claude cũng lưu model được chọn làm mặc định cho các phiên mới của tài khoản"
                value={choice.model}
                disabled={disabled || loadingModels}
                onChange={(e) => {
                  const model = e.target.value,
                    m = models.find((m) => m.value === model);
                  remember({
                    model,
                    effort:
                      !m || m.efforts.includes(choice.effort)
                        ? choice.effort
                        : "",
                    dirty: !!model || !!choice.effort,
                  });
                  setNotice("");
                }}
              >
                <option value="">
                  {loadingModels
                    ? "Đang lấy model…"
                    : actual.model
                      ? actual.model + " · hiện tại"
                      : actual.checked
                        ? "Model: không rõ"
                        : "Model hiện tại"}
                </option>
                {models.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="composer-select effort-select">
              <select
                aria-label="Effort Claude"
                title="Claude cũng lưu effort làm mặc định cho các phiên mới của tài khoản; Max chỉ dùng trong phiên hiện tại"
                value={choice.effort}
                disabled={disabled || (chosen && !chosen.supportsEffort)}
                onChange={(e) => {
                  remember({
                    ...choice,
                    effort: e.target.value,
                    dirty: !!choice.model || !!e.target.value,
                  });
                  setNotice("");
                }}
              >
                <option value="">
                  {actual.effort
                    ? "Effort: " + actual.effort
                    : actual.checked
                      ? "Effort: không rõ"
                      : "Effort hiện tại"}
                </option>
                {efforts.map((level) => (
                  <option key={level} value={level}>
                    {level[0].toUpperCase() + level.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            {choice.dirty && (
              <button
                className="apply-settings"
                title="Đổi model / effort ngay trong terminal"
                disabled={disabled}
                onClick={apply}
              >
                {applying ? "Đang áp dụng…" : "Áp dụng"}
              </button>
            )}
            {modelError && (
              <button
                className="model-retry"
                title={modelError}
                disabled={loadingModels || disabled}
                onClick={() => loadModels(true)}
              >
                <Icon name="refresh" />
              </button>
            )}
          </div>
          {mode === "queue" && canSteer && (
            <button
              className="composer-steer"
              title={
                choice.dirty
                  ? "Đổi model / effort cần Claude rảnh; xếp hàng thay vì steer"
                  : "Steer: gửi ngay vào lượt Claude đang chạy (Ctrl+Enter)"
              }
              disabled={
                disabled ||
                uploading ||
                choice.dirty ||
                (!draft.trim() && !files.length)
              }
              onClick={() => send("steer")}
            >
              <Icon name="zap" />
              Steer
            </button>
          )}
          <button
            className={"composer-send" + (mode === "queue" ? " queue" : "")}
            title={
              mode === "queue"
                ? "Xếp hàng: tự gửi khi Claude xong việc (Enter)"
                : "Gửi tin nhắn và tệp (Enter)"
            }
            disabled={disabled || uploading || (!draft.trim() && !files.length)}
            onClick={() => send()}
          >
            <Icon
              name={
                sending
                  ? "loading"
                  : mode === "queue"
                    ? "list-ordered"
                    : "arrow-up"
              }
            />
          </button>
        </div>
        <div className="composer-hint">
          <span>
            {uploading
              ? "Đang thêm tệp…"
              : applying
                ? "Đang đổi lựa chọn trong Claude…"
                : notice ||
                  (choice.dirty
                    ? "Áp dụng trước khi gửi · Claude cũng lưu mặc định cho phiên mới"
                    : mode === "queue"
                      ? canSteer
                        ? "Enter xếp hàng · Ctrl+Enter steer (gửi ngay) · Shift+Enter xuống dòng"
                        : "Enter xếp hàng · tin tự gửi khi Claude chạy lại và rảnh"
                      : "Shift+Enter xuống dòng · / để chọn lệnh hoặc skill · Ctrl+V dán ảnh")}
          </span>
          {(notice.includes("Chưa") || modelError) && (
            <button onClick={onTerminal}>Xem terminal</button>
          )}
        </div>
      </div>
      {showExtensions && (
        <ExtensionsDialog
          slot={slot}
          id={id}
          extensions={extensions}
          onUse={insertCommand}
          onClose={() => setShowExtensions(false)}
          onError={onError}
        />
      )}
      {preview && (
        <AttachmentPreview
          document={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
