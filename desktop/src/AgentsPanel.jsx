import React, { useEffect, useState } from "react";
import { poller } from "./polling.mjs";
const api = (method, args) => window.deck.call(method, args);
const Icon = ({ name }) => (
  <span className={"codicon codicon-" + name} aria-hidden="true" />
);
const STATUS = {
  running: { label: "Đang chạy", icon: "loading" },
  completed: { label: "Xong", icon: "pass" },
  failed: { label: "Lỗi", icon: "error" },
  killed: { label: "Đã dừng", icon: "circle-slash" },
  ended: { label: "Không còn chạy", icon: "circle-outline" },
};
function since(time, now) {
  const at = Date.parse(time);
  if (!at) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return seconds + " giây";
  if (seconds < 3600) return Math.floor(seconds / 60) + " phút";
  return (
    Math.floor(seconds / 3600) +
    " giờ " +
    (Math.floor(seconds / 60) % 60) +
    " phút"
  );
}
function duration(item, now) {
  const end = Date.parse(item.endedAt) || (item.status === "running" ? now : 0);
  return item.startedAt && end ? since(item.startedAt, end) : "";
}
function AgentCard({ agent, now }) {
  const [open, setOpen] = useState(agent.status === "running");
  const status = STATUS[agent.status] || STATUS.ended,
    activity = agent.activity || {},
    last = activity.recent?.at(-1);
  return (
    <article className={"agent-card " + agent.status}>
      <button className="agent-card-head" onClick={() => setOpen(!open)}>
        <Icon name={status.icon} />
        <span className="agent-title">
          <b>{agent.title}</b>
          <small>
            {agent.type}
            {agent.background ? " · chạy nền" : " · trực tiếp"}
            {agent.nested ? " · do agent con giao" : ""}
            {duration(agent, now) && " · " + duration(agent, now)}
          </small>
        </span>
        <span className={"agent-status " + agent.status}>{status.label}</span>
      </button>
      {agent.status === "running" && last && (
        <p className="agent-now">
          <Icon name="debug-stackframe" />
          <b>{last.name}</b> {last.summary}
          <small> · {since(last.at, now)} trước</small>
        </p>
      )}
      <p className="agent-metrics">
        {activity.tools || 0} lần gọi tool
        {activity.tokens
          ? " · " + activity.tokens.toLocaleString("vi-VN") + " token"
          : ""}
        {activity.lastAt
          ? " · hoạt động " + since(activity.lastAt, now) + " trước"
          : ""}
      </p>
      {open && (
        <div className="agent-detail">
          {agent.prompt && (
            <details>
              <summary>Nhiệm vụ được giao</summary>
              <pre>{agent.prompt}</pre>
            </details>
          )}
          {activity.recent?.length > 0 && (
            <ol className="agent-steps">
              {activity.recent
                .slice()
                .reverse()
                .map((step, index) => (
                  <li key={index}>
                    <b>{step.name}</b> {step.summary}
                    <small> · {since(step.at, now)} trước</small>
                  </li>
                ))}
            </ol>
          )}
          {(agent.result || agent.summary || activity.lastText) && (
            <details open={agent.status !== "running"}>
              <summary>
                {agent.status === "running" ? "Đang viết" : "Kết quả"}
              </summary>
              <pre>{agent.result || agent.summary || activity.lastText}</pre>
            </details>
          )}
        </div>
      )}
    </article>
  );
}
// Sub-agents and background shells of the conversation in the selected
// terminal: who is working, on what, and what each was asked to do.
export default function AgentsPanel({ panel, onError }) {
  const id = panel?.view === "chat" ? panel.chatId : null,
    slot = panel?.slot;
  const [data, setData] = useState(null),
    [now, setNow] = useState(Date.now());
  useEffect(() => {
    setData(null);
    if (!id) return;
    let alive = true;
    const load = () =>
      api("chatAgents", { slot, id })
        .then((next) => {
          if (alive) {
            setData(next);
            setNow(Date.now());
          }
        })
        .catch((error) => alive && onError(error));
    load();
    const stop = poller(load, 2000);
    return () => {
      alive = false;
      stop();
    };
  }, [id, slot]);
  if (!id)
    return (
      <div className="browser-empty">
        <Icon name="organization" />
        <strong>Chưa có hội thoại ở terminal {slot}</strong>
        <p>Chọn một terminal đang chạy Claude để xem agent con của nó.</p>
      </div>
    );
  if (!data) return <div className="browser-empty">Đang đọc hoạt động…</div>;
  const running = data.agents.filter((a) => a.status === "running"),
    shells = data.shells;
  return (
    <div className="agents-panel">
      <div className="agents-summary">
        <span className="slot-number">{slot}</span>
        <div>
          <strong>{panel.session?.title || "Hội thoại Claude"}</strong>
          <small>
            {running.length} agent con đang chạy · {data.agents.length} tổng
            cộng
            {shells.length
              ? " · " +
                shells.filter((s) => s.status === "running").length +
                " shell nền đang chạy"
              : ""}
          </small>
        </div>
      </div>
      <div className="agents-list">
        {data.agents.length === 0 && (
          <p className="empty-small">
            Hội thoại này chưa giao việc cho agent con nào.
          </p>
        )}
        {data.agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} now={now} />
        ))}
        {shells.length > 0 && (
          <>
            <h3 className="agents-heading">Tác vụ nền</h3>
            {shells.map((shell) => {
              const status = STATUS[shell.status] || STATUS.ended;
              return (
                <div className={"shell-row " + shell.status} key={shell.id}>
                  <Icon name={status.icon} />
                  <span title={shell.command}>
                    <b>{shell.title}</b>
                    <small>
                      {shell.tool} · {status.label}
                      {duration(shell, now) && " · " + duration(shell, now)}
                    </small>
                  </span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
