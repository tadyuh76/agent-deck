const { test } = require("node:test"),
  assert = require("node:assert/strict");
const { Scrollback, OutputBatcher } = require("../backend/terminal-output.cjs");
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Scrollback keeps exactly the last characters, like the old string slice", () => {
  const history = new Scrollback(10);
  let reference = "";
  for (const part of ["abc", "defgh", "ijklmnop", "q", "rstuvwxyz0123"]) {
    history.push(part);
    reference = (reference + part).slice(-10);
  }
  assert.equal(history.text(), reference);
  assert.ok(history.size <= 15);
  history.push("!");
  assert.equal(history.text(), (reference + "!").slice(-10));
});

test("Output of one terminal is sent as one event, in order, per slot", async () => {
  const sent = [],
    batch = new OutputBatcher((slot, data) => sent.push([slot, data]), 5);
  batch.push(1, "a");
  batch.push(2, "x");
  batch.push(1, "b");
  assert.deepEqual(sent, []);
  await tick(15);
  assert.deepEqual(sent, [
    [1, "ab"],
    [2, "x"],
  ]);
});

test("Flushing one terminal sends it at once; dropping forgets it", async () => {
  const sent = [],
    batch = new OutputBatcher((slot, data) => sent.push([slot, data]), 5);
  batch.push(1, "exit soon");
  batch.push(2, "reopened");
  batch.flush(1);
  assert.deepEqual(sent, [[1, "exit soon"]]);
  batch.drop(2);
  await tick(15);
  assert.deepEqual(sent, [[1, "exit soon"]]);
  assert.equal(batch.timer, null);
});

function fakeDocument(state = "visible") {
  const listeners = new Set();
  return {
    visibilityState: state,
    addEventListener: (_, fn) => listeners.add(fn),
    removeEventListener: (_, fn) => listeners.delete(fn),
    show() {
      this.visibilityState = "visible";
      for (const fn of listeners) fn();
    },
    hide() {
      this.visibilityState = "hidden";
      for (const fn of listeners) fn();
    },
    listeners,
  };
}

test("Polls pause while the window is hidden and refresh once it shows", async () => {
  const { poller } = await import("../src/polling.mjs");
  const doc = fakeDocument();
  let runs = 0;
  const stop = poller(() => runs++, 10, { doc });
  await tick(35);
  const visible = runs;
  assert.ok(visible >= 2, "polls while visible");
  doc.hide();
  await tick(40);
  assert.equal(runs, visible, "no polls while hidden");
  doc.show();
  assert.equal(runs, visible + 1, "refreshes as soon as it shows");
  stop();
  await tick(30);
  assert.equal(runs, visible + 1, "stopped");
  assert.equal(doc.listeners.size, 0);
});

test("A slow poll is never started twice at once", async () => {
  const { poller } = await import("../src/polling.mjs");
  const doc = fakeDocument();
  let active = 0,
    most = 0,
    runs = 0;
  const stop = poller(
    async () => {
      runs++;
      most = Math.max(most, ++active);
      await tick(30);
      active--;
    },
    5,
    { doc, immediate: true },
  );
  doc.show();
  await tick(80);
  stop();
  assert.equal(most, 1);
  assert.ok(runs >= 2);
});
