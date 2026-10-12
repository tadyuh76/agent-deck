// Continuing a chat on another account: which account to use, whether a plan
// limit stopped the chat, and moving it. The account chooser in a panel and the
// automatic limit router share these steps.
const fs=require('fs'),cp=require('child_process'),path=require('path');
const {root,deck,mux,claude,logFile}=require('./paths');
const panels=require('./panels'),accounts=require('./account-registry').accounts,usage=require('./account-usage'),catalog=require('./session-catalog'),env=require('./terminal-env');
const log=text=>fs.appendFileSync(logFile,text.trim()+'\n');

function cli(args,timeout=30000){return new Promise((resolve,reject)=>cp.execFile(deck,args,{env,timeout,maxBuffer:8*1024*1024},(error,stdout,stderr)=>{if(error){error.stdout=stdout;error.stderr=stderr;error.message+=(stdout||'')+(stderr||'');reject(error);}else resolve(stdout);}));}
function running(info){try{cp.execFileSync(mux,['-u','-L','agent-deck-managed','has-session','-t',info.tmux_session],{env,stdio:'ignore',timeout:10000});return true;}catch{return false;}}

function room(value,now){
  const windows=(value?.windows||[]).filter(w=>typeof w.used_pct==='number'&&Number.isFinite(w.used_pct)&&Date.parse(w.resets_at)>now);
  return windows.length?Math.min(...windows.map(w=>100-w.used_pct)):-1;
}
function choices(source,snapshot=usage.read(),now=Date.now()){
  const list=accounts.filter(a=>a.tool===source.tool&&a.slot!==source.account).map(account=>{
    const value=snapshot.accounts[account.slot],fresh=value?.status==='ready'&&!value.unavailable&&now-Date.parse(value.updated_at)<600000;
    const windows=(value?.windows||[]).filter(w=>['5h','7d','Week'].includes(w.window)||(w.window==='7d-model'&&/^opus(?:\s|$)/i.test(w.model||''))).filter(w=>typeof w.used_pct==='number'&&Number.isFinite(w.used_pct)&&Date.parse(w.resets_at)>now);
    const blocked=fresh&&windows.some(w=>w.used_pct>=100),available=fresh&&windows.length>0&&!blocked;
    const enabled=value?.status==='ready'&&!blocked;
    return {account,value,enabled,available,blocked,room:room(value,now)};
  });
  // The account with the most room left is offered first.
  const best=list.filter(c=>c.available).sort((a,b)=>b.room-a.room)[0];
  for(const c of list)c.recommended=c===best;
  return list;
}
// Fresh limits for every account, waiting at most `wait` for the check.
async function refreshedUsage(wait=45000){
  const before=usage.read().checked_at;usage.refresh(true);
  for(const end=Date.now()+wait;Date.now()<end&&usage.read().checked_at===before;)await new Promise(resolve=>setTimeout(resolve,500));
  return usage.read();
}

// The time of the latest reply when it was a plan-limit rejection.
function limitedAt(file){
  if(!file)return 0;
  let fd;
  try{
    fd=fs.openSync(file,'r');const size=fs.fstatSync(fd).size,length=Math.min(size,512*1024),buffer=Buffer.alloc(length);
    fs.readSync(fd,buffer,0,length,size-length);
    const lines=buffer.toString('utf8').split('\n');
    for(let i=lines.length-1;i>=0;i--){
      if(!lines[i].includes('"type":"assistant"'))continue;
      try{const row=JSON.parse(lines[i]);return row.isApiErrorMessage&&row.error==='rate_limit'?Date.parse(row.timestamp)||1:0;}catch{}
    }
    return 0;
  }catch{return 0;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
// A limit stops this session only if it came after the session started; a
// moved chat shares its transcript with the one that stopped.
function stoppedByLimit(info){const at=limitedAt(info.transcript_path);return at>Date.parse(info.created_at||0)?at:0;}

// Registers a chat with a title that is free in its folder.
async function create(args,account,folder,base,checkpoint=()=>{}){
  let rows=catalog.read(),authoritative=false;
  if(!rows){rows=JSON.parse(await cli(['list','--json']));authoritative=true;}
  for(let attempt=0;attempt<3;attempt++){checkpoint();let name=base,count=2;while(rows.some(s=>s.path===folder&&s.title===name))name=base+' ('+(count++)+')';
    try{const created=JSON.parse(await cli([...args,'-t',name]));catalog.remember({...created,account});return created;}catch(error){const duplicate=/duplicate|already exists|already registered|stale concurrent|database is locked/i.test(error.message);const fresh=JSON.parse(await cli(['list','--json']));if(!duplicate&&authoritative){const committed=fresh.filter(s=>s.path===folder&&s.title===name&&s.account===account&&!rows.some(old=>old.id===s.id));if(committed.length===1){catalog.remember(committed[0]);return committed[0];}}if(!duplicate)throw error;rows=fresh;authoritative=true;}
  }throw new Error('Could not register a new chat');
}

// Types "continue" once the resumed chat is ready. A busy input box (a draft,
// or a prompt still on screen) is retried for a while and never overwritten.
async function resend(id){
  for(let attempt=1;attempt<=6;attempt++){
    try{await cli(['session','send',id,'continue','--no-tag','-q','--timeout','1m'],90000);return;}
    catch(error){if(attempt===6||!/occupied|unreadable|not ready|timed out|timeout/i.test(error.message)){log('Resend: '+error.message.trim().split('\n').pop());return;}}
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
}
// A folder trusted on the original account is trusted on the account the
// chat moves to, so the move does not stop at Claude's folder check.
function carryTrust(from,to,folder){
  const read=home=>{try{return JSON.parse(fs.readFileSync(home+'/.claude.json','utf8'));}catch{return null;}};
  const trusted=(config,dir)=>{for(let d=dir;;d=path.dirname(d)){if(config?.projects?.[d]?.hasTrustDialogAccepted)return true;if(d===path.dirname(d))return false;}};
  try{
    const file=to.home+'/.claude.json',target=read(to.home);
    if(!target||trusted(target,folder)||!trusted(read(from.home),folder))return;
    target.projects={...target.projects,[folder]:{...target.projects?.[folder],hasTrustDialogAccepted:true}};
    const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(target,null,2),{mode:fs.statSync(file).mode&0o777});fs.renameSync(temp,file);
  }catch(error){log('Trust: '+error.message);}
}
function claudeSignedIn(account){
  return new Promise(resolve=>cp.execFile(claude,['auth','status'],{env:{...env,CLAUDE_CONFIG_DIR:account.home},timeout:30000},(error,out)=>{try{const status=JSON.parse(out);resolve(status.loggedIn&&status.email===account.email);}catch{resolve(false);}}));
}

class MoveRefused extends Error {}
// The resumed chat starts like a new one: the account's own model, and no
// permission prompts only when the deck is set to skip them.
function resumeCommand(sid){
  const config=fs.readFileSync(root+'/config.toml','utf8');
  return 'claude --resume '+sid+(/^\[claude\][^\[]*^\s*dangerous_mode\s*=\s*true\b/m.test(config)?' --dangerously-skip-permissions':'');
}
// Moves a Claude chat to `account`: the same conversation resumes there, the
// old entry is archived, and an interrupted request is sent again.
async function moveClaudeChat(info,account,{checkpoint=()=>{},onMoving=()=>{}}={}){
  const source=accounts.find(a=>a.tool==='claude'&&a.slot===info.account),sid=info.claude_session_id;
  if(!source||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid||'')||!info.transcript_path||path.basename(info.transcript_path)!==sid+'.jsonl')throw new MoveRefused('This chat has no saved conversation to continue.');
  const shared=fs.realpathSync(source.home+'/projects');
  if(fs.realpathSync(account.home+'/projects')!==shared||!fs.realpathSync(info.transcript_path).startsWith(shared+'/'))throw new MoveRefused('This account cannot access the saved conversation.');
  if(!await claudeSignedIn(account))throw new MoveRefused('Sign in as '+account.email+' first.');
  checkpoint();onMoving();
  const interrupted=Boolean(stoppedByLimit(info));
  const created=await create(['add',info.path,'-c','claude','-g',info.group,'--account',account.slot,'--no-parent','--json'],account.slot,info.path,info.title||'New conversation',checkpoint);
  await cli(['session','set-title-lock',created.id,'off','--json']);
  await cli(['session','set',created.id,'command',resumeCommand(sid),'--json']);
  await cli(['session','set',created.id,'claude-session-id',sid,'--json']);
  carryTrust(source,account,info.path);
  // Stop the old writer before opening the same shared transcript elsewhere.
  if(running(info))await cli(['session','stop',info.id,'--json'],60000);
  let launchError;try{await cli(['session','start',created.id,'--no-wait','--json'],60000);}catch(error){launchError=error;}
  const target=JSON.parse(await cli(['session','show',created.id,'--json']));
  if(!running(target)){if(launchError)log('Continue: '+launchError.message);throw new MoveRefused('Chat saved on '+account.name+' but did not start. Open it to retry.');}
  if(interrupted)void resend(created.id);
  // Keep one entry per conversation; the old one stays recoverable in the archive.
  await cli(['session','archive',info.id,'--json'],60000);
  return target;
}

// Panels currently showing a chat, noted before a move: stopping the old chat
// returns its panels to the menu and they forget which chat they showed.
function panesShowing(info){
  let attached=new Map();
  try{attached=new Map(cp.execFileSync(mux,['-u','-L','agent-deck-managed','list-clients','-F','#{client_tty}|#{client_session}'],{env,encoding:'utf8',timeout:5000}).trim().split('\n').map(row=>row.split('|')));}catch{}
  return panels.live().filter(p=>p.chatId===info.id||(info.tmux_session&&attached.get(p.tty)===info.tmux_session));
}
// Points the saved panels and the live `panes` that showed `oldId` at `newId`;
// `except` is the process of a panel that opens the new chat itself.
function repointPanels(oldId,newId,panes=[],except){
  for(const w of fs.readdirSync(root+'/panels'))if(panels.WORKSPACE.test(w))for(let slot=1;slot<=6;slot++){
    if(panels.read(w,slot).lastId===oldId)try{panels.write(w,slot,{lastId:newId});}catch{}
  }
  for(const panel of panes){
    if(panel.pid===except)continue;
    try{panels.request(panel,{open:newId});}catch(error){log('Repoint: '+error.message);}
  }
}

module.exports={cli,running,choices,refreshedUsage,limitedAt,stoppedByLimit,create,resend,moveClaudeChat,MoveRefused,panesShowing,repointPanels};
