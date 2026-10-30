const { test } = require("node:test"),
  assert = require("node:assert/strict");
const projects = [
  { id: "web", name: "web-app", kind: "repository", pinned: true },
  { id: "mobile", name: "mobile-app", kind: "repository", pinned: true },
  { id: "wt-email", name: "email", kind: "worktree", parent: "web" },
  { id: "wt-idle", name: "idle", kind: "worktree", parent: "web" },
  { id: "loose", name: "preview-only", kind: "folder" },
];
const chat = (id, project, status, at, extra = {}) => ({
  id,
  project,
  status,
  title: "Chat " + id,
  path: "/p/" + project,
  last_activity_at: at,
  ...extra,
});
const sessions = [
  chat("old", "web", "stopped", "2026-10-22T07:00:00Z"),
  chat("new", "web", "stopped", "2026-10-22T09:00:00Z"),
  chat("busy", "web", "running", "2026-10-22T06:00:00Z"),
  chat("task", "wt-email", "waiting", "2026-10-22T08:00:00Z"),
  chat("gone", "removed-folder", "stopped", "2026-10-22T08:00:00Z"),
  chat("kept", "mobile", "stopped", "2026-10-22T05:00:00Z", { archived: true }),
];
test("Chats group under their project and worktree, busy first, then newest", async () => {
  const { projectTree } = await import("../src/project-tree.mjs");
  const { roots, total } = projectTree(
    { projects, sessions },
    { archived: false, search: "", selected: "web" },
  );
  assert.equal(total, 5);
  assert.deepEqual(
    roots.map((r) => r.project.id),
    ["web", "mobile", "other"],
  );
  const web = roots[0];
  assert.deepEqual(
    web.chats.map((s) => s.id),
    ["busy", "new", "old"],
  );
  assert.deepEqual(
    web.shown.map((c) => c.project.id + ":" + c.chats.map((s) => s.id)),
    ["wt-email:task"],
  );
  assert.deepEqual(
    web.hidden.map((c) => c.project.id),
    ["wt-idle"],
  );
  assert.deepEqual(roots[1].chats, []);
  assert.deepEqual(
    roots[2].chats.map((s) => s.id),
    ["gone"],
  );
});
test("Search and the archive list only projects with matching chats", async () => {
  const { projectTree, ago } = await import("../src/project-tree.mjs");
  const found = projectTree(
    { projects, sessions },
    { archived: false, search: "chat task", selected: "web" },
  );
  assert.deepEqual(
    found.roots.map((r) => [r.project.id, r.shown.length, r.hidden.length]),
    [["web", 1, 0]],
  );
  const archive = projectTree(
    { projects, sessions },
    { archived: true, search: "", selected: "web" },
  );
  assert.deepEqual(
    archive.roots.map((r) => r.project.id + ":" + r.chats.map((s) => s.id)),
    ["mobile:kept"],
  );
  const now = Date.parse("2026-10-22T10:00:00Z");
  assert.equal(ago(Date.parse("2026-10-22T09:00:00Z"), now), "1 giờ");
  assert.equal(ago(0, now), "");
});
