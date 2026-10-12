#!/usr/bin/env node
// Names each chat for the title bar of the panel showing it: "account · project
// · chat". A chat's tmux session puts its title on the terminal, so the iTerm2
// pane shows it as the chat is renamed. This watcher keeps every chat's account
// name current and refreshes the saved catalog of chats.
const fs=require('fs'),cp=require('child_process');
const {root,mux,deck}=require('./paths');
const env=require('./terminal-env'),accounts=require('./account-registry').accounts;
const catalog=require('./session-catalog');
const lock=root+'/panel-labels.lock';
// Same as [display] title_format in config.toml, which new chats start with.
const FORMAT='#{?@deck_account,#{@deck_account} · ,}#{@agentdeck_project_name} · #{@agentdeck_display_name}';
function tmux(...args){return cp.execFileSync(mux,['-u','-L','agent-deck-managed',...args],{env,encoding:'utf8',timeout:10000}).trim();}
function cli(args){return JSON.parse(cp.execFileSync(deck,args,{env,encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024}));}
function accountName(row){const a=accounts.find(a=>a.tool===row.tool&&a.slot===row.account);return a?(a.tool==='codex'?'Codex ':'')+a.name:String(row.account||'');}
// Titles one chat's session; `known` is what it has now, when already read.
function label(row,known){
  if(!row?.tmux_session)return;
  const name=accountName(row);
  if(known&&known.account===name&&known.format===FORMAT)return;
  try{tmux('set-option','-t',row.tmux_session,'@deck_account',name,';','set-option','-t',row.tmux_session,'set-titles','on',';','set-option','-t',row.tmux_session,'set-titles-string',FORMAT);}catch{}
}
let roster=[],rosterAt=0,unknown=new Set();
function update(){
  let current=new Map();
  try{current=new Map(tmux('list-sessions','-F','#{session_name}\t#{@deck_account}\t#{set-titles-string}').split('\n').map(row=>{const [name,account,format]=row.split('\t');return [name,{account,format}];}));}catch{}
  // Listing chats is slow; do it twice a minute, or when a chat is not titled yet.
  const untitled=[...current.entries()].some(([name,known])=>name.startsWith('agentdeck_')&&!unknown.has(name)&&(known.format!==FORMAT||!known.account));
  if(!untitled&&Date.now()-rosterAt<30000)return;
  rosterAt=Date.now();roster=cli(['list','--json']);
  for(const row of roster)if(current.has(row.tmux_session))label(row,current.get(row.tmux_session));
  // Sessions that are not chats of the deck wait for the next full listing.
  unknown=new Set([...current.keys()].filter(name=>!roster.some(row=>row.tmux_session===name)));
  catalog.replace(roster,rosterAt);
}
function start(){
  const child=cp.spawn(process.execPath,[__filename,'--watch'],{env,detached:true,stdio:'ignore'});child.unref();
}
function watch(){
  try{fs.mkdirSync(lock,{mode:0o700});}catch(error){
    if(error.code!=='EEXIST')throw error;
    try{const pid=Number(fs.readFileSync(lock+'/pid','utf8'));if(pid){process.kill(pid,0);return;}if(Date.now()-fs.statSync(lock).mtimeMs<15000)return;}catch(error){if(error.code!=='ESRCH'&&error.code!=='ENOENT')return;}
    fs.rmSync(lock,{recursive:true,force:true});try{fs.mkdirSync(lock,{mode:0o700});}catch{return;}
  }
  fs.writeFileSync(lock+'/pid',String(process.pid),{mode:0o600});
  const cleanup=()=>{try{if(fs.readFileSync(lock+'/pid','utf8')===String(process.pid))fs.rmSync(lock,{recursive:true,force:true});}catch{}};
  process.on('exit',cleanup);for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>process.exit(0));
  let failures=0;
  function tick(){try{update();failures=0;}catch{if(++failures>=3)process.exit(0);}setTimeout(tick,3000);}
  tick();
}
module.exports={start,update,label};
if(require.main===module){if(process.argv.includes('--watch'))watch();else update();}
