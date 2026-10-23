import React, { useEffect, useState } from "react";
import { activity, ago, projectTree } from "./project-tree.mjs";
const Icon = ({ name, ...props }) => (
  <span className={"codicon codicon-" + name} aria-hidden="true" {...props} />
);
const PREVIEW = 5;
const getSaved = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
function SessionRow({ session, panels, active, onOpen, onMenu, now }) {
  const open = panels.find((p) => p.chatId === session.id && p.view === "chat"),
    current = open?.slot === active;
  const menu = (event, x, y) => {
    event.preventDefault();
    onMenu(session, x, y);
  };
  return (
    <button
      className={"tree-session" + (current ? " selected" : "")}
      title={[
        session.title,
        session.account + " · " + session.path,
        open
          ? "Đang mở ở terminal " + open.slot
          : "Bấm để mở vào terminal " + active,
      ].join("\n")}
      onClick={(event) => onOpen(session, event)}
      onContextMenu={(event) => menu(event, event.clientX, event.clientY)}
      onKeyDown={(event) => {
        if (
          event.key === "ContextMenu" ||
          (event.shiftKey && event.key === "F10")
        ) {
          const rect = event.currentTarget.getBoundingClientRect();
          menu(event, rect.right, rect.top);
        }
      }}
    >
      <span className={"status-dot " + session.status} />
      <span className="tree-session-title">{session.title}</span>
      {open ? (
        <span
          className={"terminal-badge" + (current ? " current" : "")}
          aria-label={"Terminal " + open.slot}
        >
          {open.slot}
        </span>
      ) : (
        <time className="tree-session-time">{ago(activity(session), now)}</time>
      )}
    </button>
  );
}
function ProjectNode({
  node,
  depth,
  expanded,
  onToggle,
  more,
  onMore,
  selected,
  onSelect,
  onNewChat,
  children,
  ...rows
}) {
  const { project, chats } = node,
    id = project.id,
    open = expanded(node),
    limit = more.has(id) ? chats.length : PREVIEW;
  return (
    <div className="tree-project" style={{ "--depth": depth }}>
      <div
        className={
          "tree-project-row" +
          (selected === id ? " selected" : "") +
          (project.available === false ? " unavailable" : "")
        }
      >
        <button
          className="tree-chevron"
          aria-label={open ? "Thu gọn " + project.name : "Mở " + project.name}
          aria-expanded={open}
          onClick={() => onToggle(node)}
        >
          <Icon name={open ? "chevron-down" : "chevron-right"} />
        </button>
        <button
          className="tree-project-name"
          title={
            project.available === false
              ? "Không tìm thấy thư mục: " + project.path
              : project.path || project.name
          }
          onClick={() => {
            if (id !== "other") onSelect(id);
            if (!open) onToggle(node);
          }}
        >
          <Icon
            name={
              project.kind === "worktree"
                ? "git-branch"
                : open
                  ? "folder-opened"
                  : "folder"
            }
          />
          <span>{project.name}</span>
          {project.kind === "worktree" && project.branch && (
            <small>{project.branch}</small>
          )}
        </button>
        {id !== "other" && (
          <button
            className="tree-add"
            title={"Chat mới trong " + project.name}
            onClick={() => onNewChat(id)}
          >
            <Icon name="add" />
          </button>
        )}
      </div>
      {open && (
        <div className="tree-children">
          {chats.slice(0, limit).map((session) => (
            <SessionRow key={session.id} session={session} {...rows} />
          ))}
          {chats.length > PREVIEW && (
            <button className="tree-more" onClick={() => onMore(id)}>
              {more.has(id)
                ? "Thu gọn"
                : "Xem thêm " + (chats.length - PREVIEW) + " hội thoại"}
            </button>
          )}
          {children}
          {!chats.length && !node.shown?.length && (
            <p className="tree-empty">Chưa có hội thoại</p>
          )}
        </div>
      )}
    </div>
  );
}
export default function ProjectSidebar({
  state,
  active,
  selected,
  archived,
  onArchived,
  onSelect,
  onOpenSession,
  onSessionMenu,
  onNewChat,
  onOpenFolder,
}) {
  const [search, setSearch] = useState(""),
    // Open/closed choices the operator made, by project id; everything else
    // follows the default below.
    [opened, setOpened] = useState(() => getSaved("sidebarExpanded", {})),
    [more, setMore] = useState(() => new Set()),
    [worktrees, setWorktrees] = useState(() => new Set()),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    try {
      localStorage.setItem("sidebarExpanded", JSON.stringify(opened));
    } catch {}
  }, [opened]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  const toggle = (set) => (id) =>
    set((old) => {
      const next = new Set(old);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const { roots, total } = projectTree(state, {
    archived,
    search,
    selected,
  });
  // Searching opens every matching group. Otherwise projects start open, as
  // in Codex, and a worktree starts open only when it has chats.
  const expanded = (node) =>
    !!search.trim() ||
    (opened[node.project.id] ??
      (!node.project.parent || node.chats.length > 0));
  const rows = {
    panels: state?.panels || [],
    active,
    onOpen: onOpenSession,
    onMenu: onSessionMenu,
    now,
  };
  const common = {
    expanded,
    onToggle: (node) =>
      setOpened((old) => ({ ...old, [node.project.id]: !expanded(node) })),
    more,
    onMore: toggle(setMore),
    selected,
    onSelect,
    onNewChat,
    ...rows,
  };
  return (
    <div className="project-sidebar">
      <button
        className="sidebar-new-chat"
        title={"Chat mới trong thư mục đang chọn, mở ở terminal " + active}
        onClick={() => onNewChat(selected)}
      >
        <Icon name="comment-add" />
        <span>Chat mới</span>
        <span className="terminal-badge current">{active}</span>
      </button>
      <div className="search">
        <Icon name="search" />
        <input
          className="session-search"
          aria-label="Tìm hội thoại"
          placeholder="Tìm hội thoại…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="sidebar-heading">
        <span>{archived ? "ĐÃ ARCHIVE" : "DỰ ÁN"}</span>
        <span
          className="sidebar-target"
          title="Hội thoại được mở vào terminal đang chọn"
        >
          → T{active}
        </span>
        <button
          title="Mở thư mục / worktree bất kỳ trên máy"
          onClick={onOpenFolder}
        >
          <Icon name="new-folder" />
        </button>
        <button
          className={archived ? "active" : ""}
          title={
            archived ? "Xem hội thoại đang dùng" : "Xem hội thoại đã archive"
          }
          onClick={() => onArchived(!archived)}
        >
          <Icon name={archived ? "comment-discussion" : "archive"} />
        </button>
      </div>
      <div className="project-tree" role="tree">
        {roots.map((root) => (
          <ProjectNode key={root.project.id} node={root} depth={0} {...common}>
            {root.shown.map((child) => (
              <ProjectNode
                key={child.project.id}
                node={child}
                depth={1}
                {...common}
              />
            ))}
            {root.hidden.length > 0 && (
              <>
                <button
                  className="tree-more"
                  onClick={() => toggle(setWorktrees)(root.project.id)}
                >
                  <Icon name="git-branch" />
                  {worktrees.has(root.project.id)
                    ? "Ẩn worktree không có hội thoại"
                    : root.hidden.length + " worktree khác"}
                </button>
                {worktrees.has(root.project.id) &&
                  root.hidden.map((child) => (
                    <ProjectNode
                      key={child.project.id}
                      node={child}
                      depth={1}
                      {...common}
                    />
                  ))}
              </>
            )}
          </ProjectNode>
        ))}
        {state && !total && (
          <p className="empty-small">
            {search.trim()
              ? "Không có hội thoại khớp."
              : archived
                ? "Chưa có hội thoại nào được archive."
                : "Chọn tài khoản trong một terminal để bắt đầu."}
          </p>
        )}
      </div>
    </div>
  );
}
