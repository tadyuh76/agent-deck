// Groups the snapshot's chats under their project (and worktree) for the
// sidebar tree. Kept free of React so it can be tested with node --test.
export const activity = (session) => Date.parse(session.last_activity_at) || 0;
const STATUS_RANK = { running: 0, waiting: 1, idle: 2 };
// Order of chats inside one project. A session that is working or waiting
// for an answer is what an operator of six agents looks for first; after
// that, the most recently active chat comes first, as in Codex and Claude.
export function sessionOrder(a, b) {
  const rank = (s) => STATUS_RANK[s.status] ?? 3;
  return rank(a) - rank(b) || activity(b) - activity(a);
}
export function ago(time, now = Date.now()) {
  if (!time) return "";
  const minutes = Math.floor((now - time) / 60000);
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return minutes + " phút";
  if (minutes < 1440) return Math.floor(minutes / 60) + " giờ";
  return Math.floor(minutes / 1440) + " ngày";
}
// Builds project → worktree → chat groups from the backend snapshot.
export function projectTree(state, { archived, search, selected }) {
  const query = search.trim().toLowerCase();
  const sessions = (state?.sessions || []).filter(
    (s) =>
      !!s.archived === archived &&
      (!query || (s.title + " " + s.path).toLowerCase().includes(query)),
  );
  const projects = state?.projects || [],
    known = new Set(projects.map((p) => p.id)),
    chats = new Map();
  for (const s of sessions) {
    const key = known.has(s.project) ? s.project : "other";
    if (!chats.has(key)) chats.set(key, []);
    chats.get(key).push(s);
  }
  for (const list of chats.values()) list.sort(sessionOrder);
  const node = (project) => ({ project, chats: chats.get(project.id) || [] });
  const roots = projects
    .filter((p) => !p.parent || !known.has(p.parent))
    .map((p) => {
      const children = projects.filter((c) => c.parent === p.id).map(node),
        // Worktrees with chats, or the one being reviewed, are listed;
        // the rest wait behind a single "other worktrees" row.
        shown = children.filter(
          (c) => c.chats.length || c.project.id === selected,
        );
      return {
        ...node(p),
        shown,
        hidden: query ? [] : children.filter((c) => !shown.includes(c)),
      };
    })
    .filter(
      (root) =>
        root.chats.length ||
        root.shown.length ||
        // Empty projects stay visible like Codex's "No chats", except in
        // search results and the archive.
        (!query &&
          !archived &&
          (root.project.pinned || root.project.id === selected)),
    );
  if (chats.has("other"))
    roots.push({
      project: { id: "other", name: "Thư mục khác", kind: "folder" },
      chats: chats.get("other"),
      shown: [],
      hidden: [],
    });
  return { roots, total: sessions.length };
}
