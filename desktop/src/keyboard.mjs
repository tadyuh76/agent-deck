export function isTerminalUndo(event) {
  return (
    event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    (event.code === "KeyZ" || event.key?.toLowerCase() === "z")
  );
}
