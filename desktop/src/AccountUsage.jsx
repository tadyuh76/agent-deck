import React, { useEffect, useState } from "react";
const Icon = ({ name }) => (
  <span className={"codicon codicon-" + name} aria-hidden="true" />
);
export function countdown(milliseconds) {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return null;
  const minutes = Math.max(0, Math.ceil(milliseconds / 60000)),
    hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  return hours ? `${hours}h${rest ? ` ${rest}p` : ""}` : `${minutes}p`;
}
export function AccountUsage({ accounts = [], onRefresh, onLogin }) {
  // Snapshots only arrive when something changes; tick the countdown here.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="account-list usage-accounts">
      <div className="sidebar-heading">
        <span>TÀI KHOẢN</span>
        <button title="Làm mới hạn mức tài khoản" onClick={onRefresh}>
          <Icon name="refresh" />
        </button>
      </div>
      {accounts.map((account) => {
        const { usage, quota = {} } = account,
          ready = usage.status === "ready",
          low = quota.known && quota.left < 15;
        const reset = countdown(
            quota.resetsAt === null || quota.resetsAt === undefined
              ? null
              : Math.max(0, quota.resetsAt - now),
          ),
          percent = quota.known
            ? new Intl.NumberFormat("vi-VN", {
                maximumFractionDigits: 1,
              }).format(quota.left)
            : null;
        const clock = quota.resetsAt
          ? new Date(quota.resetsAt).toLocaleString("vi-VN", {
              timeZone: "Asia/Bangkok",
            })
          : "";
        const note = !ready
          ? usage.status === "checking"
            ? "Đang kiểm tra"
            : usage.status === "signed-out"
              ? "Đăng nhập"
              : usage.status === "mismatch"
                ? "Kiểm tra tài khoản"
                : "Chưa có dữ liệu"
          : quota.blocked
            ? quota.blocked + (reset !== null ? " · reset sau " + reset : "")
            : quota.expired
              ? "Đang cập nhật chu kỳ mới"
              : reset !== null
                ? "Reset sau " + reset
                : quota.known && quota.left === 100
                  ? "Chưa bắt đầu chu kỳ"
                  : "Chưa có giờ reset";
        return (
          <button
            className={"account-card " + (low ? "quota-low" : "")}
            key={account.slot}
            title={[
              account.email,
              usage.plan,
              clock && "Reset: " + clock,
              quota.stale && "Đang hiển thị số liệu lưu gần nhất",
              quota.updatedAt &&
                "Cập nhật: " +
                  new Date(quota.updatedAt).toLocaleTimeString("vi-VN"),
            ]
              .filter(Boolean)
              .join("\n")}
            onClick={() =>
              ready
                ? onRefresh()
                : usage.status === "signed-out" || usage.status === "mismatch"
                  ? onLogin(account.slot)
                  : onRefresh()
            }
          >
            <span className="account-card-top">
              <i
                className={
                  "status-dot " +
                  (ready
                    ? quota.known && quota.left === 0
                      ? "error"
                      : "ready"
                    : "offline")
                }
              />
              <b>{account.name}</b>
              <strong className={low ? "deleted" : "added"}>
                {quota.known
                  ? (quota.stale ? "≈ " : "") + percent + "% còn lại"
                  : ready
                    ? "—"
                    : ""}
              </strong>
            </span>
            {ready && (
              <span
                className="quota-track"
                role="progressbar"
                aria-label={"Hạn mức 5 giờ còn lại của " + account.name}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={quota.known ? quota.left : undefined}
              >
                <span style={{ width: (quota.known ? quota.left : 0) + "%" }} />
              </span>
            )}
            <span className="account-card-note">
              {ready && <span>5 giờ</span>}
              <span>{note}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
