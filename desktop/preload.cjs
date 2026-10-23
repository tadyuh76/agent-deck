const { contextBridge, ipcRenderer } = require("electron");
const methods = new Set([
  "initialize",
  "snapshot",
  "terminalStart",
  "terminalInput",
  "terminalResize",
  "panelAction",
  "openSession",
  "switchDeck",
  "newDeck",
  "gitInfo",
  "gitCommits",
  "changes",
  "tree",
  "file",
  "save",
  "diff",
  "login",
  "chatHistory",
  "chatSend",
  "chatSendStatus",
  "chatRestoreDraft",
  "chatQueue",
  "chatEnqueue",
  "chatQueueRemove",
  "chatQueueRetry",
  "chatQueueSteer",
  "chatAgents",
  "chatModels",
  "chatApplySettings",
  "renameSession",
  "attachmentStage",
  "attachmentDrafts",
  "attachmentRemove",
  "attachmentOpen",
  "openReference",
  "sessionAction",
  "recoverTerminal",
  "refreshUsage",
  "openLocation",
  "worktreeCreate",
  "branchSwitch",
  "newConversation",
  "claudeExtensions",
  "claudePluginToggle",
]);
contextBridge.exposeInMainWorld("deck", {
  pickPath: (kind) => ipcRenderer.invoke("deck:pickPath", kind),
  browser: (action, args = {}) =>
    ipcRenderer.invoke("deck:browser", action, args),
  copy: (text) => ipcRenderer.send("deck:copy", text),
  call: (method, args = {}) => {
    if (!methods.has(method))
      return Promise.reject(new Error("Unknown action"));
    return ipcRenderer.invoke("deck:call", method, args);
  },
  window: (action) => {
    if (["minimize", "maximize", "hide", "quit", "quitKeep"].includes(action))
      ipcRenderer.send("deck:window", action);
  },
  onEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("deck:event", listener);
    return () => ipcRenderer.removeListener("deck:event", listener);
  },
});
