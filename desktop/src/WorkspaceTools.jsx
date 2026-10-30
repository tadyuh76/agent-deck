import React, { useEffect, useRef, useState } from "react";
const api = (method, args) => window.deck.call(method, args);
const Icon = ({ name }) => (
  <span className={"codicon codicon-" + name} aria-hidden="true" />
);
function Dialog({
  title,
  children,
  onClose,
  onSubmit,
  busy,
  submit = "Tiếp tục",
}) {
  const host = useRef();
  useEffect(() => {
    host.current?.querySelector("input,select,button")?.focus();
    const key = (e) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const nodes = [
            ...host.current.querySelectorAll(
              "input:not(:disabled),select:not(:disabled),button:not(:disabled)",
            ),
          ],
          first = nodes[0],
          last = nodes.at(-1);
        if (e.shiftKey && globalThis.document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && globalThis.document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy]);
  return (
    <div
      className="dialog-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="workspace-dialog"
        ref={host}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={onSubmit}
      >
        <h2>{title}</h2>
        {children}
        <div className="dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Hủy
          </button>
          <button type="submit" className="save-rename" disabled={busy}>
            {busy ? "Đang xử lý…" : submit}
          </button>
        </div>
      </form>
    </div>
  );
}
export default function WorkspaceTools({
  state,
  project,
  info,
  follow,
  onFollow,
  onProject,
  onLocation,
  onUpdated,
  onError,
  dirty,
  active,
  request,
  onRequestDone,
}) {
  const [dialog, setDialog] = useState(null),
    [form, setForm] = useState({}),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState("");
  const entry = state?.projects.find((p) => p.id === project),
    local = info?.localBranches || [];
  const affected =
    state?.sessions.filter((s) => s.project === project && !s.archived) || [];
  const update = (key, value) => setForm((old) => ({ ...old, [key]: value }));
  // The sidebar's "+" on a project asks for a new chat on the selected
  // terminal; the project itself arrives through the `project` prop.
  useEffect(() => {
    if (!request) return;
    open("chat", { slot: request.slot });
    // Consumed once, so remounting the panel does not reopen the dialog.
    onRequestDone();
  }, [request?.at]);
  function open(kind, preset = {}) {
    if (dirty)
      return onError(new Error("Lưu file đang sửa trước khi đổi ngữ cảnh."));
    setFailure("");
    setDialog(kind);
    setForm(
      kind === "worktree"
        ? { branch: "", base: "HEAD", create: true, destination: "" }
        : kind === "branch"
          ? { branch: local.find((b) => b !== info.branch) || info.branch }
          : kind === "chat"
            ? {
                account:
                  state?.accounts.find((a) => a.usage.status === "ready")
                    ?.slot || "",
                slot:
                  preset.slot ||
                  state?.panels.find((p) => p.view === "empty")?.slot ||
                  active,
              }
            : { path: "" },
    );
  }
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setFailure("");
    try {
      let result;
      if (dialog === "path")
        result = await api("openLocation", { project, path: form.path });
      if (dialog === "worktree") {
        const destination =
          form.destination.trim() ||
          entry.path +
            "-worktrees/" +
            form.branch.replace(/[^a-zA-Z0-9._-]/g, "-");
        if (!form.branch.trim()) throw new Error("Nhập tên branch");
        result = await api("worktreeCreate", {
          project,
          branch: form.branch.trim(),
          base: form.base,
          create: form.create,
          destination,
        });
      }
      if (dialog === "branch")
        result = await api("branchSwitch", { project, branch: form.branch });
      if (dialog === "chat")
        result = await api("newConversation", {
          project,
          slot: Number(form.slot),
          account: form.account,
        });
      if (dialog === "path") onLocation(result);
      else onUpdated(result);
      setDialog(null);
    } catch (e) {
      setFailure(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="workspace-context">
        <div className="workspace-context-main">
          <Icon name={entry?.kind === "worktree" ? "git-branch" : "folder"} />
          <select
            aria-label="Thư mục hoặc worktree để review"
            value={project}
            disabled={dirty}
            onChange={(e) => onProject(e.target.value)}
          >
            {state?.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.kind === "worktree" ? "↳ " : ""}
                {p.name}
                {p.branch ? " · " + p.branch : ""}
              </option>
            ))}
          </select>
          <button
            title="Mở đường dẫn Windows / WSL bất kỳ"
            onClick={() => open("path")}
          >
            <Icon name="go-to-file" />
          </button>
          <button
            title="Mở thư mục trên máy"
            onClick={() =>
              window.deck
                .pickPath("folder")
                .then((r) => r && onLocation(r))
                .catch(onError)
            }
          >
            <Icon name="folder-opened" />
          </button>
          <button
            title="Mở file ngoài dự án"
            onClick={() =>
              window.deck
                .pickPath("file")
                .then((r) => r && onLocation(r))
                .catch(onError)
            }
          >
            <Icon name="file" />
          </button>
        </div>
        <div className="workspace-context-meta">
          <label>
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => onFollow(e.target.checked)}
            />
            Theo terminal {active}
          </label>
          <span title={entry?.path}>{entry?.path}</span>
        </div>
        <div className="workspace-git-actions">
          <span className="workspace-branch" title={info?.head}>
            <Icon name="git-branch" />
            {info?.branch ||
              (info ? "Thư mục không dùng Git" : "Đang đọc branch…")}
          </span>
          {info?.isGit && (
            <>
              <button
                title="Đổi branch checkout trong thư mục này"
                disabled={dirty}
                onClick={() => open("branch")}
              >
                Đổi branch
              </button>
              <button
                title="Tạo worktree riêng cho task"
                disabled={dirty}
                onClick={() => open("worktree")}
              >
                + Worktree
              </button>
            </>
          )}
          <button
            title="Mở chat mới trong đúng thư mục / worktree đang chọn"
            disabled={dirty}
            onClick={() => open("chat")}
          >
            <Icon name="comment-add" />
            Chat mới
          </button>
        </div>
      </div>
      {dialog && (
        <Dialog
          title={
            dialog === "worktree"
              ? "Tạo worktree cho task"
              : dialog === "branch"
                ? "Đổi branch checkout"
                : dialog === "chat"
                  ? "Chat mới trong thư mục này"
                  : "Mở đường dẫn trên máy"
          }
          busy={busy}
          onClose={() => setDialog(null)}
          onSubmit={submit}
          submit={
            dialog === "worktree"
              ? "Tạo worktree"
              : dialog === "branch"
                ? "Đổi branch"
                : dialog === "chat"
                  ? "Mở chat"
                  : "Mở"
          }
        >
          <p className="workspace-dialog-path">{entry?.path}</p>
          {dialog === "path" && (
            <label>
              Đường dẫn file hoặc thư mục
              <input
                aria-label="Đường dẫn trên máy"
                placeholder="S:\\... hoặc ~/..."
                value={form.path}
                onChange={(e) => update("path", e.target.value)}
                required
              />
            </label>
          )}
          {dialog === "worktree" && (
            <>
              <label className="workspace-check">
                <input
                  type="checkbox"
                  checked={form.create}
                  onChange={(e) => update("create", e.target.checked)}
                />
                Tạo branch mới
              </label>
              <label>
                Branch cho task
                {form.create ? (
                  <input
                    aria-label="Branch worktree mới"
                    value={form.branch}
                    onChange={(e) => update("branch", e.target.value)}
                    placeholder="feat/my-task"
                    required
                  />
                ) : (
                  <select
                    aria-label="Branch worktree có sẵn"
                    value={form.branch}
                    onChange={(e) => update("branch", e.target.value)}
                    required
                  >
                    <option value="">Chọn branch local</option>
                    {local.map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </select>
                )}
              </label>
              {form.create && (
                <label>
                  Bắt đầu từ
                  <select
                    aria-label="Branch gốc worktree"
                    value={form.base}
                    onChange={(e) => update("base", e.target.value)}
                  >
                    <option value="HEAD">HEAD · {info.branch}</option>
                    {info.branches.map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                Thư mục worktree
                <input
                  aria-label="Thư mục worktree mới"
                  value={form.destination}
                  onChange={(e) => update("destination", e.target.value)}
                  placeholder={entry.path + "-worktrees/<task>"}
                />
              </label>
              <p>
                Worktree có checkout và thay đổi riêng. Sau khi tạo, chọn{" "}
                <b>Chat mới</b> để chạy task tại đó.
              </p>
            </>
          )}
          {dialog === "branch" && (
            <>
              <label>
                Branch local
                <select
                  aria-label="Branch checkout"
                  value={form.branch}
                  onChange={(e) => update("branch", e.target.value)}
                >
                  {local.map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
              </label>
              <p>
                Thao tác đổi checkout của thư mục đang chọn.{" "}
                {affected.length > 0
                  ? `${affected.length} hội thoại dùng thư mục này; các hội thoại đó sẽ cùng thấy branch mới.`
                  : ""}{" "}
                Chỉ đổi khi thư mục sạch và agent không đang xử lý.
              </p>
            </>
          )}
          {dialog === "chat" && (
            <>
              <label>
                Tài khoản
                <select
                  aria-label="Tài khoản chat worktree"
                  value={form.account}
                  onChange={(e) => update("account", e.target.value)}
                  required
                >
                  <option value="">Chọn tài khoản</option>
                  {state.accounts.map((a) => (
                    <option
                      key={a.slot}
                      value={a.slot}
                      disabled={a.usage.status !== "ready"}
                    >
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Terminal
                <select
                  aria-label="Terminal cho chat mới"
                  value={form.slot}
                  onChange={(e) => update("slot", e.target.value)}
                >
                  {state.panels.map((p) => (
                    <option key={p.slot} value={p.slot}>
                      {p.slot} ·{" "}
                      {p.view === "empty"
                        ? "Trống"
                        : p.session?.title || "Đang dùng"}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                Nếu terminal đã có chat, chat đó tiếp tục chạy và vẫn nằm trong
                danh sách hội thoại.
              </p>
            </>
          )}
          {failure && (
            <p className="danger" role="alert">
              {failure}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}
