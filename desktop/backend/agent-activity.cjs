const fs = require("fs/promises"),
  path = require("path");
// Sub-agents and background shells of one Claude session, read from its
// transcript: Agent tool calls give the assignment, subagents/agent-*.json(l)
// give live progress, and <task-notification> rows give the outcome.
const clip = (value, max) => {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max) + "…" : text;
};
const text = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((b) => (b.type === "text" ? b.text : "")).join("\n")
      : "";
const tag = (body, name) =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim();
function toolSummary(block) {
  const input = block.input || {};
  return clip(
    input.description ||
      input.file_path ||
      input.path ||
      input.command ||
      input.pattern ||
      input.url ||
      input.query ||
      "",
    160,
  );
}
// Appends new lines of a JSONL file to `state` and calls `row` for each.
async function follow(file, state, row) {
  const stat = await fs.stat(file);
  if (stat.size < state.offset || stat.ino !== state.ino) {
    Object.assign(state, { offset: 0, rest: "", ino: stat.ino });
    state.reset?.();
  }
  if (stat.size === state.offset) return stat;
  const handle = await fs.open(file, "r");
  try {
    const length = stat.size - state.offset,
      buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, state.offset);
    state.offset = stat.size;
    const lines = (state.rest + buffer.toString("utf8")).split("\n");
    state.rest = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      try {
        row(JSON.parse(line));
      } catch {}
    }
  } finally {
    await handle.close();
  }
  return stat;
}
class Transcript {
  constructor() {
    this.state = { offset: 0, rest: "", reset: () => this.clear() };
    this.clear();
  }
  clear() {
    this.agents = new Map();
    this.shells = new Map();
    this.pendingShells = new Map();
    this.stops = new Map();
  }
  notification(body, at) {
    const id = tag(body, "task-id"),
      use = tag(body, "tool-use-id"),
      status = tag(body, "status"),
      summary = tag(body, "summary");
    if (!id || !status) return;
    const item =
      (use && this.agents.get(use)) ||
      [...this.agents.values()].find((a) => a.agentId === id) ||
      this.shells.get(id);
    if (item) Object.assign(item, { status, endedAt: at, summary });
  }
  row(r) {
    if (r.isSidechain) return;
    const at = r.timestamp,
      content = r.message?.content;
    if (r.type === "attachment" && r.attachment?.type === "queued_command")
      return this.notification(r.attachment.prompt || "", at);
    if (r.type === "user" && typeof content === "string")
      return this.notification(content, at);
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b.type === "tool_use" && (b.name === "Agent" || b.name === "Task"))
        this.agents.set(b.id, {
          id: b.id,
          title: clip(b.input?.description || "Agent con", 120),
          type: b.input?.subagent_type || "general-purpose",
          model: b.input?.model,
          background: !!b.input?.run_in_background,
          prompt: clip(b.input?.prompt, 6000),
          status: "running",
          startedAt: at,
        });
      else if (
        b.type === "tool_use" &&
        (b.name === "TaskStop" || b.name === "KillShell")
      )
        this.stops.set(b.id, b.input?.task_id || b.input?.shell_id);
      else if (b.type === "tool_use" && b.input?.run_in_background)
        this.pendingShells.set(b.id, {
          title: clip(b.input.description || b.input.command || b.name, 160),
          command: clip(b.input.command, 600),
          tool: b.name,
          startedAt: at,
        });
      else if (b.type === "tool_result") {
        const agent = this.agents.get(b.tool_use_id),
          result = text(b.content),
          stopped = this.stops.get(b.tool_use_id);
        if (stopped && !b.is_error) {
          const item =
            this.shells.get(stopped) ||
            [...this.agents.values()].find((a) => a.agentId === stopped);
          if (item) Object.assign(item, { status: "killed", endedAt: at });
        }
        if (agent) {
          const launched = /^Async agent launched/.exec(result);
          if (launched) {
            agent.background = true;
            agent.agentId = /agentId:\s*(\w+)/.exec(result)?.[1];
          } else
            Object.assign(agent, {
              status: b.is_error ? "failed" : "completed",
              endedAt: at,
              result: clip(result, 3000),
            });
        }
        const shell = this.pendingShells.get(b.tool_use_id);
        if (shell) {
          this.pendingShells.delete(b.tool_use_id);
          const id =
            r.toolUseResult?.backgroundTaskId ||
            /with ID:\s*(\w+)/.exec(result)?.[1];
          if (id) this.shells.set(id, { id, ...shell, status: "running" });
        }
      }
    }
  }
}
class SubAgent {
  constructor() {
    this.state = { offset: 0, rest: "", reset: () => this.clear() };
    this.clear();
  }
  clear() {
    Object.assign(this, {
      tools: 0,
      tokens: 0,
      recent: [],
      firstAt: null,
      lastAt: null,
      lastText: "",
    });
  }
  row(r) {
    if (r.timestamp) {
      this.firstAt ??= r.timestamp;
      this.lastAt = r.timestamp;
    }
    if (r.type !== "assistant") return;
    this.tokens += r.message?.usage?.output_tokens || 0;
    for (const b of r.message?.content || []) {
      if (b.type === "tool_use") {
        this.tools++;
        this.recent.push({
          name: b.name,
          summary: toolSummary(b),
          at: r.timestamp,
        });
        if (this.recent.length > 8) this.recent.shift();
      } else if (b.type === "text" && b.text.trim())
        this.lastText = clip(b.text.trim(), 600);
    }
  }
}
class AgentActivity {
  constructor({ conversations }) {
    this.conversations = conversations;
    this.transcripts = new Map();
    this.subagents = new Map();
  }
  async list(id) {
    const session = await this.conversations.session(id),
      file = await this.conversations.transcript(session);
    const result = {
      session: {
        id: session.id,
        status: session.status,
        substate: session.substate || "",
      },
      agents: [],
      shells: [],
    };
    if (!file) return result;
    let main = this.transcripts.get(file);
    if (!main) this.transcripts.set(file, (main = new Transcript()));
    await follow(file, main.state, (r) => main.row(r));
    // Agents spawned by agents have no tool call in the main transcript;
    // their meta file is the only record, so include those too.
    const folder = path.join(file.slice(0, -".jsonl".length), "subagents");
    const names = await fs.readdir(folder).catch(() => []);
    const byTool = new Map([...main.agents.values()].map((a) => [a.id, a]));
    for (const name of names.filter((n) => n.endsWith(".meta.json"))) {
      const agentId = name.slice("agent-".length, -".meta.json".length);
      let meta = {};
      try {
        meta = JSON.parse(await fs.readFile(path.join(folder, name), "utf8"));
      } catch {}
      let agent =
        byTool.get(meta.toolUseId) ||
        [...byTool.values()].find((a) => a.agentId === agentId);
      if (!agent) {
        agent = {
          id: meta.toolUseId || agentId,
          title: clip(meta.description || "Agent con", 120),
          type: meta.agentType || "general-purpose",
          background: meta.requestShape === "background",
          status: meta.finished ? "completed" : "running",
          nested: (meta.spawnDepth || 1) > 1,
        };
        byTool.set(agent.id, agent);
      }
      agent.agentId = agentId;
      if (meta.finished && agent.status === "running")
        agent.status = "completed";
      const log = path.join(folder, "agent-" + agentId + ".jsonl");
      let progress = this.subagents.get(log);
      if (!progress) this.subagents.set(log, (progress = new SubAgent()));
      try {
        await follow(log, progress.state, (r) => progress.row(r));
      } catch {}
      agent.activity = {
        tools: progress.tools,
        tokens: progress.tokens,
        recent: progress.recent,
        lastAt: progress.lastAt,
        lastText: progress.lastText,
      };
      agent.startedAt ??= progress.firstAt;
    }
    // agent-deck sees in-flight agents and shells in the pane; when it says
    // the session is idle or gone, nothing it started is still running.
    const ended =
      ["stopped", "error"].includes(session.status) ||
      session.substate === "idle-at-empty-prompt";
    if (ended)
      for (const item of [...byTool.values(), ...main.shells.values()])
        if (item.status === "running") item.status = "ended";
    const rank = (s) => (s === "running" ? 0 : 1);
    result.agents = [...byTool.values()].sort(
      (a, b) =>
        rank(a.status) - rank(b.status) ||
        String(b.startedAt).localeCompare(String(a.startedAt)),
    );
    result.shells = [...main.shells.values()]
      .sort(
        (a, b) =>
          rank(a.status) - rank(b.status) ||
          String(b.startedAt).localeCompare(String(a.startedAt)),
      )
      .slice(0, 30);
    return result;
  }
}
module.exports = { AgentActivity, Transcript, SubAgent };
