#!/usr/bin/env node
// Names each chat for the title bar of the panel showing it: "account · project
// · chat". A chat's tmux session puts its title on the terminal, so the iTerm2
// pane shows it as the chat is renamed. This watcher keeps every chat's account
// name current and refreshes the saved catalog of chats.
const cp=require('child_process');
const {mux,deck}=require('./paths');
const env=require('./terminal-env'),accounts=require('./account-registry').accounts;
const catalog=require('./session-catalog'),watcher=require('./watcher');
// Same as [display] title_format in config.toml, which new chats start with.
const FORMAT='#{?@deck_account,#{@deck_account} · ,}#{@agentdeck_project_name} · #{@agentdeck_display_name}';
function tmux(...args){return cp.execFileSync(mux,['-u','-L','agent-deck-managed',...args],{env,encoding:'utf8',timeout:10000}).trim();}
function cli(args){return JSON.parse(cp.execFileSync(deck,args,{env,encoding:'utf8',timeout:15000,maxBuffer:8*1024*1024}));}
function accountName(row){const a=accounts.find(a=>a.slot===row.account);return a?a.tag:String(row.account||'');}
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
function start(){watcher.ensure(__filename,env);}
function watch(){
  if(!watcher.claim(__filename))return;
  let failures=0;
  function tick(){try{update();failures=0;}catch{if(++failures>=3)process.exit(0);}setTimeout(tick,3000);}
  tick();
}
module.exports={start,update,label};
if(require.main===module){if(process.argv.includes('--watch'))watch();else update();}
