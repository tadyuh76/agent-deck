// Replaces the Mac iTerm2 controller with a separate outer tmux server.
// Chat sessions continue to use the kit's agent-deck-managed server.
const fs = require('fs'), cp = require('child_process');
const {root, mux, home} = require('./paths');
const server = 'agent-deck-workspace';
const env = {...process.env, PATH: require('./paths').binPath, TERM: 'xterm-256color'};
delete env.TMUX;
const quote = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
function tmux(...args) {
  return cp.execFileSync(mux, ['-u', '-L', server, ...args], {env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']}).trim();
}
function sessions() {
  try { return tmux('list-sessions', '-F', '#{session_name}').split('\n').filter(w => /^claude-desk(?:-\d+)?$/.test(w)); } catch { return []; }
}
function panes(workspace) {
  try {
    return tmux('list-panes', '-s', '-t', workspace, '-F', '#{pane_id}|#{pane_tty}|#{@deck_slot}|#{pane_active}').split('\n').map(line => {
      const [id, tty, slot, active] = line.split('|'); return {id, tty, slot: Number(slot), active: active === '1'};
    });
  } catch { return []; }
}
function paneForTTY(tty) {
  for (const workspace of sessions()) {
    const pane = panes(workspace).find(p => p.tty === tty);
    if (pane) return {...pane, workspace};
  }
  throw new Error('That panel is not open.');
}
function focus(pane) {
  tmux('select-pane', '-t', pane.id);
  if (pane.slot) tmux('set-option', '-t', pane.workspace, '@deck_last_slot', String(pane.slot));
  // If another deck is displayed, switch its attached view to this deck.
  const clients = tmux('list-clients', '-F', '#{client_tty}|#{client_session}').split('\n').map(row => row.split('|'));
  if (!clients.some(([, workspace]) => workspace === pane.workspace) && clients[0]?.[0]) tmux('switch-client', '-c', clients[0][0], '-t', pane.workspace);
}
function lastSlot(workspace) {
  const selected = panes(workspace).find(p => p.active && p.slot > 0);
  if (selected) { tmux('set-option', '-t', workspace, '@deck_last_slot', String(selected.slot)); return selected.slot; }
  try { return Number(tmux('show-option', '-v', '-t', workspace, '@deck_last_slot')) || 1; } catch { return 1; }
}
function launchCommand(workspace, script, ...args) {
  return ['env', 'AGENT_DECK_WORKSPACE=' + quote(workspace), quote(home + '/.local/bin/agent-deck-run'), quote(workspace), quote(root + '/' + script), ...args.map(quote)].join(' ');
}
function create(workspace) {
  if (!/^claude-desk(?:-\d+)?$/.test(workspace)) throw new Error('Invalid workspace');
  if (sessions().includes(workspace)) return workspace;
  const panels = require('./panels');
  const projects = JSON.parse(fs.readFileSync(root + '/windows-projects.json', 'utf8'));
  for (let slot = 1; slot <= 6; slot++) {
    const saved = panels.read(workspace, slot);
    if (!saved.path && !saved.lastId) panels.write(workspace, slot, {path: slot % 2 ? projects.web : projects.mobile});
  }
  // Build at a useful initial size, then tmux adapts it to the real terminal.
  const left = tmux('new-session', '-d', '-s', workspace, '-x', '220', '-y', '58', '-P', '-F', '#{pane_id}', launchCommand(workspace, 'workspace.js', 'dashboard', '--workspace', workspace));
  tmux('set-option', '-g', 'default-terminal', 'tmux-256color', ';', 'set-option', '-g', 'mouse', 'on', ';', 'set-option', '-g', 'status', 'on', ';', 'set-option', '-g', 'status-style', 'bg=#1f2937,fg=#e5e7eb', ';', 'set-option', '-g', 'status-left', ' Agent Deck ', ';', 'set-option', '-g', 'status-right', 'Ctrl+B r:List g:Panels z:Zoom w:Deck | Shift+drag:Copy ', ';', 'set-option', '-g', 'status-right-length', '80');
  tmux('set-window-option', '-t', workspace, 'pane-border-status', 'top', ';', 'set-window-option', '-t', workspace, 'pane-border-format', ' #{@deck_slot}: #{pane_title} ', ';', 'set-window-option', '-t', workspace, 'pane-active-border-style', 'fg=#27c7a8');
  tmux('set-option', '-p', '-t', left, '@deck_slot', '0');
  function split(target, horizontal, size, slot) {
    const id = tmux('split-window', horizontal ? '-h' : '-v', '-t', target, '-l', size, '-P', '-F', '#{pane_id}', launchCommand(workspace, 'panel.js', String(slot), '--restore'));
    tmux('set-option', '-p', '-t', id, '@deck_slot', String(slot));
    return id;
  }
  const topLeft = split(left, true, '77%', 1);
  const topRight = split(topLeft, true, '50%', 2);
  const middleLeft = split(topLeft, false, '67%', 3);
  split(middleLeft, false, '50%', 5);
  const middleRight = split(topRight, false, '67%', 4);
  split(middleRight, false, '50%', 6);
  for (const key of 'rdgnszw') {
    const command = [quote(process.execPath), quote(__filename), '--key', key, "'#{pane_tty}'"].join(' ');
    tmux('bind-key', key, 'run-shell', '-b', command);
  }
  tmux('bind-key', 'Left', 'select-pane', '-L', ';', 'bind-key', 'Right', 'select-pane', '-R', ';', 'bind-key', 'Up', 'select-pane', '-U', ';', 'bind-key', 'Down', 'select-pane', '-D');
  tmux('select-pane', '-t', topLeft);
  return workspace;
}
async function request(payload) {
  const workspace = payload.workspace || process.env.AGENT_DECK_WORKSPACE || 'claude-desk';
  switch (payload.cmd) {
    case 'open': case 'show': create(workspace); return {ok: true};
    case 'new': {
      let n = 2; const names = sessions(); while (names.includes('claude-desk-' + n)) n++;
      const next = create('claude-desk-' + n); focus({...panes(next).find(p => p.slot === 1), workspace: next}); return {ok: true};
    }
    case 'focus': { const pane = paneForTTY(payload.tty); focus(pane); return {ok: true}; }
    case 'flash': return {ok: true}; // The active pane border identifies the selection.
    case 'zoom': { const pane = paneForTTY(payload.tty); tmux('resize-pane', '-Z', '-t', pane.id); return {ok: true}; }
    case 'restart': { const pane = paneForTTY(payload.tty); tmux('respawn-pane', '-k', '-t', pane.id); return {ok: true}; }
    case 'active': return {ok: true, slot: lastSlot(workspace)};
    case 'focus-panel': { const pane = panes(workspace).find(p => p.slot === lastSlot(workspace)); if (pane) focus({...pane, workspace}); return {ok: true}; }
    case 'list-view': {
      lastSlot(workspace);
      const pane = panes(workspace).find(p => p.slot === 0);
      if (pane) {
        const contents = tmux('capture-pane', '-p', '-t', pane.id);
        if (contents.includes('RECENT · Alt+V Projects') !== (payload.mode === 'recent')) tmux('send-keys', '-t', pane.id, 'Escape', 'v');
        focus({...pane, workspace});
      }
      return {ok: true};
    }
    case 'notify':
      for (const name of sessions()) tmux('display-message', '-t', name, String(payload.text || ''));
      return {ok: true};
    default: throw new Error('Unknown deck controller request');
  }
}
module.exports = {request, create, tmux, server};
if (require.main === module) {
  if (process.argv[2] === '--key') {
    const key = process.argv[3], pane = paneForTTY(process.argv[4]);
    if (pane.slot === 0) {
      const actions = {r: {cmd: 'list-view', mode: 'recent'}, d: {cmd: 'list-view', mode: 'projects'}, g: {cmd: 'focus-panel'}, w: {cmd: 'new'}, z: {cmd: 'zoom', tty: pane.tty}};
      if (actions[key]) request({...actions[key], workspace: pane.workspace}).catch(error => console.error(error.message));
    } else {
      cp.execFileSync(process.execPath, [root + '/workspace.js', 'key', key, pane.tty], {env: {...env, AGENT_DECK_WORKSPACE: pane.workspace}, timeout: 30000});
    }
  } else {
    const workspace = process.argv[2] || 'claude-desk';
    create(workspace);
    const child = cp.spawn(mux, ['-u', '-L', server, 'attach-session', '-t', workspace], {env, stdio: 'inherit'});
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code || 0; });
  }
}
