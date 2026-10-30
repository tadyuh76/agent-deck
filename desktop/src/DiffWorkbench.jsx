import React, { useState, useEffect, useRef, useMemo } from "react";
import { DiffReview } from "./DiffReview";
import {
  Icon,
  FileIcon,
  Counts,
  Popover,
  MenuItem,
  relativeTime,
} from "./ReviewUI";
import { fileGroups } from "./diff-model.mjs";
const defaults = {
  showFiles: true,
  position: "automatic",
  folders: false,
  separate: false,
  split: false,
  wrap: true,
  words: true,
  ignoreWhitespace: false,
};
function preferences() {
  try {
    return {
      ...defaults,
      ...JSON.parse(localStorage.getItem("diffReviewPreferences") || "{}"),
    };
  } catch {
    return defaults;
  }
}
export default function DiffWorkbench({
  info,
  files,
  options,
  loading,
  onCompare,
  onRefresh,
  onOpen,
  onError,
  expanded,
  onExpand,
  onClose,
}) {
  const [prefs, setPrefs] = useState(preferences),
    [menu, setMenu] = useState(null),
    [submenu, setSubmenu] = useState(""),
    [query, setQuery] = useState(""),
    [branchQuery, setBranchQuery] = useState(""),
    [fileQuery, setFileQuery] = useState(""),
    [searchOpen, setSearchOpen] = useState(false),
    [selected, setSelected] = useState(null),
    [history, setHistory] = useState({ commits: [], total: 0 }),
    [historyBusy, setHistoryBusy] = useState(false),
    [historyError, setHistoryError] = useState(""),
    [revision, setRevision] = useState(0),
    [collapse, setCollapse] = useState({ serial: 0, closed: false }),
    [reviewed, setReviewed] = useState({});
  const host = useRef(),
    historyRequest = useRef(0),
    moreBusy = useRef(false),
    known = useRef(new Map()),
    fileInput = useRef();
  const signature = JSON.stringify(options);
  useEffect(() => {
    localStorage.setItem("diffReviewPreferences", JSON.stringify(prefs));
  }, [prefs]);
  useEffect(() => {
    onCompare({ ignoreWhitespace: prefs.ignoreWhitespace });
  }, [prefs.ignoreWhitespace]);
  useEffect(() => {
    setSelected(null);
    setReviewed({});
  }, [signature]);
  useEffect(() => {
    known.current.clear();
    setQuery("");
    setBranchQuery("");
  }, [options.project]);
  const historyTarget = options.mode === "branches" ? options.target : "HEAD";
  useEffect(() => {
    const request = ++historyRequest.current;
    setHistory({ commits: [], total: 0 });
    setHistoryError("");
    setHistoryBusy(!!info?.isGit);
    if (!info?.isGit) return;
    const timer = setTimeout(
      () => {
        window.deck
          .call("gitCommits", {
            project: options.project,
            target: historyTarget || "HEAD",
            base: options.base,
            search: query,
          })
          .then((data) => {
            if (request !== historyRequest.current) return;
            data.commits.forEach((c) => known.current.set(c.hash, c));
            setHistory(data);
          })
          .catch((e) => {
            if (request === historyRequest.current) setHistoryError(e.message);
          })
          .finally(() => {
            if (request === historyRequest.current) setHistoryBusy(false);
          });
      },
      query ? 250 : 0,
    );
    return () => {
      clearTimeout(timer);
      historyRequest.current++;
    };
  }, [
    options.project,
    info?.isGit,
    info?.head,
    historyTarget,
    options.base,
    query,
    revision,
  ]);
  useEffect(() => {
    const key = (e) => {
      if (
        e.ctrlKey &&
        e.shiftKey &&
        e.code === "KeyY" &&
        !e.altKey &&
        !e.target.closest?.(".terminal-mount")
      ) {
        e.preventDefault();
        setPrefs((old) => ({ ...old, showFiles: !old.showFiles }));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  async function loadMore() {
    if (!history.hasMore || historyBusy || moreBusy.current) return;
    moreBusy.current = true;
    const request = historyRequest.current;
    try {
      const data = await window.deck.call("gitCommits", {
        project: options.project,
        target: historyTarget,
        base: options.base,
        search: query,
        skip: history.commits.length,
      });
      if (request === historyRequest.current) {
        data.commits.forEach((c) => known.current.set(c.hash, c));
        setHistory((old) => ({
          ...data,
          commits: [...old.commits, ...data.commits],
        }));
      }
    } catch (e) {
      onError(e);
    } finally {
      moreBusy.current = false;
    }
  }
  const filtered = useMemo(
    () =>
      files.filter((file) =>
        file.path.toLowerCase().includes(fileQuery.toLowerCase()),
      ),
    [files, fileQuery],
  );
  const groups = useMemo(
    () => fileGroups(filtered, prefs),
    [filtered, prefs.folders, prefs.separate],
  );
  const totals = files.reduce(
    (sum, f) => ({
      added: sum.added + (f.added || 0),
      removed: sum.removed + (f.removed || 0),
    }),
    { added: 0, removed: 0 },
  );
  const commit = known.current.get(options.commit),
    scope =
      options.mode === "commit"
        ? commit
          ? commit.short + " " + commit.subject
          : options.commit?.slice(0, 9) || "Commit"
        : options.mode === "all"
          ? "All changes"
          : options.mode === "staged"
            ? "Staged changes"
            : options.mode === "unstaged"
              ? "Unstaged changes"
              : options.mode === "branches"
                ? options.base +
                  " → " +
                  (options.target === "HEAD" ? info?.branch : options.target)
                : "Uncommitted changes";
  function closeMenu() {
    setMenu(null);
    setSubmenu("");
  }
  function choose(patch) {
    onCompare(patch);
    closeMenu();
  }
  function selectCommit(c) {
    known.current.set(c.hash, c);
    choose({ mode: "commit", commit: c.hash });
  }
  function toggle(key) {
    setPrefs((old) => ({ ...old, [key]: !old[key] }));
  }
  function refresh() {
    onRefresh();
    setRevision((n) => n + 1);
    closeMenu();
  }
  const branches = ["HEAD", ...(info?.branches || [])].filter((b) =>
    b.toLowerCase().includes(branchQuery.toLowerCase()),
  );
  const commitList = (
    <div className="review-commit-picker">
      <input
        aria-label="Search commits"
        placeholder="Search commits or paste SHA"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="commit-picker-list">
        {historyBusy ? (
          <div className="empty-small">Đang đọc commits…</div>
        ) : historyError ? (
          <div className="empty-small danger">{historyError}</div>
        ) : !history.commits.length ? (
          <div className="empty-small">Không tìm thấy commit.</div>
        ) : (
          history.commits.map((c) => (
            <button
              key={c.hash}
              title={c.subject}
              className="commit-picker-row"
              onClick={() => selectCommit(c)}
            >
              <span>{c.subject}</span>
              {options.mode === "commit" && options.commit === c.hash && (
                <Icon name="check" />
              )}
              <small>{c.short}</small>
            </button>
          ))
        )}
        {history.hasMore && (
          <button className="review-load-more" onClick={loadMore}>
            Xem thêm commits
          </button>
        )}
      </div>
    </div>
  );
  return (
    <div className="diff-workbench" ref={host}>
      <div className="diff-toolbar">
        <button
          className="diff-scope-button"
          title={scope}
          aria-label="Chọn phạm vi diff"
          aria-expanded={menu?.type === "scope"}
          onClick={(e) => {
            setMenu(
              menu?.type === "scope"
                ? null
                : { type: "scope", anchor: e.currentTarget },
            );
            setSubmenu("");
          }}
        >
          <span>{scope}</span>
          {options.mode === "all" && <small>vs {options.base}</small>}
          <Icon name="chevron-down" />
        </button>
        <div className="diff-toolbar-actions">
          <button
            title="Tìm file thay đổi"
            aria-pressed={searchOpen}
            onClick={() => {
              setSearchOpen(!searchOpen);
              requestAnimationFrame(() => fileInput.current?.focus());
            }}
          >
            <Icon name="search" />
          </button>
          <button
            title="Show files (Ctrl+Shift+Y)"
            aria-pressed={prefs.showFiles}
            className={prefs.showFiles ? "active" : ""}
            onClick={() => toggle("showFiles")}
          >
            <Icon name="list-unordered" />
          </button>
          <button
            title="Tùy chọn diff"
            aria-expanded={menu?.type === "settings"}
            onClick={(e) => {
              setMenu(
                menu?.type === "settings"
                  ? null
                  : { type: "settings", anchor: e.currentTarget },
              );
              setSubmenu("");
            }}
          >
            <Icon name="ellipsis" />
          </button>
          <button
            title={expanded ? "Thu nhỏ diff" : "Mở rộng diff"}
            onClick={onExpand}
          >
            <Icon name={expanded ? "screen-normal" : "screen-full"} />
          </button>
          <button title="Đóng panel" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      </div>
      {searchOpen && (
        <div className="diff-search-bar">
          <Icon name="search" />
          <input
            ref={fileInput}
            aria-label="Lọc file thay đổi"
            placeholder="Lọc file thay đổi…"
            value={fileQuery}
            onChange={(e) => setFileQuery(e.target.value)}
          />
          <span>
            {filtered.length}/{files.length}
          </span>
          <button
            title="Xóa bộ lọc"
            onClick={() => {
              setFileQuery("");
              setSearchOpen(false);
            }}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      {options.mode === "branches" && (
        <div className="review-branch-controls">
          <select
            aria-label="Branch gốc"
            value={options.base}
            onChange={(e) => onCompare({ base: e.target.value })}
          >
            {["HEAD", ...(info?.branches || [])].map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
          <Icon name="arrow-right" />
          <select
            aria-label="Branch đích"
            value={options.target}
            onChange={(e) => onCompare({ target: e.target.value })}
          >
            {["HEAD", ...(info?.branches || [])].map((b) => (
              <option key={b} value={b}>
                {b === "HEAD" ? "HEAD · " + info?.branch : b}
              </option>
            ))}
          </select>
          <label title="So sánh từ điểm tách nhánh">
            <input
              type="checkbox"
              checked={options.mergeBase}
              onChange={(e) => onCompare({ mergeBase: e.target.checked })}
            />
            Merge base
          </label>
        </div>
      )}
      <div
        className={
          "review-workspace position-" +
          prefs.position +
          (prefs.showFiles ? "" : " hide-review-rail")
        }
      >
        <div className="review-code-column" aria-busy={loading}>
          {loading && <div className="review-loading">Đang đọc thay đổi…</div>}
          {!loading && !filtered.length ? (
            <div className="review-no-changes">
              <Icon name={info?.isGit ? "check" : "folder-opened"} />
              <strong>
                {fileQuery
                  ? "Không có file khớp bộ lọc"
                  : "Không có thay đổi trong phạm vi này"}
              </strong>
              <p>
                {info && !info.isGit
                  ? "Thư mục này không dùng Git. Mở Files để xem nội dung."
                  : options.mode === "staged"
                    ? "Chưa có thay đổi được stage."
                    : "Chọn commit hoặc branch khác để xem diff."}
              </p>
              {options.mode !== "working" && info?.isGit && (
                <button onClick={() => choose({ mode: "working" })}>
                  Xem thay đổi chưa commit
                </button>
              )}
            </div>
          ) : (
            <DiffReview
              files={filtered}
              options={options}
              display={prefs}
              selected={selected}
              collapse={collapse}
              reviewed={reviewed}
              onReviewed={(path, revision) =>
                setReviewed((old) => ({ ...old, [path]: revision }))
              }
              onOpen={onOpen}
              onError={onError}
            />
          )}
        </div>
        {prefs.showFiles && (
          <aside className="review-navigation" aria-label="Files and commits">
            <div className="review-files-list">
              {groups.map((group) => (
                <React.Fragment key={group.label}>
                  {group.label && (
                    <div className="review-folder-heading" title={group.label}>
                      <Icon name="folder" />
                      {group.label}
                    </div>
                  )}
                  {group.files.map((f) => {
                    const name = f.path.split("/").pop(),
                      folder = f.path.split("/").slice(0, -1).join("/");
                    return (
                      <button
                        className={
                          "review-nav-file " +
                          (selected?.path === f.path ? "selected" : "")
                        }
                        key={f.path}
                        title={(f.oldPath ? f.oldPath + " → " : "") + f.path}
                        onClick={() =>
                          setSelected({ path: f.path, nonce: Date.now() })
                        }
                      >
                        <FileIcon path={f.path} binary={f.binary} />
                        <span className="nav-file-label">
                          <span>{name}</span>
                          {!prefs.folders && folder && <small>{folder}</small>}
                        </span>
                        <Counts file={f} />
                      </button>
                    );
                  })}
                </React.Fragment>
              ))}
              {!filtered.length && (
                <div className="empty-small">
                  {loading ? "Đang đọc files…" : "Không có file thay đổi"}
                </div>
              )}
            </div>
            <div className="review-files-total">
              <span>{files.length} files</span>
              <Counts file={totals} />
            </div>
            <div className="review-commits">
              <div className="review-commits-heading">
                <Icon name="chevron-down" />
                <span>Commits</span>
                <small>{history.total.toLocaleString()}</small>
              </div>
              <button
                className={
                  "review-all-changes " +
                  (options.mode === "all" ? "selected" : "")
                }
                onClick={() => {
                  setQuery("");
                  choose({ mode: "all" });
                }}
              >
                All changes <small>vs {options.base}</small>
              </button>
              <div className="review-commits-list">
                {historyBusy ? (
                  <div className="empty-small">Đang đọc commits…</div>
                ) : historyError ? (
                  <div className="empty-small danger">{historyError}</div>
                ) : (
                  history.commits.map((c) => (
                    <button
                      key={c.hash}
                      className={
                        "review-commit-card " +
                        (options.mode === "commit" && options.commit === c.hash
                          ? "selected"
                          : "")
                      }
                      title={c.subject + "\n" + c.hash}
                      onClick={() => selectCommit(c)}
                    >
                      <span>{c.subject}</span>
                      <small>
                        {c.short} · {c.author} · {relativeTime(c.date)}
                      </small>
                    </button>
                  ))
                )}
                {history.hasMore && (
                  <button className="review-load-more" onClick={loadMore}>
                    Xem thêm commits
                  </button>
                )}
                {!historyBusy && !historyError && !history.commits.length && (
                  <div className="empty-small">Chưa có commit.</div>
                )}
              </div>
            </div>
          </aside>
        )}
      </div>
      {menu && (
        <Popover
          anchor={menu.anchor}
          onClose={closeMenu}
          className={submenu ? "review-menu-with-sub" : ""}
        >
          <div className="review-menu-main">
            {menu.type === "scope" ? (
              <>
                <MenuItem
                  onClick={() => choose({ mode: "all" })}
                  checked={options.mode === "all"}
                  shortcut={"vs " + options.base}
                >
                  All changes
                </MenuItem>
                <MenuItem
                  onClick={() => choose({ mode: "working" })}
                  checked={options.mode === "working"}
                >
                  Uncommitted changes
                </MenuItem>
                <MenuItem
                  onClick={() => choose({ mode: "unstaged" })}
                  checked={options.mode === "unstaged"}
                >
                  Unstaged changes
                </MenuItem>
                <MenuItem
                  onClick={() => choose({ mode: "staged" })}
                  checked={options.mode === "staged"}
                >
                  Staged changes
                </MenuItem>
                <hr />
                <MenuItem
                  shortcut={options.base}
                  arrow
                  onClick={() => {
                    setSubmenu(submenu === "branches" ? "" : "branches");
                    setBranchQuery("");
                  }}
                >
                  Compare against
                </MenuItem>
                <MenuItem
                  onClick={() => choose({ mode: "branches", target: "HEAD" })}
                >
                  Compare two branches…
                </MenuItem>
                <hr />
                <MenuItem
                  shortcut={
                    options.mode === "commit" ? options.commit?.slice(0, 9) : ""
                  }
                  arrow
                  onClick={() =>
                    setSubmenu(submenu === "commits" ? "" : "commits")
                  }
                >
                  Commits
                </MenuItem>
              </>
            ) : (
              <>
                <MenuItem
                  checked={prefs.showFiles}
                  shortcut="Ctrl+Shift+Y"
                  onClick={() => toggle("showFiles")}
                >
                  Show files
                </MenuItem>
                <MenuItem
                  shortcut={
                    prefs.position[0].toUpperCase() + prefs.position.slice(1)
                  }
                  arrow
                  onClick={() =>
                    setSubmenu(submenu === "position" ? "" : "position")
                  }
                >
                  File list position
                </MenuItem>
                <MenuItem
                  checked={prefs.folders}
                  onClick={() => toggle("folders")}
                >
                  Group files by folder
                </MenuItem>
                <MenuItem
                  checked={prefs.separate}
                  onClick={() => toggle("separate")}
                >
                  Separate test, build, and generated files
                </MenuItem>
                <hr />
                <MenuItem
                  onClick={() => {
                    setCollapse((old) => ({
                      serial: old.serial + 1,
                      closed: true,
                    }));
                    closeMenu();
                  }}
                >
                  Collapse all files
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setCollapse((old) => ({
                      serial: old.serial + 1,
                      closed: false,
                    }));
                    closeMenu();
                  }}
                >
                  Expand all files
                </MenuItem>
                <hr />
                <MenuItem checked={prefs.split} onClick={() => toggle("split")}>
                  Side by side
                </MenuItem>
                <MenuItem checked={prefs.wrap} onClick={() => toggle("wrap")}>
                  Word wrap
                </MenuItem>
                <MenuItem checked={prefs.words} onClick={() => toggle("words")}>
                  Highlight changed words
                </MenuItem>
                <MenuItem
                  checked={prefs.ignoreWhitespace}
                  onClick={() => toggle("ignoreWhitespace")}
                >
                  Hide whitespace changes
                </MenuItem>
                <hr />
                <MenuItem onClick={refresh}>Refresh</MenuItem>
              </>
            )}
          </div>
          {submenu && (
            <div className="review-menu-sub">
              {submenu === "commits" ? (
                commitList
              ) : submenu === "branches" ? (
                <>
                  <input
                    autoFocus
                    aria-label="Search branches"
                    placeholder="Search branches"
                    value={branchQuery}
                    onChange={(e) => setBranchQuery(e.target.value)}
                  />
                  <div className="review-branch-picker">
                    {branches.map((b) => (
                      <MenuItem
                        key={b}
                        checked={options.base === b}
                        onClick={() => choose({ mode: "all", base: b })}
                      >
                        {b}
                      </MenuItem>
                    ))}
                    {!branches.length && (
                      <div className="empty-small">Không tìm thấy branch.</div>
                    )}
                  </div>
                </>
              ) : (
                ["automatic", "right", "left", "bottom"].map((p) => (
                  <MenuItem
                    key={p}
                    checked={prefs.position === p}
                    onClick={() => {
                      setPrefs((old) => ({ ...old, position: p }));
                      setSubmenu("");
                    }}
                  >
                    {p[0].toUpperCase() + p.slice(1)}
                  </MenuItem>
                ))
              )}
            </div>
          )}
        </Popover>
      )}
    </div>
  );
}
