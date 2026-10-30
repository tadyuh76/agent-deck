// Repeats `task` every `ms` while the window is on screen. A hidden or
// minimized window pauses (Electron only slows timers, so polls would keep
// starting git and WSL work behind the tray); showing it again refreshes at
// once. The next run is scheduled after the previous one ends, so slow calls
// never pile up. Returns a function that stops it.
// Polls return fresh objects; keeping the old one when nothing changed spares
// React a re-render.
export const same = (a, b) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);
export function poller(
  task,
  ms,
  { immediate = false, doc = globalThis.document } = {},
) {
  let timer = null,
    running = false,
    stopped = false;
  const hidden = () => doc?.visibilityState === "hidden";
  function schedule() {
    if (!stopped && !timer && !hidden()) timer = setTimeout(tick, ms);
  }
  async function tick() {
    timer = null;
    if (stopped || running || hidden()) return;
    running = true;
    try {
      await task();
    } catch {
    } finally {
      running = false;
    }
    schedule();
  }
  function wake() {
    if (hidden() || stopped) return;
    clearTimeout(timer);
    timer = null;
    tick();
  }
  doc?.addEventListener("visibilitychange", wake);
  if (immediate) tick();
  else schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    doc?.removeEventListener("visibilitychange", wake);
  };
}
