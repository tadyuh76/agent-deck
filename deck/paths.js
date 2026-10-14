// Where this deck's programs and files live on this Mac.
const fs=require('fs'),os=require('os');
const home=os.homedir();
function program(name){
  for(const dir of [home+'/.local/bin','/opt/homebrew/bin','/usr/local/bin']){
    const file=dir+'/'+name;
    try{fs.accessSync(file,fs.constants.X_OK);return file;}catch{}
  }
  return home+'/.local/bin/'+name;
}
module.exports={
  program,
  home,
  root:__dirname,
  deck:program('agent-deck'),
  mux:program('tmux'),
  claude:program('claude'),
  codex:program('codex'),
  logFile:home+'/Library/Logs/Agent Deck.log',
  // Kiro's installer may leave its command inside its app.
  binPath:[home+'/.local/bin','/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin','/Applications/Kiro CLI.app/Contents/MacOS'].join(':'),
};
