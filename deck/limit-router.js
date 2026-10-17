#!/usr/bin/env node
// When a running chat hits its plan limit and auto-continue is on, moves it to
// the account of the same subscription with the most room left and lets it
// carry on. With auto-continue off it says so once and leaves the choice to
// the chat's panel (Ctrl+B S); switched on later, it moves the chats still
// waiting. Claude Code chats are seen from their transcripts, other tools from
// the limit message on their screen. One watcher serves every deck window.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const {root,mux,logFile}=require('./paths');
const stateFile=root+'/limit-router.json';
const env=require('./terminal-env'),accounts=require('./account-registry').accounts,watcher=require('./watcher'),providers=require('./providers'),settings=require('./settings');
const {cli,running,limitedAt,stoppedByLimit,sending,moveToBest,MoveRefused,panesShowing,repointPanels}=require('./continuation');
// A limit is acted on while fresh; one seen with auto-continue off waits until
// the plan's 5-hour window would have reset. An account that reached its limit
// is not tried again for that long; a failed attempt is tried again soon.
const FRESH=15*60000,WAIT=5*3600000,RETRY_AFTER=30000;
const log=text=>fs.appendFileSync(logFile,new Date().toISOString()+' Limit router: '+text.replace(/\s+/g,' ').trim()+'\n');

// handled: limit → when it was seen and dealt with; tried: conversation →
// account → when it reached its limit there; screens: chat → when its screen
// first showed a limit; waiting: limits seen and not dealt with yet.
function readState(){
  const empty={handled:{},tried:{},screens:{},waiting:{}};
  try{return {...empty,...JSON.parse(fs.readFileSync(stateFile,'utf8'))};}catch{return empty;}
}
function writeState(state){
  const cutoff=Date.now()-7*86400000;
  for(const [key,at] of Object.entries(state.handled))if(at<cutoff)delete state.handled[key];
  for(const [key,slots] of Object.entries(state.tried))if(Math.max(...Object.values(slots))<cutoff)delete state.tried[key];
  for(const [id,at] of Object.entries(state.screens))if(at<cutoff)delete state.screens[id];
  const temp=stateFile+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(state),{mode:0o600});fs.renameSync(temp,stateFile);
}
function notify(text){require('./iterm').request({cmd:'notify',text}).catch(()=>{});}
const title=info=>'“'+(info.title||'chat').slice(0,40)+'”';
const continues=row=>{const a=accounts.find(a=>a.slot===row.account);return a&&providers.of(a).continues?a:null;};
// Every Claude Code account keeps its transcripts in one shared folder; watch each distinct one.
function transcriptRoots(){return [...new Set(accounts.filter(a=>a.tool==='claude').map(a=>{try{return fs.realpathSync(a.home+'/projects');}catch{return null;}}).filter(Boolean))];}
// The last lines on a chat's screen.
function screen(row){try{return cp.execFileSync(mux,['-u','-L','agent-deck-managed','capture-pane','-p','-J','-t',row.tmux_session,'-S','-25'],{env,encoding:'utf8',timeout:5000});}catch{return '';}}
// Chats that may be running; a limit can leave one showing an error.
const chats=async()=>JSON.parse(await cli(['list','--json'])).filter(r=>!r.archived&&r.status!=='stopped');

// The running chat a waiting limit stopped, or null when there is none any
// more: closed, moved by hand, or carried on.
async function stopped(entry,rows){
  const candidates=entry.kind==='transcript'?rows.filter(r=>r.tool==='claude'&&r.claude_session_id===entry.key):rows.filter(r=>r.id===entry.key);
  for(const row of candidates){
    const info=JSON.parse(await cli(['session','show',row.id,'--json']));
    if(running(info)&&stoppedByLimit(info))return info;
  }
  return null;
}
// Moves a chat its limit stopped to the account with the most room.
async function route(info,entry,state){
  const source=continues(info);if(!source)return;
  const key=entry.key;
  state.tried[key]={...state.tried[key],[info.account]:entry.at};writeState(state);
  try{
    const panes=panesShowing(info);
    const {account,chat}=await moveToBest(info,{
      avoid:slot=>Date.now()-(state.tried[key]?.[slot]||0)<WAIT,
      onMoving:target=>notify(source.name+' reached its limit. Moving '+title(info)+' to '+target.name+'…'),
    });
    state.tried[key]={...state.tried[key],[account.slot]:0};writeState(state);
    if(chat.id!==info.id)repointPanels(info.id,chat.id,panes);
    notify(title(info)+' continues on '+account.name+'.');log('moved '+info.id+' to '+account.slot+' as '+chat.id);
  }catch(error){
    if(!(error instanceof MoveRefused))throw error;
    log('could not move '+info.id+': '+error.message);
    // Moved meanwhile from a panel: nothing left to do.
    if(error.continuesAt||/already moving/.test(error.message))return;
    notify(/room/.test(error.message)?error.message.replace(/\.$/,' for '+title(info)+'.'):'Could not move '+title(info)+'. Open it to continue on another account.');
  }
}
// Deals with the limits waiting, oldest first.
async function settle(state){
  const entries=Object.entries(state.waiting).map(([key,value])=>({key,...value})).sort((a,b)=>a.at-b.at);
  if(!entries.length)return;
  const auto=settings.read().autoContinue,now=Date.now();
  let rows=null;
  for(const entry of entries){
    if(now-entry.at>WAIT||(auto?entry.retryAt>now:entry.notified))continue;
    rows=rows||await chats();
    let info;
    try{info=await stopped(entry,rows);}catch(error){log(error.message);continue;}
    if(info&&!auto){
      if(!entry.notified){
        const source=continues(info);
        if(source)notify(source.title+' reached its limit. Ctrl+B S to continue '+title(info)+' on another account.');
        state.waiting[entry.key]={...state.waiting[entry.key],notified:true};writeState(state);
      }
      continue;
    }
    try{if(info)await route(info,entry,state);}
    catch(error){
      log(error.message);
      // Tried again for a while, then left to the chat's panel.
      const first=entry.firstTry||now;
      if(Date.now()-first<FRESH){state.waiting[entry.key]={...state.waiting[entry.key],firstTry:first,retryAt:Date.now()+RETRY_AFTER};writeState(state);continue;}
      notify('Could not move '+title(info)+'. Ctrl+B S to continue it on another account.');
    }
    delete state.waiting[entry.key];state.handled[entry.key]=entry.at;writeState(state);
  }
  for(const entry of entries)if(now-entry.at>WAIT&&state.waiting[entry.key]){delete state.waiting[entry.key];state.handled[entry.key]=entry.at;writeState(state);}
}
function wait(state,key,at,kind){
  if(at<=(state.handled[key]||0)||state.waiting[key]?.at>=at)return;
  state.waiting[key]={at,kind};writeState(state);
}
// Claude Code transcripts written since `since` that end in a plan-limit rejection.
function scanTranscripts(state,since,window){
  for(const dir of transcriptRoots())for(const project of fs.readdirSync(dir)){
    let files=[];try{files=fs.readdirSync(path.join(dir,project));}catch{continue;}
    for(const name of files){
      if(!name.endsWith('.jsonl'))continue;
      const file=path.join(dir,project,name);let mtime=0;try{mtime=fs.statSync(file).mtimeMs;}catch{continue;}
      if(mtime<since-2000)continue;
      const at=limitedAt(file);
      if(at&&Date.now()-at<=window)wait(state,name.slice(0,-6),at,'transcript');
    }
  }
}
// Other tools: running chats whose screen ends with their subscription's limit message.
async function scanScreens(state){
  if(!accounts.some(a=>a.tool!=='claude'&&providers.of(a).limitText))return;
  for(const row of await chats()){
    const account=accounts.find(a=>a.slot===row.account);
    if(!account||account.tool==='claude'||!providers.of(account).limitText||row.tool==='claude')continue;
    const text=screen(row),limited=Boolean(text)&&providers.of(account).limitText.test(text);
    if(!limited){if(state.screens[row.id]){delete state.screens[row.id];delete state.waiting[row.id];writeState(state);}continue;}
    if(!state.screens[row.id]){state.screens[row.id]=Date.now();writeState(state);}
    wait(state,row.id,state.screens[row.id],'screen');
  }
}

function watch(){
  let busy=false;
  if(!watcher.claim(__filename,()=>!busy&&!sending()))return;
  const state=readState();
  // Limits reached while no watcher ran are caught up on.
  let since=Date.now()-FRESH,screensAt=0,auto=settings.read().autoContinue;
  async function tick(){
    const started=Date.now();busy=true;
    try{
      // Switched on: chats a limit stopped in the last five hours carry on too.
      const now=settings.read().autoContinue;
      scanTranscripts(state,now&&!auto?started-WAIT:since,now&&!auto?WAIT:FRESH);auto=now;since=started;
      if(started-screensAt>=6000){screensAt=started;await scanScreens(state);}
      await settle(state);
    }catch(error){log(error.message);}
    finally{busy=false;}
    setTimeout(tick,3000);
  }
  tick();
}
function start(){watcher.ensure(__filename,env);}
module.exports={start};
if(require.main===module&&process.argv.includes('--watch'))watch();
