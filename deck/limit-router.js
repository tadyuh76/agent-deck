#!/usr/bin/env node
// When a running chat hits its plan limit, moves it to the account of the same
// subscription with the most room left and lets it carry on. Claude Code
// chats are seen from their transcripts, other tools from the limit message
// on their screen. One watcher serves every deck window.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const {root,mux,logFile}=require('./paths');
const stateFile=root+'/limit-router.json';
const env=require('./terminal-env'),accounts=require('./account-registry').accounts,watcher=require('./watcher'),providers=require('./providers');
const {cli,running,choices,refreshedUsage,limitedAt,stoppedByLimit,sending,moveChat,MoveRefused,panesShowing,repointPanels}=require('./continuation');
const FRESH=15*60000,RETRY_ACCOUNT_AFTER=5*3600000;
const log=text=>fs.appendFileSync(logFile,new Date().toISOString()+' Limit router: '+text.replace(/\s+/g,' ').trim()+'\n');

// handled: conversation → limit already acted on; tried: conversation → account → when;
// screens: chat → when its screen first showed a limit.
function readState(){try{return {handled:{},tried:{},screens:{},...JSON.parse(fs.readFileSync(stateFile,'utf8'))};}catch{return {handled:{},tried:{},screens:{}};}}
function writeState(state){
  const cutoff=Date.now()-7*86400000;
  for(const [key,at] of Object.entries(state.handled))if(at<cutoff)delete state.handled[key];
  for(const [key,slots] of Object.entries(state.tried))if(Math.max(...Object.values(slots))<cutoff)delete state.tried[key];
  for(const [id,at] of Object.entries(state.screens))if(at<cutoff)delete state.screens[id];
  const temp=stateFile+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(state),{mode:0o600});fs.renameSync(temp,stateFile);
}
function notify(text){require('./iterm').request({cmd:'notify',text}).catch(()=>{});}
// Every Claude Code account keeps its transcripts in one shared folder; watch each distinct one.
function transcriptRoots(){return [...new Set(accounts.filter(a=>a.tool==='claude').map(a=>{try{return fs.realpathSync(a.home+'/projects');}catch{return null;}}).filter(Boolean))];}

// Moves `info` (a running chat stopped by its limit at `at`) on; `key` names its conversation.
async function route(info,key,at,state){
  const source=accounts.find(a=>a.slot===info.account),title='“'+(info.title||'chat').slice(0,40)+'”';
  if(!source||!providers.of(source).continues)return;
  const kind=providers.of(source).name;
  state.tried[key]={...state.tried[key],[info.account]:at};writeState(state);
  const snapshot=await refreshedUsage();
  const options=choices(info,snapshot).filter(c=>c.available&&!(Date.now()-(state.tried[key]?.[c.account.slot]||0)<RETRY_ACCOUNT_AFTER)).sort((a,b)=>b.room-a.room);
  if(!options.length){notify(source.name+' hit its limit. No other '+kind+' account has room for '+title+'.');log('no account with room for '+info.id);return;}
  for(const option of options){
    const target=option.account;
    notify(source.name+' hit its limit. Moving '+title+' to '+target.name+'…');
    try{
      const panes=panesShowing(info),moved=await moveChat(info,target);
      state.tried[key]={...state.tried[key],[target.slot]:0};writeState(state);
      if(moved.id!==info.id)repointPanels(info.id,moved.id,panes);
      notify(title+' continues on '+target.name+'.');log('moved '+info.id+' to '+target.slot+' as '+moved.id);
      return;
    }catch(error){
      log('move to '+target.slot+' failed: '+error.message);
      // Moved meanwhile from a panel: nothing left to do.
      if(error.continuesAt||/already moving/.test(error.message))return;
      // Only a missing sign-in is worth trying the next account for.
      if(!(error instanceof MoveRefused)||!/^Sign in/.test(error.message)){notify('Could not move '+title+'. Open it to continue on another account.');return;}
    }
  }
  notify('No signed-in '+kind+' account has room for '+title+'.');
}
// A Claude Code conversation whose transcript ends in a plan-limit rejection.
async function routeTranscript(sid,at,state){
  state.handled[sid]=at;writeState(state);
  const rows=JSON.parse(await cli(['list','--json'])).filter(r=>r.tool==='claude'&&!r.archived&&r.claude_session_id===sid);
  for(const row of rows){const info=JSON.parse(await cli(['session','show',row.id,'--json']));if(running(info)&&stoppedByLimit(info))return route(info,sid,at,state);}
  // Closed, or already moved by hand.
}
// The last lines on a chat's screen.
function screen(info){try{return cp.execFileSync(mux,['-u','-L','agent-deck-managed','capture-pane','-p','-J','-t',info.tmux_session,'-S','-25'],{env,encoding:'utf8',timeout:5000});}catch{return '';}}
// Other tools: a running chat whose screen ends with its subscription's limit message.
async function scanScreens(state){
  const watched=accounts.filter(a=>a.tool!=='claude'&&providers.of(a).limitText);
  if(!watched.length)return;
  const rows=JSON.parse(await cli(['list','--json'])).filter(r=>!r.archived&&r.tool!=='claude'&&watched.some(a=>a.slot===r.account));
  for(const row of rows){
    const account=watched.find(a=>a.slot===row.account),text=screen(row);
    if(!text||!providers.of(account).limitText.test(text)){if(state.screens[row.id]){delete state.screens[row.id];writeState(state);}continue;}
    if(state.screens[row.id])continue;
    const at=Date.now();state.screens[row.id]=at;state.handled[row.id]=at;writeState(state);
    const info=JSON.parse(await cli(['session','show',row.id,'--json']));
    if(running(info))await route(info,row.id,at,state);
  }
}

function watch(){
  let busy=false;
  if(!watcher.claim(__filename,()=>!busy&&!sending()))return;
  const state=readState();let since=Date.now()-FRESH,screensAt=0;
  async function tick(){
    const started=Date.now();
    try{
      for(const dir of transcriptRoots())for(const project of fs.readdirSync(dir)){
        let files=[];try{files=fs.readdirSync(path.join(dir,project));}catch{continue;}
        for(const name of files){
          if(!name.endsWith('.jsonl'))continue;
          const file=path.join(dir,project,name);let mtime=0;try{mtime=fs.statSync(file).mtimeMs;}catch{continue;}
          if(mtime<since-2000)continue;
          const at=limitedAt(file),sid=name.slice(0,-6);
          if(!at||Date.now()-at>FRESH||at<=(state.handled[sid]||0)||busy)continue;
          busy=true;try{await routeTranscript(sid,at,state);}catch(error){log(error.message);}finally{busy=false;}
        }
      }
      since=started;
      if(started-screensAt>=6000&&!busy){screensAt=started;busy=true;try{await scanScreens(state);}catch(error){log(error.message);}finally{busy=false;}}
    }catch(error){log(error.message);}
    setTimeout(tick,3000);
  }
  tick();
}
function start(){watcher.ensure(__filename,env);}
module.exports={start};
if(require.main===module&&process.argv.includes('--watch'))watch();
