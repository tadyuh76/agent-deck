import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
export const Icon = ({ name }) => (
  <span className={"codicon codicon-" + name} aria-hidden="true" />
);
export function FileIcon({ path, binary }) {
  const name = path.split("/").pop(),
    ext = name.split(".").pop().toLowerCase();
  const type = name.startsWith(".git")
    ? "git"
    : /^(png|jpg|jpeg|gif|webp|bmp|svg|ico)$/.test(ext) || binary
      ? "media"
      : /^(tsx|jsx)$/.test(ext)
        ? "react"
        : /^(ts|js|mjs|cjs)$/.test(ext)
          ? ext.endsWith("js")
            ? "js"
            : "ts"
          : /^(md|mdx)$/.test(ext)
            ? "markdown"
            : /^(json|ya?ml)$/.test(ext)
              ? "json"
              : /^(sql|db|prisma)$/.test(ext)
                ? "database"
                : "code";
  const glyph = {
    git: "git-commit",
    media: "file-media",
    react: "symbol-namespace",
    js: "symbol-method",
    ts: "symbol-method",
    markdown: "markdown",
    json: "symbol-structure",
    database: "database",
    code: "file-code",
  }[type];
  return (
    <span className={"review-file-icon " + type}>
      <Icon name={glyph} />
    </span>
  );
}
export function Counts({ file }) {
  return file.binary ? (
    <span className="diff-binary-label">Binary</span>
  ) : file.large ? (
    <span className="diff-binary-label" title="File trên 2 MB">
      &gt;2 MB
    </span>
  ) : (
    <span className="line-counts">
      <span className="added">+{file.added || 0}</span>
      <span className="deleted">−{file.removed || 0}</span>
    </span>
  );
}
export function Popover({ anchor, children, onClose, className = "" }) {
  const ref = useRef(),
    [position, setPosition] = useState({ top: -10000, left: 0 });
  useLayoutEffect(() => {
    const rect = anchor?.getBoundingClientRect?.() || anchor;
    if (!rect || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8)),
      top:
        rect.bottom + box.height < window.innerHeight - 8
          ? rect.bottom + 4
          : Math.max(8, rect.top - box.height - 4),
    });
  }, [anchor, children]);
  useEffect(() => {
    const close = (e) => {
      if (!ref.current?.contains(e.target) && !anchor?.contains?.(e.target))
        onClose();
    };
    const key = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchor?.focus?.();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div
      ref={ref}
      className={"review-popover " + className}
      style={position}
      onKeyDown={(event) => {
        if (
          !["ArrowDown", "ArrowUp"].includes(event.key) ||
          event.target.tagName === "INPUT"
        )
          return;
        const buttons = [
            ...ref.current.querySelectorAll("button:not(:disabled)"),
          ],
          index = buttons.indexOf(document.activeElement);
        buttons[
          (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length
        ]?.focus();
        event.preventDefault();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
export function MenuItem({
  children,
  checked,
  onClick,
  shortcut,
  arrow,
  disabled,
}) {
  return (
    <button
      className="review-menu-item"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      onClick={onClick}
      disabled={disabled}
    >
      <span>{children}</span>
      {shortcut && <small>{shortcut}</small>}
      {checked && <Icon name="check" />}
      {arrow && <Icon name="chevron-right" />}
    </button>
  );
}
export function relativeTime(date) {
  const seconds = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return "vừa xong";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  if (seconds < 2592000) return Math.floor(seconds / 86400) + "d ago";
  return new Date(date).toLocaleDateString("vi-VN");
}
