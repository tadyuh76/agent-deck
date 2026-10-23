const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("fs"),
  path = require("path");
const read = (name) =>
  fs.readFileSync(path.join(__dirname, "..", name), "utf8");
// Method names listed between `start` and the closing "]);" of a Set.
function listed(file, start) {
  const text = read(file),
    from = text.indexOf(start);
  return new Set(
    [...text.slice(from, text.indexOf("]);", from)).matchAll(/"(\w+)"/g)].map(
      (m) => m[1],
    ),
  );
}
test("Every backend call the window makes passes the preload and main allowlists", () => {
  const preload = listed("preload.cjs", "const methods"),
    main = listed("main.cjs", "const allowed"),
    backend = read("backend/backend.cjs"),
    used = new Set();
  for (const file of fs.readdirSync(path.join(__dirname, "../src")))
    for (const match of read("src/" + file).matchAll(
      /(?:api|deck\.call)\(\s*"(\w+)"/g,
    ))
      used.add(match[1]);
  assert(used.size > 20);
  assert.deepEqual(
    [...used].filter((m) => !preload.has(m)),
    [],
  );
  assert.deepEqual(
    [...preload].filter((m) => !main.has(m)),
    [],
  );
  assert.deepEqual(
    [...main].filter(
      (m) => !new RegExp("\\b" + m + "\\b\\s*[(:]").test(backend),
    ),
    [],
  );
});
