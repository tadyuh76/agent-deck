// Linux paths for the Windows/WSL installation of the supplied deck.
const fs = require('fs'), os = require('os'), path = require('path');
const home = os.homedir();
const binPath = [home + '/.local/bin', '/usr/local/go/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
function program(name) {
  for (const dir of binPath.split(':')) {
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  }
  return home + '/.local/bin/' + name;
}
const logFile = home + '/.local/state/agent-deck/Agent Deck.log';
fs.mkdirSync(path.dirname(logFile), {recursive: true, mode: 0o700});
module.exports = {program, home, root: __dirname, deck: program('agent-deck'), mux: program('tmux'), claude: program('claude'), codex: program('codex'), logFile, binPath};
