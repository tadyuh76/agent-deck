import React, { useEffect, useRef, useState } from "react";
import { poller } from "./polling.mjs";
const Icon = ({ name }) => (
  <span className={"codicon codicon-" + name} aria-hidden="true" />
);
const browser = (action, args) => window.deck.browser(action, args);
const modifiers = (e) =>
  ["alt", "ctrl", "meta", "shift"].filter((name) => e[name + "Key"]);
const BUTTONS = ["left", "middle", "right"];
// Live view of Agent Deck's browser: the same pages the agents drive through
// Playwright MCP. Input on the picture is replayed on the page.
export default function BrowserPanel({ onError }) {
  const [status, setStatus] = useState(null),
    [selected, setSelected] = useState(null),
    [frame, setFrame] = useState(null),
    [address, setAddress] = useState(""),
    [editing, setEditing] = useState(false),
    [starting, setStarting] = useState(false);
  const picture = useRef(),
    stage = useRef(),
    keys = useRef(),
    metadata = useRef(null),
    composing = useRef(false),
    moving = useRef(null);
  async function refresh() {
    try {
      const next = await browser("status");
      setStatus(next);
      setSelected((old) =>
        next.pages.some((p) => p.id === old) ? old : next.pages[0]?.id || null,
      );
    } catch (error) {
      setStatus({ running: false, pages: [], error: error.message });
    }
  }
  useEffect(() => {
    refresh();
    const stop = poller(refresh, 2000);
    const off = window.deck.onEvent((event) => {
      if (event.type === "browser-frame") {
        metadata.current = event.metadata;
        setFrame("data:image/jpeg;base64," + event.data);
      }
      if (event.type === "browser-navigated") setAddress(event.url);
      if (event.type === "browser-closed") refresh();
    });
    return () => {
      stop();
      off();
      browser("stop").catch(() => {});
    };
  }, []);
  useEffect(() => {
    setFrame(null);
    if (!selected) return;
    const box = stage.current?.getBoundingClientRect();
    browser("watch", {
      id: selected,
      width: box?.width * devicePixelRatio,
      height: box?.height * devicePixelRatio,
    })
      .then((page) => setAddress(page.url))
      .catch(onError);
  }, [selected]);
  const page = status?.pages.find((p) => p.id === selected);
  useEffect(() => {
    if (!editing && page) setAddress(page.url);
  }, [page?.url]);
  // Picture coordinates → page CSS pixels.
  function point(e) {
    const rect = picture.current.getBoundingClientRect(),
      meta = metadata.current || {};
    const scale = (meta.deviceWidth || rect.width) / rect.width;
    return {
      x: Math.round((e.clientX - rect.left) * scale),
      y: Math.round((e.clientY - rect.top) * scale),
    };
  }
  const send = (event) => browser("input", event).catch(() => {});
  const mouse = (type) => (e) => {
    if (type !== "mouseMoved") e.preventDefault();
    // Keys go to a hidden text field so IME input (Vietnamese) composes.
    if (type === "mousePressed") keys.current?.focus();
    const event = {
      kind: "mouse",
      type,
      ...point(e),
      button: type === "mouseMoved" ? "none" : BUTTONS[e.button] || "left",
      buttons: e.buttons,
      clickCount: type === "mouseMoved" ? 0 : e.detail || 1,
      modifiers: modifiers(e),
    };
    if (type !== "mouseMoved") return send(event);
    // One move per frame is enough for hover effects.
    if (!moving.current)
      requestAnimationFrame(() => {
        send(moving.current);
        moving.current = null;
      });
    moving.current = event;
  };
  function key(type) {
    return (e) => {
      if (composing.current || e.key === "Process") return;
      e.preventDefault();
      const printable =
        e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
      send({
        kind: "key",
        type:
          type === "keyDown" && printable
            ? "keyDown"
            : type === "keyDown"
              ? "rawKeyDown"
              : "keyUp",
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        text:
          type === "keyDown" && printable
            ? e.key
            : e.key === "Enter" && type === "keyDown"
              ? "\r"
              : undefined,
        modifiers: modifiers(e),
      });
    };
  }
  async function launch() {
    setStarting(true);
    try {
      await browser("launch");
      await refresh();
    } catch (error) {
      onError(error);
    } finally {
      setStarting(false);
    }
  }
  if (!status)
    return <div className="browser-empty">Đang kiểm tra trình duyệt…</div>;
  if (!status.running)
    return (
      <div className="browser-empty">
        <Icon name="globe" />
        <strong>Trình duyệt của Agent Deck chưa mở</strong>
        <p>
          Agent tự mở trình duyệt khi cần dùng web. Bạn cũng có thể mở trước để
          xem và thao tác cùng agent.
        </p>
        <button className="save-rename" disabled={starting} onClick={launch}>
          {starting ? "Đang mở…" : "Mở trình duyệt"}
        </button>
      </div>
    );
  return (
    <div className="browser-panel">
      <div className="browser-toolbar">
        <select
          aria-label="Tab trình duyệt"
          value={selected || ""}
          onChange={(e) => setSelected(e.target.value)}
        >
          {status.pages.map((p) => (
            <option key={p.id} value={p.id}>
              {(p.title || p.url || "Tab trống").slice(0, 60)}
            </option>
          ))}
        </select>
        <button
          title="Trang trước"
          onClick={() => browser("back").catch(onError)}
        >
          <Icon name="arrow-left" />
        </button>
        <button
          title="Trang sau"
          onClick={() => browser("forward").catch(onError)}
        >
          <Icon name="arrow-right" />
        </button>
        <button
          title="Tải lại"
          onClick={() => browser("reload").catch(onError)}
        >
          <Icon name="refresh" />
        </button>
        <form
          className="browser-address"
          onSubmit={(e) => {
            e.preventDefault();
            setEditing(false);
            browser("navigate", { url: address }).catch(onError);
          }}
        >
          <input
            aria-label="Địa chỉ"
            value={address}
            onFocus={(e) => {
              setEditing(true);
              e.target.select();
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Nhập địa chỉ hoặc từ khóa"
          />
        </form>
        <button
          title="Tab mới"
          onClick={() =>
            browser("newTab")
              .then(async (id) => {
                await refresh();
                setSelected(id);
              })
              .catch(onError)
          }
        >
          <Icon name="add" />
        </button>
        <button
          title="Đưa tab này lên trong cửa sổ Chrome"
          onClick={() => browser("front").catch(onError)}
        >
          <Icon name="link-external" />
        </button>
      </div>
      <div className="browser-stage" ref={stage}>
        {frame ? (
          <img
            ref={picture}
            className="browser-frame"
            src={frame}
            alt={page?.title || "Trang web"}
            draggable={false}
            onMouseDown={mouse("mousePressed")}
            onMouseUp={mouse("mouseReleased")}
            onMouseMove={mouse("mouseMoved")}
            onContextMenu={(e) => e.preventDefault()}
            onWheel={(e) =>
              send({
                kind: "mouse",
                type: "mouseWheel",
                ...point(e),
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                modifiers: modifiers(e),
              })
            }
          />
        ) : (
          <div className="browser-empty">
            {selected ? "Đang tải hình trang…" : "Chưa có tab nào."}
          </div>
        )}
        <textarea
          ref={keys}
          className="browser-keys"
          aria-label="Gõ vào trang web"
          onKeyDown={key("keyDown")}
          onKeyUp={key("keyUp")}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={(e) => {
            composing.current = false;
            if (e.data) send({ kind: "text", text: e.data });
            e.target.value = "";
          }}
          onInput={(e) => {
            if (!composing.current) e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
