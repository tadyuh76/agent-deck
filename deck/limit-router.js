#!/usr/bin/env node
// When a running Claude chat hits its plan limit, moves it to the Claude
// account with the most room left and lets it carry on. One watcher serves
// every deck window.
const fs=require('fs'),cp=require('child_process'),path=require('path');
const {root,mux,logFile}=require('./paths');
const lock=root+'/limit-router.lock',stateFile=root+'/limit-router.json';
const env=require('./terminal-env'),accounts=require('./account-registry').accounts;
const {cli,running,choices,refreshedUsage,limitedAt,stoppedByLimit,moveClaudeChat,MoveRefused,panesShowing,repointPanels}=require('./continuation');
const FRESH=15*60000,RETRY_ACCOUNT_AFTER=5*3600000;
const log=text=>fs.appendFileSync(logFile,'Limit router: '+text+'\n');

function readState(){try{return JSON.parse(fs.readFileSync(stateFile,'utf8'));}catch{return {handled:{},tried:{}};}}
function writeState(state){
  const cutoff=Date.now()-7*86400000;
  for(const [sid,at] of Object.entries(state.handled))if(at<cutoff)delete state.handled[sid];
  for(const [sid,slots] of Object.entries(state.tried))if(Math.max(...Object.values(slots))<cutoff)delete state.tried[sid];
  const temp=stateFile+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(state),{mode:0o600});fs.renameSync(temp,stateFile);
}
function notify(text){require('./iterm').request({cmd:'notify',text}).catch(()=>{});}
// Every Claude account keeps its transcripts in one shared folder; watch each distinct one.
function transcriptRoots(){return [...new Set(accounts.filter(a=>a.tool==='claude').map(a=>{try{return fs.realpathSync(a.home+'/projects');}catch{return null;}}).filter(Boolean))];}

async function route(sid,at,state){
  state.handled[sid]=at;writeState(state);
  const rows=JSON.parse(await cli(['list','--json'])).filter(r=>r.tool==='claude'&&!r.archived&&r.claude_session_id===sid);
  let info=null;
  for(const row of rows){const candidate=JSON.parse(await cli(['session','show',row.id,'--json']));if(running(candidate)&&stoppedByLimit(candidate)){info=candidate;break;}}
  // Closed, or already moved by hand.
  if(!info)return;
  const source=accounts.find(a=>a.tool==='claude'&&a.slot===info.account),title='“'+(info.title||'chat').slice(0,40)+'”';
  state.tried[sid]={...state.tried[sid],[info.account]:at};writeState(state);
  const snapshot=await refreshedUsage();
  const options=choices(info,snapshot).filter(c=>c.available&&!(Date.now()-(state.tried[sid]?.[c.account.slot]||0)<RETRY_ACCOUNT_AFTER)).sort((a,b)=>b.room-a.room);
  if(!options.length){notify((source?.name||info.account)+' hit its limit. No other Claude account has room for '+title+'.');log('no account with room for '+info.id);return;}
  for(const option of options){
    const target=option.account;
    notify((source?.name||info.account)+' hit its limit. Moving '+title+' to '+target.name+'…');
    try{
      const panes=panesShowing(info),moved=await moveClaudeChat(info,target);
      state.tried[sid]={...state.tried[sid],[target.slot]:0};writeState(state);
      repointPanels(info.id,moved.id,panes);
      notify(title+' continues on '+target.name+'.');log('moved '+info.id+' to '+target.slot+' as '+moved.id);
      return;
    }catch(error){
      log('move to '+target.slot+' failed: '+error.message.trim().split('\n').pop());
      // Only a missing sign-in is worth trying the next account for.
      if(!(error instanceof MoveRefused)||!/^Sign in/.test(error.message)){notify('Could not move '+title+'. Open it to continue on another account.');return;}
    }
  }
  notify('No signed-in Claude account has room for '+title+'.');
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
  const state=readState();let since=Date.now()-FRESH,busy=false;
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
          busy=true;try{await route(sid,at,state);}catch(error){log(error.message.trim().split('\n').pop());}finally{busy=false;}
        }
      }
      since=started;
    }catch(error){log(error.message);}
    setTimeout(tick,3000);
  }
  tick();
}
function start(){const child=cp.spawn(process.execPath,[__filename,'--watch'],{env,detached:true,stdio:'ignore'});child.unref();}
module.exports={start};
if(require.main===module&&process.argv.includes('--watch'))watch();
