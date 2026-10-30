#!/usr/bin/env node
// A deck window of the Agent Deck app has the conversation list on the left and
// six chat panels, arranged by the deck controller (iterm.py). This runs the
// list, opens chats in panels, and carries out the Ctrl+B shortcuts.
const fs=require('fs');
const cp=require('child_process');
const {root,mux,deck,logFile}=require('./paths');
const panels=require('./panels'),iterm=require('./iterm'),settings=require('./settings');
const cliArgs=process.argv.slice(2),workspaceIndex=cliArgs.indexOf('--workspace');
let session=workspaceIndex>=0?cliArgs.splice(workspaceIndex,2)[1]:(process.env.AGENT_DECK_WORKSPACE||'claude-desk');
if(!panels.WORKSPACE.test(session))throw new Error('Invalid workspace');
const env={...require('./terminal-env'),AGENT_DECK_WORKSPACE:session};
function quietCommand(command){return `${command} >>'${logFile}' 2>&1 || true`;}
function managed(...args){return cp.execFileSync(mux,['-u','-L','agent-deck-managed',...args],{encoding:'utf8',env,timeout:5000,stdio:['ignore','pipe','pipe']}).trim();}
function clients(){try{return managed('list-clients','-F','#{client_tty}|#{client_session}|#{pane_id}|#{pane_in_mode}').split('\n').filter(Boolean).map(row=>row.split('|'));}catch{return [];}}
// Leaves scroll mode in the chat a panel shows, so it is ready to type in.
function readyToType(panel,rows=clients()){
  const row=rows.find(r=>r[0]===panel.tty);
  if(row&&/^%\d+$/.test(row[2])&&row[3]==='1')managed('send-keys','-X','-t',row[2],'cancel');
}
async function active(){try{return (await iterm.request({cmd:'active',workspace:session})).slot||1;}catch{return 1;}}
class PanelUnavailable extends Error {}
async function openChat(id) {
  if(!/^[a-zA-Z0-9_-]{8,128}$/.test(id||''))throw new Error('Invalid conversation');
  const lock=root+'/open-'+session+'.lock';let acquired=false;
  for(let attempt=0;attempt<80&&!acquired;attempt++){
    try{fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});acquired=true;}catch(error){
      if(error.code!=='EEXIST')throw error;
      try{const owner=Number(fs.readFileSync(lock,'utf8'));if(owner)process.kill(owner,0);else if(Date.now()-fs.statSync(lock).mtimeMs>15000)fs.unlinkSync(lock);}catch(error){if(error.code==='ESRCH'){try{fs.unlinkSync(lock);}catch{}}}
      if(!acquired)await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
  if(!acquired)throw new PanelUnavailable('A conversation is opening. Try again.');
  try{
    const info=JSON.parse(cp.execFileSync(deck,['session','show',id,'--json'],{encoding:'utf8',env,timeout:10000}));
    const rows=clients(),attached=new Map(rows.filter(([tty])=>tty).map(([tty,name])=>[tty,name]));
    const everywhere=panels.live(),here=everywhere.filter(p=>p.workspace===session);
    const showing=p=>(info.tmux_session&&attached.get(p.tty)===info.tmux_session)||(p.chatId===id&&['opening','chat'].includes(p.view));
    // Already open: bring that panel forward, in whichever deck shows it.
    const existing=here.find(showing)||everywhere.find(showing);
    if(existing){
      await iterm.request({cmd:'focus',tty:existing.tty});readyToType(existing,rows);
      await iterm.request({cmd:'flash',tty:existing.tty});return;
    }
    // Prefer a free panel; otherwise replace the chat in the panel used last.
    const last=await active();
    const free=here.find(p=>!attached.has(p.tty)&&(!p.view||p.view==='empty'))||here.find(p=>p.slot===last)||here[0];
    if(!free)throw new PanelUnavailable('No panel is available. Try again.');
    panels.write(session,free.slot,{view:'opening',chatId:id});
    if(!panels.request(free,{open:id}))throw new PanelUnavailable('No panel is available. Try again.');
    await iterm.request({cmd:'focus',tty:free.tty});
  }finally{try{if(fs.readFileSync(lock,'utf8')===String(process.pid))fs.unlinkSync(lock);}catch{}}
}
// Ctrl+B then a key, pressed in a chat panel (tmux runs this with the panel's
// terminal) or in a panel's menu. Other terminals keep tmux's usual meaning.
async function key(letter,tty){
  const panel=panels.live().find(p=>p.tty===tty);
  if(!panel)return usualKey(letter,tty);
  session=panel.workspace;
  switch(letter){
    case 'r':case 'd':return iterm.request({cmd:'list-view',workspace:session,mode:letter==='r'?'recent':'projects'});
    case 'g':return iterm.request({cmd:'focus-panel',workspace:session});
    case 'n':panels.request(panel,{menu:true});return;
    case 's':panels.request(panel,{continue:true});return;
    case 'z':return iterm.request({cmd:'zoom',tty});
    case 'w':return iterm.request({cmd:'new'});
    case 'l':return iterm.request({cmd:'list-toggle'});
    case 'a':{const auto=!settings.read().autoContinue;settings.write({autoContinue:auto});return iterm.request({cmd:'notify',text:'Auto-continue '+(auto?'on':'off')}).catch(()=>{});}
  }
}
function usualKey(letter,tty){
  const row=clients().find(r=>r[0]===tty);if(!row)return;
  const [,name,pane]=row;
  const commands={d:['detach-client','-t',tty],r:['refresh-client','-t',tty],z:['resize-pane','-Z','-t',pane],n:['next-window','-t',name],l:['last-window','-t',name],s:['choose-tree','-Zs','-t',pane],w:['choose-tree','-Zw','-t',pane]};
  if(commands[letter])managed(...commands[letter]);
}
// Shortcuts and routing on the chats' tmux server. Idempotent; each list runs it.
function configure() {
  cp.execFileSync(mux,['-u','-L','agent-deck-managed','start-server',';','set-option','-s','exit-empty','off',';','set-environment','-g','LANG',env.LANG,';','set-environment','-g','LC_CTYPE',env.LC_CTYPE,';','set-environment','-g','LC_ALL',env.LC_ALL],{env,timeout:5000,stdio:['ignore','pipe','pipe']});
  for(const letter of 'rdgnszwal')for(const k of [letter,letter.toUpperCase()])managed('bind-key',k,'run-shell','-b',quietCommand(`${root}/workspace.js key ${letter} '#{client_tty}'`));
  managed('set-hook','-g','client-attached[50]','run-shell -b '+JSON.stringify(quietCommand(`${root}/workspace.js route #{client_pid} #{session_name}`)));
  require('./panel-labels').start();
  require('./limit-router').start();
}
// Another copy of the deck on this Mac (a setup test) shares the chats' tmux
// server and can point the shortcuts at itself; a watcher stops for a code
// change. Each list checks both often and puts them right.
function keepConfigured(){
  let hook='';try{hook=managed('show-hooks','-g','client-attached');}catch{}
  if(!hook.includes(root+'/workspace.js'))return configure();
  require('./panel-labels').start();
  require('./limit-router').start();
}
// macOS prints this for every program the list starts; it says nothing.
const NOISE=/MallocStackLogging: can't turn off malloc stack logging because it was not enabled/;
// The list, restarted if it quits while its window is open.
function dashboard(args){
  configure();
  setInterval(()=>{try{keepConfigured();}catch(error){fs.appendFileSync(logFile,'Dashboard: '+error.message+'\n');}},15000);
  panels.write(session,0,{pid:process.pid,tty:panels.terminal()});
  process.stdout.write('\x1b]0;Conversations\x07');
  // An account added or renamed shows in the list once it starts again with it.
  const registry=require('./account-registry');let child;
  registry.onChange(()=>child?.kill());
  const run=()=>{
    child=cp.spawn(deck,args,{stdio:['inherit','inherit','pipe'],env:{...env,AGENT_DECK_HOME:root,AGENTDECK_ACCOUNT_LABELS:registry.labels()}});
    let pending='';
    child.stderr.on('data',data=>{
      const lines=(pending+data.toString()).split('\n');pending=lines.pop();
      const kept=lines.filter(line=>line&&!NOISE.test(line));
      if(kept.length)fs.appendFileSync(logFile,kept.join('\n')+'\n');
    });
    child.on('error',error=>fs.appendFileSync(logFile,'Dashboard: '+error.message+'\n'));
    child.on('exit',()=>{if(process.ppid===1)process.exit(0);setTimeout(run,700);});
  };
  run();
}
// agd run [folder]: a new deck, in the terminal it runs in when that is a tab
// of the Agent Deck app, or else in a new tab there. A folder is found in the
// default folder (agd run my-app), or else from where agd runs; ./ and ../
// start from there, ~ and / are as written.
async function runDeck(text,tty){
  const isFolder=file=>{try{return fs.statSync(file).isDirectory();}catch{return false;}};
  const path=require('path'),folders=require('./folders');
  const candidates=!text?[]:/^\.\.?(\/|$)/.test(text)?[path.resolve(text)]:[folders.resolve(text),path.resolve(text)];
  const folder=candidates.find(isFolder)||'';
  if(text&&!folder){console.error('Folder not found: '+text);process.exitCode=1;return;}
  const reply=await iterm.request({cmd:'run',tty,folder},60000,30000);
  console.log(reply.workspace+(reply.here?' here':''));
}
// A chat attached from the list outside the panels opens in a panel instead.
async function route(pidText,name){
  let pid=Number(pidText),found;
  for(let i=0;i<12&&pid>1&&!found;i++){
    let row;try{row=cp.execFileSync('/bin/ps',['-o','ppid=,command=','-p',String(pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{break;}
    found=row.match(/workspace\.js dashboard --workspace (claude-desk(?:-\d+)?)\b/);
    pid=Number(row.split(/\s+/)[0]);
  }
  if(!found)return;
  session=found[1];env.AGENT_DECK_WORKSPACE=session;
  const tty=managed('list-clients','-F','#{client_pid}|#{client_tty}').split('\n').map(s=>s.split('|')).find(c=>c[0]===pidText)?.[1];if(!tty)return;
  managed('detach-client','-t',tty);
  const sessions=JSON.parse(cp.execFileSync(deck,['list','--json'],{encoding:'utf8',env}));
  const selected=sessions.find(s=>s.tmux_session===name);
  if(selected){try{await openChat(selected.id);}catch(error){fs.appendFileSync(logFile,'Route: '+error.message+'\n');}}
}
async function run() {
  const [command,...args]=cliArgs;
  if(command==='dashboard')return dashboard(args);
  if(command==='open-chat'){try{await openChat(args[0]);}catch(error){fs.appendFileSync(logFile,'Open chat: '+error.message+'\n');console.log(error instanceof PanelUnavailable?error.message:'Could not open this conversation. Try again.');process.exitCode=1;}return;}
  if(command==='key')return key(String(args[0]).toLowerCase(),args[1]);
  if(command==='route')return route(args[0],args[1]);
  if(command==='new')return iterm.request({cmd:'new'});
  if(command==='run'){try{await runDeck(args[0]||'',args[1]||'');}catch(error){fs.appendFileSync(logFile,'Run: '+error.message+'\n');console.error('Agent Deck did not answer. Open it and try again.');process.exitCode=1;}return;}
  if(command==='configure')return configure();
  throw new Error('Unknown command');
}
run().catch(error=>{fs.appendFileSync(logFile,'Workspace: '+error.message+'\n');process.exitCode=1;});
