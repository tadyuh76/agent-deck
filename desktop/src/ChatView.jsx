import React, { useState, useEffect, useRef } from "react";
import { poller, same } from "./polling.mjs";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import ChatComposer, { AttachmentPreview } from "./ChatComposer.jsx";
const api = (method, args) => window.deck.call(method, args);
const Icon = ({ name }) => (
  <span className={"codicon codicon-" + name} aria-hidden="true" />
);
const messageText = (message) =>
  message.content
    .map((b) =>
      b.type === "text"
        ? b.text
        : b.type === "attachment"
          ? "[Tệp: " + b.name + "]"
          : b.type === "image"
            ? "[Ảnh]"
            : "",
    )
    .filter(Boolean)
    .join("\n");
const isFile = (value) =>
  typeof value === "string" &&
  !/\n/.test(value) &&
  value.trim() === value &&
  /(?:^|\/|\\)[\p{L}\p{N}_.@-][^<>]*\.[a-zA-Z0-9]{1,12}(?::\d+(?::\d+)?|#L\d+)?$/u.test(
    value,
  ) &&
  !/^https?:/i.test(value);
function ChatImage({ src, project, onOpen, alt }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(false);
    if (/^data:image\/(png|jpeg|gif|webp);base64,/.test(src || "")) {
      setData(src);
      return;
    }
    if (!src || /^https?:|^data:|^[a-z]+:/i.test(src)) {
      setError(true);
      return;
    }
    api("openReference", { project, reference: src })
      .then((r) => {
        if (alive && r.document.kind === "image") setData(r.document.src);
        else if (alive) setError(true);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [src, project]);
  return data ? (
    <button
      className="chat-image"
      title="Mở ảnh lớn"
      onClick={() => onOpen(src, data)}
    >
      <img src={data} alt={alt || "Ảnh trong hội thoại"} loading="lazy" />
    </button>
  ) : (
    <button className="chat-file-link" onClick={() => onOpen(src)}>
      <Icon name="file-media" />
      {error ? "Mở file ảnh" : "Đang đọc ảnh…"} {alt}
    </button>
  );
}
const RichText = React.memo(function RichText({ text, onOpen, project }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => url}
      components={{
        a: ({ href, children }) => (
          <button
            className="chat-file-link"
            title={href}
            onClick={() =>
              /^https?:/i.test(href || "")
                ? window.deck.copy(href)
                : onOpen(href)
            }
          >
            {children}
            {/^https?:/i.test(href || "") && <Icon name="copy" />}
          </button>
        ),
        img: ({ src, alt }) => (
          <ChatImage src={src} alt={alt} project={project} onOpen={onOpen} />
        ),
        code: ({ className, children }) =>
          !className && isFile(String(children)) ? (
            <button
              className="chat-file-link inline-file"
              title="Mở file"
              onClick={() => onOpen(String(children))}
            >
              <Icon name="file-code" />
              {children}
            </button>
          ) : (
            <code className={className}>{children}</code>
          ),
        pre: ({ children }) => (
          <div className="chat-code">
            <button
              title="Sao chép code"
              onClick={() =>
                window.deck.copy(String(children?.props?.children || ""))
              }
            >
              <Icon name="copy" />
            </button>
            <pre>{children}</pre>
          </div>
        ),
      }}
    >
      {text}
    </Markdown>
  );
});
function ChatAttachment({ attachment, conversationId }) {
  const [file, setFile] = useState(null),
    [preview, setPreview] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    api("attachmentOpen", { id: conversationId, attachment: attachment.id })
      .then((data) => {
        if (alive) setFile(data);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [conversationId, attachment.id]);
  return (
    <>
      <button
        className="sent-attachment"
        title={error || "Xem " + (file?.path || attachment.name)}
        onClick={() => {
          if (file) setPreview(file);
        }}
      >
        {file?.kind === "image" ? (
          <img src={file.src} alt={file.path} />
        ) : (
          <Icon name="file" />
        )}
        <span>{file?.path || attachment.name}</span>
      </button>
      {preview && (
        <AttachmentPreview
          document={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
const Content = React.memo(function Content({
  blocks,
  onOpen,
  project,
  conversationId,
}) {
  return blocks?.map((b, i) =>
    b.type === "attachment" ? (
      <ChatAttachment
        key={b.id}
        attachment={b}
        conversationId={conversationId}
      />
    ) : b.type === "image" ? (
      <ChatImage key={i} src={b.src} onOpen={onOpen} project={project} />
    ) : (
      <RichText key={i} text={b.text} onOpen={onOpen} project={project} />
    ),
  );
});
// What the session is doing, from agent-deck's status and substate.
function sessionState(session) {
  const status = session?.status,
    substate = session?.substate || "";
  if (!status) return null;
  if (status === "running")
    return substate === "background-work"
      ? { tone: "background", label: "Lượt chính xong · việc nền đang chạy" }
      : { tone: "running", label: "Claude đang chạy" };
  if (substate === "interactive-menu")
    return { tone: "attention", label: "Đang chờ bạn chọn trong terminal" };
  if (substate === "usage-limit")
    return { tone: "stopped", label: "Tài khoản đã hết hạn mức" };
  if (substate === "auth-401")
    return { tone: "stopped", label: "Claude cần đăng nhập lại" };
  if (status === "error" || status === "stopped")
    return { tone: "stopped", label: "Claude không chạy trong terminal" };
  return { tone: "ready", label: "Sẵn sàng nhận tin" };
}
export function ChatView({
  panel,
  workspace,
  onOpen,
  onTerminal,
  onError,
  mode = "history",
  onMode,
  terminal,
  onAgents,
}) {
  const id = panel?.view === "chat" ? panel.chatId : null,
    slot = panel?.slot;
  const [history, setHistory] = useState(null),
    [draft, setDraft] = useState(""),
    [sendingId, setSendingId] = useState(null),
    [receipt, setReceipt] = useState(null),
    [limit, setLimit] = useState(120),
    [failure, setFailure] = useState(""),
    [restoredAt, setRestoredAt] = useState(0),
    [queue, setQueue] = useState(null),
    [agents, setAgents] = useState(null);
  const scroller = useRef(),
    follow = useRef(true),
    revision = useRef(),
    current = useRef(),
    loadRef = useRef();
  current.current = id;
  // A send in flight belongs to its own conversation, not to the panel.
  const sending = !!id && sendingId === id;
  useEffect(() => {
    setHistory(null);
    try {
      setReceipt(
        id
          ? JSON.parse(localStorage.getItem("chat-receipt-" + id) || "null")
          : null,
      );
    } catch {
      setReceipt(null);
    }
    setLimit(120);
    setFailure("");
    revision.current = undefined;
    follow.current = true;
    setDraft(id ? localStorage.getItem("chat-draft-" + id) || "" : "");
  }, [id, workspace]);
  useEffect(() => {
    if (!id) return;
    let alive = true,
      running = false;
    async function load() {
      if (running) return;
      running = true;
      try {
        const data = await api("chatHistory", {
          slot,
          id,
          limit,
          revision: revision.current,
        });
        if (alive) {
          revision.current = data.revision;
          setFailure("");
          setHistory((old) =>
            data.unchanged ? { ...old, session: data.session } : data,
          );
        }
      } catch (e) {
        if (alive) setFailure(e.message);
      } finally {
        running = false;
      }
    }
    loadRef.current = load;
    load();
    const stop = poller(load, 1800);
    return () => {
      alive = false;
      stop();
    };
  }, [id, slot, workspace, limit]);
  useEffect(() => {
    if (follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [history?.revision, history?.messages?.length]);
  useEffect(() => {
    if (
      !receipt?.send_id ||
      receipt.settled ||
      ["landed", "failed", "settled"].includes(receipt.state)
    )
      return;
    let alive = true;
    async function poll() {
      try {
        const data = await api("chatSendStatus", { id: receipt.send_id });
        if (alive)
          setReceipt((old) => {
            const next = { ...old, ...data };
            localStorage.setItem("chat-receipt-" + id, JSON.stringify(next));
            return next;
          });
      } catch {}
    }
    poll();
    const stop = poller(poll, 3000);
    return () => {
      alive = false;
      stop();
    };
  }, [receipt?.send_id, receipt?.state]);
  useEffect(() => {
    // "failed" means the CLI typed nothing, so the message and its files go
    // back to the composer instead of being lost.
    if (
      !id ||
      !receipt?.send_id ||
      receipt.state !== "failed" ||
      receipt.settled ||
      receipt.restored
    )
      return;
    const target = id,
      saved = receipt;
    api("chatRestoreDraft", { slot, id, sendId: saved.send_id })
      .then(() => {
        if (current.current !== target) return;
        const next = { ...saved, restored: true };
        localStorage.setItem("chat-receipt-" + target, JSON.stringify(next));
        setReceipt(next);
        if (saved.text) {
          const typed = localStorage.getItem("chat-draft-" + target) || "";
          updateDraft(typed ? saved.text + "\n\n" + typed : saved.text);
        }
        setRestoredAt(Date.now());
      })
      .catch(() => {});
  }, [id, receipt?.send_id, receipt?.state]);
  // Queue, readiness and sub-agents of this conversation.
  useEffect(() => {
    setQueue(null);
    setAgents(null);
    if (!id) return;
    let alive = true;
    const load = () =>
      Promise.all([
        api("chatQueue", { slot, id })
          .then(
            (data) =>
              alive && setQueue((old) => (same(old, data) ? old : data)),
          )
          .catch(() => {}),
        api("chatAgents", { slot, id })
          .then(
            (data) =>
              alive && setAgents((old) => (same(old, data) ? old : data)),
          )
          .catch(() => {}),
      ]);
    load();
    const stop = poller(load, 3000);
    const off = window.deck.onEvent((event) => {
      if (event.id !== id) return;
      if (event.type === "chat-queue") setQueue(event.queue);
      if (event.type === "chat-delivered") {
        localStorage.setItem(
          "chat-receipt-" + id,
          JSON.stringify(event.receipt),
        );
        setReceipt(event.receipt);
        follow.current = true;
        loadRef.current?.();
      }
    });
    return () => {
      alive = false;
      stop();
      off();
    };
  }, [id, slot, workspace]);
  async function enqueue({ attachments = [], settings } = {}) {
    if (!id || (!draft.trim() && !attachments.length)) return false;
    const target = id,
      text = draft;
    try {
      const data = await api("chatEnqueue", {
        slot,
        id,
        text,
        attachments,
        settings,
      });
      if (localStorage.getItem("chat-draft-" + target) === text)
        localStorage.removeItem("chat-draft-" + target);
      if (current.current === target) {
        setQueue(data);
        updateDraft("");
      }
      return true;
    } catch (e) {
      onError(e);
      return false;
    }
  }
  async function queueAction(method, qid) {
    const target = id;
    try {
      const data = await api(method, { slot, id, qid });
      if (current.current !== target) return;
      if (method === "chatQueueRemove") {
        setQueue(data.queue);
        return data.item;
      }
      setQueue(data);
    } catch (e) {
      onError(e);
    }
  }
  async function editQueued(qid) {
    const item = await queueAction("chatQueueRemove", qid);
    if (!item) return;
    // Back into the composer: text first, then any files it carried.
    updateDraft(item.text + (draft.trim() ? "\n\n" + draft : ""));
    if (item.attachments?.length) setRestoredAt(Date.now());
  }
  function updateDraft(value) {
    setDraft(value);
    if (id) localStorage.setItem("chat-draft-" + id, value);
  }
  async function submit({ attachments = [], settings } = {}) {
    if (!id || (!draft.trim() && !attachments.length) || sending) return false;
    const target = id,
      text = draft;
    setSendingId(target);
    setFailure("");
    try {
      const result = await api("chatSend", {
        slot,
        id,
        text,
        attachments,
        settings,
      });
      // Keep the text until delivery is known, so a failed send can return it.
      const saved = { ...result, text };
      localStorage.setItem("chat-receipt-" + target, JSON.stringify(saved));
      if (localStorage.getItem("chat-draft-" + target) === text)
        localStorage.removeItem("chat-draft-" + target);
      if (current.current === target) {
        setReceipt(saved);
        updateDraft("");
        follow.current = true;
        loadRef.current?.();
      }
      return true;
    } catch (e) {
      if (current.current === target) setFailure(e.message);
      onError(e);
      return false;
    } finally {
      setSendingId((old) => (old === target ? null : old));
    }
  }
  const readiness = queue?.readiness,
    items = queue?.items || [],
    // Messages keep their order: once one waits, the next waits too.
    composeMode =
      (readiness && !readiness.ready) || items.length || queue?.sending
        ? "queue"
        : "send",
    canSteer = !!readiness?.live && !readiness.ready,
    state = id ? sessionState(panel?.session) : null,
    runningAgents =
      agents?.agents.filter((a) => a.status === "running").length || 0,
    runningShells =
      agents?.shells.filter((s) => s.status === "running").length || 0;
  const project = panel?.project || "web",
    delivered = receipt?.state === "landed",
    // "failed" means nothing was typed; a settled send was typed but never
    // seen in the transcript (e.g. /clear starts a new one).
    failed = receipt?.state === "failed" && !receipt.settled,
    unproven =
      !delivered &&
      !failed &&
      (receipt?.settled || receipt?.state === "settled");
  return (
    <div className="expanded-chat">
      <div className={"chat-heading" + (mode === "terminal" ? " compact" : "")}>
        <span className="slot-number">{slot}</span>
        <div>
          <strong>
            {history?.session?.title ||
              panel?.session?.title ||
              "Hội thoại Claude"}
          </strong>
          <small>
            {history?.session?.account || panel?.session?.account || "Claude"} ·{" "}
            {panel?.path?.split("/").pop()}
          </small>
        </div>
        <button
          className={mode === "terminal" ? "active" : ""}
          title={
            mode === "terminal"
              ? "Đang xem terminal · bấm để xem lịch sử dạng chat"
              : "Xem như terminal đang chạy"
          }
          aria-pressed={mode === "terminal"}
          onClick={() => onMode?.(mode === "terminal" ? "history" : "terminal")}
        >
          <Icon
            name={mode === "terminal" ? "terminal" : "comment-discussion"}
          />
        </button>
        {mode !== "terminal" && (
          <button
            title="Sao chép toàn bộ chat"
            disabled={!history?.messages?.length}
            onClick={() =>
              window.deck.copy(
                history.messages
                  .filter((m) => m.role === "user" || m.role === "assistant")
                  .map(
                    (m) =>
                      (m.role === "user" ? "Bạn" : "Claude") +
                      ":\n" +
                      messageText(m),
                  )
                  .join("\n\n"),
              )
            }
          >
            <Icon name="copy" />
          </button>
        )}
        {mode !== "terminal" && (
          <button
            title="Phóng to terminal để xử lý menu / quyền"
            onClick={onTerminal}
          >
            <Icon name="screen-full" />
          </button>
        )}
      </div>
      {mode === "terminal" ? (
        terminal || (
          <div className="chat-empty">
            <Icon name="screen-full" />
            <strong>Terminal {slot} đang phóng to ở khung giữa</strong>
            <p>Thu nhỏ terminal để xem nó tại đây.</p>
          </div>
        )
      ) : (
        <div
          className="chat-messages"
          ref={scroller}
          onScroll={() => {
            const e = scroller.current;
            follow.current =
              e.scrollHeight - e.scrollTop - e.clientHeight < 100;
          }}
        >
          {history?.hasMore && (
            <button
              className="chat-load"
              onClick={() => {
                revision.current = undefined;
                follow.current = false;
                setLimit((old) => Math.min(1500, old + 120));
              }}
              disabled={limit >= 1500}
            >
              Xem tin nhắn trước ({history.total})
            </button>
          )}
          {history?.truncated && (
            <p className="muted">
              Đang hiển thị phần gần đây của hội thoại lớn.
            </p>
          )}
          {!id ? (
            <div className="chat-empty">
              <Icon name="comment-discussion" />
              <strong>Chọn tài khoản để bắt đầu</strong>
              <p>
                Tạo hoặc mở hội thoại ở terminal {slot}. Chat sẽ xuất hiện tại
                đây.
              </p>
            </div>
          ) : !history ? (
            <div className="chat-empty">
              <Icon name="loading" />
              Đang đọc hội thoại…
            </div>
          ) : !history.messages?.length ? (
            <div className="chat-empty">
              <Icon name="comment-discussion" />
              <strong>Claude đã sẵn sàng</strong>
              <p>Gửi tin nhắn bên dưới để bắt đầu trong chính phiên này.</p>
            </div>
          ) : (
            history.messages.map((message) =>
              message.role === "tool" ? (
                <details
                  className={"chat-tool " + message.state}
                  key={message.id}
                >
                  <summary>
                    <Icon
                      name={
                        message.state === "error"
                          ? "error"
                          : message.state === "running"
                            ? "loading"
                            : "check"
                      }
                    />
                    <b>{message.name}</b>
                    <span>{message.summary}</span>
                  </summary>
                  <div className="tool-body">
                    {message.file && (
                      <button
                        className="chat-file-link"
                        onClick={() => onOpen(message.file)}
                      >
                        <Icon name="file-code" />
                        {message.file}
                      </button>
                    )}
                    <pre>{message.input}</pre>
                    <Content
                      blocks={message.content}
                      onOpen={onOpen}
                      project={project}
                      conversationId={id}
                    />
                  </div>
                </details>
              ) : message.role === "system" ? (
                <div
                  className={
                    message.kind === "output"
                      ? "chat-command-output"
                      : "chat-divider"
                  }
                  key={message.id}
                >
                  {messageText(message)}
                </div>
              ) : (
                <article
                  key={message.id}
                  className={"chat-message " + message.role}
                >
                  <div className="message-meta">
                    <b>{message.role === "user" ? "Bạn" : "Claude"}</b>
                    {message.timestamp && (
                      <time>
                        {new Date(message.timestamp).toLocaleTimeString(
                          "vi-VN",
                          {
                            hour: "2-digit",
                            minute: "2-digit",
                          },
                        )}
                      </time>
                    )}
                    <button
                      title="Sao chép tin nhắn"
                      onClick={() => window.deck.copy(messageText(message))}
                    >
                      <Icon name="copy" />
                    </button>
                  </div>
                  <Content
                    blocks={message.content}
                    onOpen={onOpen}
                    project={project}
                    conversationId={id}
                  />
                </article>
              ),
            )
          )}
        </div>
      )}
      {state && (
        <div className={"session-state " + state.tone} role="status">
          <span className={"status-dot " + (panel?.session?.status || "")} />
          <b>{state.label}</b>
          {(runningAgents > 0 || runningShells > 0) && (
            <button
              className="session-work"
              title="Xem agent con và tác vụ nền"
              onClick={onAgents}
            >
              <Icon name="organization" />
              {[
                runningAgents && runningAgents + " agent con",
                runningShells && runningShells + " shell",
              ]
                .filter(Boolean)
                .join(" · ")}{" "}
              đang chạy
            </button>
          )}
          {state.tone === "attention" && (
            <button onClick={onTerminal}>Mở terminal</button>
          )}
          {state.tone === "stopped" && (
            <button
              title="Chạy lại Claude cho hội thoại này trong terminal đang chọn"
              onClick={() => api("openSession", { id, slot }).catch(onError)}
            >
              Mở lại hội thoại
            </button>
          )}
        </div>
      )}
      {items.length > 0 && (
        <div className="chat-queue" aria-label="Hàng chờ tin nhắn">
          <div className="chat-queue-title">
            <Icon name="list-ordered" />
            Hàng chờ · {items.length}
            {items[0].waiting && <span> · {items[0].waiting}</span>}
          </div>
          {items.map((item, index) => (
            <div className={"queue-item " + item.state} key={item.qid}>
              <span className="queue-index">{index + 1}</span>
              <div className="queue-text">
                <p title={item.text}>{item.text || "Tệp đính kèm"}</p>
                {item.names?.length > 0 && (
                  <small>
                    <Icon name="paperclip" />
                    {item.names.join(", ")}
                  </small>
                )}
                {item.state === "sending" && <small>Đang gửi…</small>}
                {item.state === "error" && (
                  <small className="danger">{item.error}</small>
                )}
              </div>
              <div className="queue-actions">
                {item.state === "error" && (
                  <button
                    title="Thử lại theo hàng chờ"
                    onClick={() => queueAction("chatQueueRetry", item.qid)}
                  >
                    <Icon name="refresh" />
                  </button>
                )}
                <button
                  title="Steer: gửi ngay vào lượt Claude đang chạy"
                  disabled={!readiness?.live || item.state === "sending"}
                  onClick={() => queueAction("chatQueueSteer", item.qid)}
                >
                  <Icon name="zap" />
                </button>
                <button
                  title="Sửa: đưa về ô nhập"
                  disabled={item.state === "sending"}
                  onClick={() => editQueued(item.qid)}
                >
                  <Icon name="edit" />
                </button>
                <button
                  title="Xóa khỏi hàng chờ"
                  disabled={item.state === "sending"}
                  onClick={() => queueAction("chatQueueRemove", item.qid)}
                >
                  <Icon name="close" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {(failure || (receipt && !delivered)) && (
        <div
          className={"chat-delivery " + (failure || failed ? "danger" : "")}
          role="status"
        >
          {failure ||
            (delivered
              ? "Đã gửi vào hội thoại"
              : failed
                ? "Chưa gửi: " +
                  (receipt.reason || receipt.error || "Kiểm tra terminal") +
                  (receipt.restored ? " · đã trả nội dung về khung soạn" : "")
                : unproven
                  ? receipt.text?.trim().startsWith("/")
                    ? "Đã gõ lệnh vào terminal. Lệnh / có thể không ghi vào lịch sử; xem kết quả trong terminal."
                    : "Đã gõ vào terminal nhưng chưa thấy trong lịch sử. Kiểm tra terminal trước khi gửi lại."
                  : "Đang gửi vào Claude…")}
          {receipt && !delivered && (
            <button onClick={onTerminal}>Xem terminal</button>
          )}
        </div>
      )}
      <ChatComposer
        id={id}
        slot={slot}
        workspace={workspace}
        draft={draft}
        onDraft={updateDraft}
        sending={sending}
        onSubmit={submit}
        mode={composeMode}
        onQueue={enqueue}
        onSteer={submit}
        canSteer={canSteer}
        restoredAt={restoredAt}
        status={history?.session?.status}
        onError={onError}
        onTerminal={onTerminal}
      />
    </div>
  );
}
export function MediaView({ document }) {
  const [natural, setNatural] = useState(false),
    [dimensions, setDimensions] = useState("");
  React.useLayoutEffect(() => {
    setNatural(false);
    setDimensions("");
  }, [document.key]);
  const picture = (image, label) =>
    image?.kind === "image" ? (
      <figure>
        <figcaption>{label}</figcaption>
        <img
          alt={image.path}
          src={image.src}
          onLoad={(e) =>
            setDimensions(
              `${e.target.naturalWidth} × ${e.target.naturalHeight}`,
            )
          }
        />
      </figure>
    ) : (
      <figure>
        <figcaption>{label}</figcaption>
        <p className="muted">
          {image?.bytes ? "File nhị phân" : "Không có ảnh ở phía này"}
        </p>
      </figure>
    );
  return (
    <div className={"media-view " + (natural ? "actual-size" : "")}>
      <div className="media-tools">
        <span>
          {dimensions}
          {document.bytes ? ` · ${(document.bytes / 1024).toFixed(0)} KB` : ""}
        </span>
        {document.kind !== "binary" && (
          <button onClick={() => setNatural(!natural)}>
            {natural ? "Vừa khung" : "100%"}
          </button>
        )}
      </div>
      <div className="media-canvas">
        {document.kind === "image" ? (
          picture(document, document.path)
        ) : document.kind === "image-diff" ? (
          <div className="image-comparison">
            {picture(document.before, document.originalLabel)}
            {picture(document.after, document.modifiedLabel)}
          </div>
        ) : (
          <div className="editor-empty">
            <Icon name="file-binary" />
            <strong>File nhị phân</strong>
            <p>File này không có nội dung văn bản để hiển thị diff.</p>
          </div>
        )}
      </div>
    </div>
  );
}
