const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { usageSummary } = require("../backend/usage-summary.cjs");
const now = Date.parse("2026-10-22T08:00:00Z");
test("5-hour remaining quota is 100 minus used, with the actual reset countdown", () => {
  const q = usageSummary(
    {
      status: "ready",
      windows: [
        { window: "5h", used_pct: 33, resets_at: "2026-10-22T08:30:00Z" },
        { window: "7d", used_pct: 99, resets_at: "2026-10-28T08:00:00Z" },
      ],
    },
    now,
  );
  assert.equal(q.left, 67);
  assert.equal(q.remainingMs, 30 * 60000);
  assert(q.known);
  assert.equal(
    usageSummary(
      {
        status: "ready",
        windows: [
          { window: "5h", used_pct: 100, resets_at: "2026-10-22T08:30:00Z" },
        ],
      },
      now,
    ).left,
    0,
  );
});
test("Missing, expired, signed-out and invalid usage never masquerades as a full window", () => {
  assert(!usageSummary().known);
  assert(!usageSummary({ status: "signed-out" }).known);
  assert(
    !usageSummary(
      { status: "ready", windows: [{ window: "5h", used_pct: NaN }] },
      now,
    ).known,
  );
  const expired = usageSummary(
    {
      status: "ready",
      windows: [
        { window: "5h", used_pct: 100, resets_at: "2026-10-22T07:59:00Z" },
      ],
    },
    now,
  );
  assert(expired.expired);
  assert.equal(expired.left, null);
  const unused = usageSummary(
    {
      status: "ready",
      windows: [{ window: "5h", used_pct: 0, resets_at: null }],
    },
    now,
  );
  assert.equal(unused.left, 100);
  assert.equal(unused.resetsAt, null);
  const stale = usageSummary(
    {
      status: "ready",
      unavailable: true,
      windows: [
        { window: "5h", used_pct: 20, resets_at: "2026-10-22T08:30:00Z" },
      ],
    },
    now,
  );
  assert(stale.stale);
  assert.equal(stale.left, 80);
});
test("A used-up weekly limit leaves no 5-hour room, and missing data never throws", () => {
  const q = usageSummary(
    {
      status: "ready",
      windows: [
        { window: "5h", used_pct: 10, resets_at: "2026-10-22T09:00:00Z" },
        { window: "7d", used_pct: 100, resets_at: "2026-10-25T00:00:00Z" },
      ],
    },
    now,
  );
  assert.equal(q.left, 0);
  assert.equal(q.blocked, "Hết hạn mức tuần");
  assert.equal(q.resetsAt, Date.parse("2026-10-25T00:00:00Z"));
  assert.equal(usageSummary(null, now).known, false);
});
