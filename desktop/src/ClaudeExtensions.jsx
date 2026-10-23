import React, { useEffect, useMemo, useRef, useState } from "react";
const api = (method, args) => window.deck.call(method, args);
const Icon = ({ name }) => (
  <span className={"codicon codicon-" + name} aria-hidden="true" />
);
const KIND_ICON = {
  builtin: "terminal",
  skill: "sparkle",
  command: "symbol-event",
};
const match = (item, query) =>
  (item.name + " " + item.description + " " + (item.source || ""))
    .toLowerCase()
    .includes(query.toLowerCase());
// The account's skills, commands and plugins, loaded once per chat.
export function useExtensions(slot, id) {
  const [data, setData] = useState(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    current = useRef(id),
    asked = useRef(null);
  current.current = id;
  useEffect(() => {
    setData(null);
    setError("");
    asked.current = null;
  }, [id, slot]);
  function load(force = false) {
    if (!id || (!force && asked.current)) return asked.current;
    const target = id;
    setLoading(true);
    setError("");
    asked.current = api("claudeExtensions", { slot, id })
      .then((next) => {
        if (current.current === target) setData(next);
        return next;
      })
      .catch((e) => {
        asked.current = null;
        if (current.current === target) setError(e.message);
      })
      .finally(() => {
        if (current.current === target) setLoading(false);
      });
    return asked.current;
  }
  return { data, setData, loading, error, load };
}
// "/na" at the start of the draft: the commands and skills it could be.
export function slashQuery(draft) {
  const m = /^\/([\w:.-]*)$/.exec(draft);
  return m ? m[1] : null;
}
export function slashMatches(data, query) {
  if (!data || query === null) return [];
  const q = query.toLowerCase(),
    seen = new Set();
  return data.all
    .filter((item) => {
      if (seen.has(item.name)) return false;
      seen.add(item.name);
      const name = item.name.toLowerCase();
      return !q || name.includes(q) || name.split(":").pop().startsWith(q);
    })
    .sort((a, b) => {
      const rank = (i) => {
        const name = i.name.toLowerCase();
        return name.startsWith(q)
          ? 0
          : name.split(":").pop().startsWith(q)
            ? 1
            : 2;
      };
      return rank(a) - rank(b);
    })
    .slice(0, 50);
}
export function SlashMenu({ items, active, loading, error, onPick, onHover }) {
  const list = useRef();
  useEffect(() => {
    list.current
      ?.querySelector("[aria-selected=true]")
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <div
      className="slash-menu"
      role="listbox"
      ref={list}
      aria-label="Lệnh và skill"
    >
      {loading && !items.length ? (
        <p className="slash-empty">Đang tải skill và plugin…</p>
      ) : error ? (
        <p className="slash-empty">{error}</p>
      ) : !items.length ? (
        <p className="slash-empty">Không có lệnh phù hợp</p>
      ) : (
        items.map((item, i) => (
          <button
            key={item.kind + item.name}
            role="option"
            aria-selected={i === active}
            className={i === active ? "active" : ""}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(item);
            }}
            onMouseEnter={() => onHover(i)}
          >
            <Icon name={KIND_ICON[item.kind] || "symbol-event"} />
            <strong>/{item.name}</strong>
            {item.hint && <em>{item.hint}</em>}
            <span>{item.description}</span>
            <small>{item.source}</small>
          </button>
        ))
      )}
    </div>
  );
}
function Row({ item, onUse }) {
  return (
    <li>
      <button
        className="extension-use"
        title={"Chèn /" + item.name}
        onClick={() => onUse(item)}
      >
        <Icon name={KIND_ICON[item.kind] || "symbol-event"} />
        <span>
          <strong>/{item.name}</strong>
          {item.hint && <em> {item.hint}</em>}
          <small>{item.description}</small>
        </span>
        <code>{item.source}</code>
      </button>
    </li>
  );
}
function PluginRow({ plugin, busy, onToggle, onUse }) {
  const [open, setOpen] = useState(false),
    parts = [
      plugin.skills.length && plugin.skills.length + " skill",
      plugin.commands.length && plugin.commands.length + " lệnh",
      plugin.agents.length && plugin.agents.length + " agent",
      plugin.mcp.length && "MCP " + plugin.mcp.join(", "),
      plugin.lsp && "LSP",
      plugin.hooks && "hooks",
    ].filter(Boolean);
  return (
    <li className={"plugin-row" + (plugin.enabled ? "" : " disabled")}>
      <div className="plugin-head">
        <button
          className="plugin-expand"
          aria-expanded={open}
          title={open ? "Thu gọn" : "Xem skill và lệnh"}
          disabled={!plugin.skills.length && !plugin.commands.length}
          onClick={() => setOpen(!open)}
        >
          <Icon name={open ? "chevron-down" : "chevron-right"} />
        </button>
        <span>
          <strong>{plugin.name}</strong>
          <code>{plugin.version}</code>
          <small>{plugin.description}</small>
          <small className="plugin-parts">{parts.join(" · ") || "—"}</small>
        </span>
        <label
          className="plugin-toggle"
          title={plugin.enabled ? "Tắt plugin" : "Bật plugin"}
        >
          <input
            type="checkbox"
            checked={plugin.enabled}
            disabled={busy}
            onChange={(e) => onToggle(plugin, e.target.checked)}
          />
          {busy ? <Icon name="loading" /> : plugin.enabled ? "Bật" : "Tắt"}
        </label>
      </div>
      {open && (
        <ul className="extension-list nested">
          {[...plugin.skills, ...plugin.commands].map((item) => (
            <Row key={item.kind + item.name} item={item} onUse={onUse} />
          ))}
        </ul>
      )}
    </li>
  );
}
export function ExtensionsDialog({
  slot,
  id,
  extensions,
  onUse,
  onClose,
  onError,
}) {
  const [tab, setTab] = useState("skills"),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(""),
    { data, setData, loading, error, load } = extensions;
  useEffect(() => {
    load();
    const key = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const lists = useMemo(() => {
    if (!data) return { skills: [], commands: [], plugins: [] };
    const enabled = data.plugins.filter((p) => p.enabled);
    return {
      skills: [...data.skills, ...enabled.flatMap((p) => p.skills)],
      commands: [
        ...data.builtin,
        ...data.commands,
        ...enabled.flatMap((p) => p.commands),
      ],
      plugins: data.plugins,
    };
  }, [data]);
  async function toggle(plugin, enabled) {
    setBusy(plugin.id);
    setNotice("");
    try {
      const next = await api("claudePluginToggle", {
        slot,
        id,
        plugin: plugin.id,
        enabled,
      });
      setData((old) => ({
        ...old,
        plugins: old.plugins.map((p) =>
          p.id === plugin.id ? { ...p, ...next } : p,
        ),
      }));
      setNotice("Áp dụng cho hội thoại mới · gõ /reload-plugins để dùng ngay");
    } catch (e) {
      onError(e);
    } finally {
      setBusy("");
    }
  }
  const shown =
    tab === "plugins"
      ? lists.plugins.filter(
          (p) =>
            !query ||
            match(
              {
                ...p,
                source: p.skills
                  .concat(p.commands)
                  .map((i) => i.name)
                  .join(" "),
              },
              query,
            ),
        )
      : lists[tab].filter((item) => !query || match(item, query));
  const TABS = [
    ["skills", "Skills", lists.skills.length],
    ["commands", "Lệnh", lists.commands.length],
    [
      "plugins",
      "Plugins",
      lists.plugins.filter((p) => p.enabled).length +
        "/" +
        lists.plugins.length,
    ],
  ];
  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="extensions-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Skills và plugins"
      >
        <header>
          <strong>
            Skills & plugins
            {data && <small> · tài khoản {data.account}</small>}
          </strong>
          <button title="Tải lại" disabled={loading} onClick={() => load(true)}>
            <Icon name={loading ? "loading" : "refresh"} />
          </button>
          <button autoFocus title="Đóng" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <nav role="tablist">
          {TABS.map(([value, label, count]) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? "active" : ""}
              onClick={() => setTab(value)}
            >
              {label} <small>{count}</small>
            </button>
          ))}
          <input
            type="search"
            placeholder="Tìm…"
            aria-label="Tìm skill, lệnh hoặc plugin"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </nav>
        {error ? (
          <p className="extensions-empty">{error}</p>
        ) : !data ? (
          <p className="extensions-empty">Đang tải…</p>
        ) : !shown.length ? (
          <p className="extensions-empty">Không có kết quả</p>
        ) : (
          <ul className="extension-list">
            {tab === "plugins"
              ? shown.map((plugin) => (
                  <PluginRow
                    key={plugin.id}
                    plugin={plugin}
                    busy={busy === plugin.id}
                    onToggle={toggle}
                    onUse={onUse}
                  />
                ))
              : shown.map((item) => (
                  <Row
                    key={item.kind + item.name + item.source}
                    item={item}
                    onUse={onUse}
                  />
                ))}
          </ul>
        )}
        <footer>
          {notice ||
            (tab === "plugins"
              ? "Plugin cài cho tài khoản này · thêm plugin: node ~/.config/agent-deck/claude-skills.js install"
              : "Chọn để chèn vào ô chat · Claude cũng tự dùng skill khi phù hợp")}
        </footer>
      </section>
    </div>
  );
}
