import { diffLines, diffWordsWithSpace } from "diff";
export function reviewBlocks(original, modified, context = 3, options = {}) {
  const diff = diffLines(original, modified, {
    timeout: 250,
    maxEditLength: 20000,
    ...(options.ignoreWhitespace
      ? {
          comparator: (a, b) =>
            a.replace(/[\t \r]/g, "") === b.replace(/[\t \r]/g, ""),
        }
      : {}),
  });
  if (!diff) return null;
  let old = 1,
    next = 1,
    index = 0;
  const result = [];
  for (const part of diff) {
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const type = part.added ? "add" : part.removed ? "remove" : "context";
    const rows = lines.map((text) => ({
      id: index++,
      text,
      type,
      old: type === "add" ? null : old++,
      next: type === "remove" ? null : next++,
    }));
    if (type === "context" && rows.length > context * 2 + 2) {
      const leading = result.length ? rows.slice(0, context) : [];
      const trailing = diff.at(-1) === part ? [] : rows.slice(-context);
      if (leading.length) result.push({ rows: leading });
      result.push({
        id: "fold-" + rows[0].id,
        folded: true,
        rows: rows.slice(leading.length, rows.length - trailing.length),
      });
      if (trailing.length) result.push({ rows: trailing });
    } else result.push({ rows });
  }
  if (options.words !== false) {
    const rows = result.flatMap((b) => b.rows);
    let pairs = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].type !== "remove") continue;
      const removed = [],
        added = [];
      while (rows[i]?.type === "remove") removed.push(rows[i++]);
      while (rows[i]?.type === "add") added.push(rows[i++]);
      i--;
      for (
        let j = 0;
        j < Math.min(removed.length, added.length) && pairs++ < 1000;
        j++
      ) {
        if (removed[j].text.length + added[j].text.length > 4000) continue;
        const words = diffWordsWithSpace(removed[j].text, added[j].text, {
          timeout: 10,
          maxEditLength: 1000,
        });
        if (!words) continue;
        removed[j].words = words
          .filter((w) => !w.added)
          .map((w) => ({ text: w.value, changed: !!w.removed }));
        added[j].words = words
          .filter((w) => !w.removed)
          .map((w) => ({ text: w.value, changed: !!w.added }));
      }
    }
  }
  return result;
}
export function splitRows(rows) {
  const pairs = [];
  for (let i = 0; i < rows.length; ) {
    if (rows[i].type === "context") {
      pairs.push({ left: rows[i], right: rows[i++] });
      continue;
    }
    const removed = [],
      added = [];
    while (rows[i]?.type === "remove") removed.push(rows[i++]);
    while (rows[i]?.type === "add") added.push(rows[i++]);
    for (let j = 0; j < Math.max(removed.length, added.length); j++)
      pairs.push({ left: removed[j], right: added[j] });
  }
  return pairs;
}
export function fileGroups(files, { folders = false, separate = false } = {}) {
  const groups = new Map();
  for (const file of files) {
    const category = !separate
      ? ""
      : /(^|\/)(__tests__|tests?|e2e)(\/|$)|\.(test|spec)\./i.test(file.path)
        ? "Tests"
        : /(^|\/)(dist|build|generated|coverage)(\/|$)|\.generated\.|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(
              file.path,
            )
          ? "Build & generated"
          : "Source";
    const folder = folders
      ? file.path.split("/").slice(0, -1).join("/") || "."
      : "";
    const label = [category, folder].filter(Boolean).join(" / ");
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(file);
  }
  return [...groups].map(([label, files]) => ({ label, files }));
}
