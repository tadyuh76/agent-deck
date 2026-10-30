import React, { useState, useEffect, useRef, useMemo } from "react";
import { poller } from "./polling.mjs";
import { reviewBlocks, splitRows } from "./diff-model.mjs";
import { createPatch } from "diff";
import { MediaView } from "./ChatView";
import { Icon, FileIcon, Counts, Popover, MenuItem } from "./ReviewUI";
const tokenPattern =
  /(\/\/.*$|#[^!].*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|if|else|async|await|import|export|from|class|new|throw|try|catch|finally|for|while|switch|case|break|true|false|null|undefined|def|self|public|private|static|void|interface|type|extends|require)\b|\b\d+(?:\.\d+)?\b)/g;
function Syntax({ text }) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const value = match[0],
      type = /^(\/\/|#)/.test(value)
        ? "comment"
        : /^["'`]/.test(value)
          ? "string"
          : /^\d/.test(value)
            ? "number"
            : "keyword";
    parts.push(
      <span key={match.index} className={"syntax-" + type}>
        {value}
      </span>,
    );
    last = match.index + value.length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}
function CodeLine({ row, side }) {
  if (!row)
    return (
      <div className="diff-line blank">
        <span className="diff-gutter" />
        <span className="diff-sign" />
        <code> </code>
      </div>
    );
  return (
    <div className={"diff-line " + row.type}>
      <span
        className="diff-gutter"
        title={
          side === "left" || row.type === "remove" ? "Dòng cũ" : "Dòng mới"
        }
      >
        {side === "left" || row.type === "remove" ? row.old : row.next}
      </span>
      <span className="diff-sign">
        {row.type === "add" ? "+" : row.type === "remove" ? "−" : " "}
      </span>
      <code>
        {row.words ? (
          row.words.map((part, i) => (
            <span key={i} className={part.changed ? "changed-word" : undefined}>
              <Syntax text={part.text} />
            </span>
          ))
        ) : (
          <Syntax text={row.text} />
        )}
        {!row.text && " "}
      </code>
    </div>
  );
}
function InlineDiff({ data, display }) {
  const blocks = useMemo(
    () => reviewBlocks(data.original, data.modified, 3, display),
    [data.original, data.modified, display.words, display.ignoreWhitespace],
  );
  const [expanded, setExpanded] = useState({}),
    [max, setMax] = useState(2000);
  useEffect(() => {
    setExpanded({});
    setMax(2000);
  }, [data.revision, display.ignoreWhitespace]);
  if (!blocks)
    return (
      <div className="empty-small">
        Diff quá lớn để tính ngay. Dùng nút mở file để xem nội dung.
      </div>
    );
  let used = 0,
    omitted = 0;
  return (
    <>
      <div
        className={
          "unified-code " +
          (display.wrap ? "wrap-code " : "") +
          (display.split ? "split-code" : "")
        }
      >
        {blocks.map((block, i) => {
          if (block.folded && !expanded[block.id])
            return (
              <button
                key={block.id}
                className="fold-lines"
                onClick={() =>
                  setExpanded((old) => ({ ...old, [block.id]: true }))
                }
              >
                {block.rows.length} unmodified lines
              </button>
            );
          const rows = block.rows.slice(0, Math.max(0, max - used));
          used += rows.length;
          omitted += block.rows.length - rows.length;
          return (
            <React.Fragment key={block.id || i}>
              {block.folded && (
                <button
                  className="fold-lines"
                  onClick={() =>
                    setExpanded((old) => ({ ...old, [block.id]: false }))
                  }
                >
                  <Icon name="fold" /> Thu gọn {block.rows.length} dòng
                </button>
              )}
              {display.split
                ? splitRows(rows).map((pair, j) => (
                    <div className="diff-pair" key={j}>
                      <CodeLine row={pair.left} side="left" />
                      <CodeLine row={pair.right} side="right" />
                    </div>
                  ))
                : rows.map((row) => <CodeLine key={row.id} row={row} />)}
            </React.Fragment>
          );
        })}
      </div>
      {omitted > 0 && (
        <button
          className="load-diff-lines"
          onClick={() => setMax((old) => old + 2000)}
        >
          Hiện thêm dòng ({omitted.toLocaleString()} dòng còn lại)
        </button>
      )}
      {data.original === data.modified && (
        <div className="empty-small">
          Nội dung không đổi; chỉ đổi tên hoặc thuộc tính file.
        </div>
      )}
    </>
  );
}
function DiffCard({
  file,
  options,
  display,
  collapse,
  selected,
  onOpen,
  register,
  reviewed,
  onReviewed,
  onError,
}) {
  const host = useRef(),
    [visible, setVisible] = useState(false),
    [data, setData] = useState(null),
    [failure, setFailure] = useState(""),
    [closed, setClosed] = useState(false),
    [menu, setMenu] = useState(null);
  const signature = JSON.stringify(options);
  useEffect(() => {
    register(file.path, host.current);
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((e) => e.isIntersecting)),
      { rootMargin: "250px" },
    );
    observer.observe(host.current);
    return () => {
      observer.disconnect();
      register(file.path, null);
    };
  }, [file.path]);
  useEffect(() => {
    if (selected) {
      setVisible(true);
      setClosed(false);
    }
  }, [selected]);
  useEffect(() => {
    if (collapse.serial) setClosed(collapse.closed);
  }, [collapse.serial]);
  useEffect(() => {
    if (!visible || closed) return;
    let alive = true,
      running = false;
    async function load() {
      if (running) return;
      running = true;
      try {
        const result = await window.deck.call("diff", {
          ...options,
          path: file.path,
          oldPath: file.oldPath,
        });
        if (alive) {
          setData((old) => (old?.revision === result.revision ? old : result));
          setFailure("");
        }
      } catch (e) {
        if (alive) setFailure(e.message);
      } finally {
        running = false;
      }
    }
    load();
    const stop = options.mode === "commit" ? null : poller(load, 5000);
    return () => {
      alive = false;
      stop?.();
    };
  }, [visible, closed, signature, file.path, file.added, file.removed]);
  const isReviewed = !!data && reviewed === data.revision;
  function copy(kind) {
    setMenu(null);
    const value =
      kind === "path"
        ? file.path
        : data?.kind === "diff"
          ? createPatch(
              file.path,
              data.original,
              data.modified,
              data.originalLabel,
              data.modifiedLabel,
            )
          : "";
    navigator.clipboard.writeText(value).catch(onError);
  }
  return (
    <section
      ref={host}
      className={
        "review-diff-file " +
        (selected ? "selected " : "") +
        (isReviewed ? "reviewed" : "")
      }
      data-path={file.path}
    >
      <header>
        <button
          className="diff-file-name"
          aria-expanded={!closed}
          title={file.path}
          onClick={() => setClosed(!closed)}
        >
          <Icon name={closed ? "chevron-right" : "chevron-down"} />
          <FileIcon path={file.path} binary={file.binary} />
          <span>{file.path.split("/").pop()}</span>
        </button>
        <Counts file={file} />
        <div className="diff-file-actions">
          <button
            title={isReviewed ? "Bỏ đánh dấu đã xem" : "Đánh dấu đã xem"}
            aria-pressed={isReviewed}
            disabled={!data || !!failure}
            onClick={() =>
              onReviewed(file.path, isReviewed ? null : data.revision)
            }
          >
            <Icon name={isReviewed ? "pass-filled" : "pass"} />
          </button>
          <button
            title="Mở file trong editor / preview"
            onClick={() => onOpen(file.path)}
          >
            <Icon name="link-external" />
          </button>
          <button
            title="Tùy chọn file"
            aria-expanded={!!menu}
            onClick={(e) => setMenu(menu ? null : e.currentTarget)}
          >
            <Icon name="ellipsis" />
          </button>
        </div>
      </header>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)}>
          <MenuItem
            onClick={() => {
              setMenu(null);
              onOpen(file.path);
            }}
          >
            Mở file
          </MenuItem>
          <MenuItem onClick={() => copy("path")}>Copy đường dẫn</MenuItem>
          <MenuItem
            disabled={data?.kind !== "diff"}
            onClick={() => copy("patch")}
          >
            Copy diff
          </MenuItem>
          <MenuItem
            checked={isReviewed}
            disabled={!data}
            onClick={() => {
              onReviewed(file.path, isReviewed ? null : data.revision);
              setMenu(null);
            }}
          >
            Đã xem
          </MenuItem>
        </Popover>
      )}
      {!closed && (
        <div className="diff-file-content">
          {failure ? (
            <div className="empty-small danger">{failure}</div>
          ) : !data ? (
            <div className="diff-placeholder">
              <Icon name={visible ? "loading" : "diff"} />
              {visible ? "Đang đọc diff…" : "Cuộn đến file để xem diff"}
            </div>
          ) : data.kind === "diff" ? (
            <InlineDiff data={data} display={display} />
          ) : data.kind === "large" ? (
            <div className="empty-small">
              File quá lớn để xem diff (trên 2 MB).
            </div>
          ) : (
            <div className="diff-media">
              <MediaView document={data} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
export function DiffReview({
  files,
  options,
  selected,
  onOpen,
  display,
  collapse,
  reviewed,
  onReviewed,
  onError,
}) {
  const nodes = useRef(new Map()),
    container = useRef();
  const register = (path, node) =>
    node ? nodes.current.set(path, node) : nodes.current.delete(path);
  useEffect(() => {
    const node = nodes.current.get(selected?.path);
    if (node && container.current)
      container.current.scrollTo({
        top:
          container.current.scrollTop +
          node.getBoundingClientRect().top -
          container.current.getBoundingClientRect().top,
        behavior: "instant",
      });
  }, [selected]);
  return (
    <div className="continuous-review" ref={container}>
      {files.map((file) => (
        <DiffCard
          key={JSON.stringify(options) + file.path}
          file={file}
          options={options}
          display={display}
          collapse={collapse}
          selected={selected?.path === file.path ? selected : null}
          onOpen={onOpen}
          register={register}
          reviewed={reviewed[file.path]}
          onReviewed={onReviewed}
          onError={onError}
        />
      ))}
    </div>
  );
}
