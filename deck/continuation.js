// Continuing a chat on another account: which account to use, whether a plan
// limit stopped the chat, and moving it. The account chooser in a panel and the
// automatic limit router share these steps.
const fs=require('fs'),cp=require('child_process'),path=require('path');
const {root,deck,mux,logFile}=require('./paths');
const panels=require('./panels'),accounts=require('./account-registry').accounts,usage=require('./account-usage'),catalog=require('./session-catalog'),env=require('./terminal-env'),providers=require('./providers');
const log=text=>fs.appendFileSync(logFile,text.trim()+'\n');

function run(args,timeout){return new Promise((resolve,reject)=>cp.execFile(deck,args,{env,timeout,maxBuffer:8*1024*1024},(error,stdout,stderr)=>{if(error){error.stdout=stdout;error.stderr=stderr;error.message+=(stdout||'')+(stderr||'');reject(error);}else resolve(stdout);}));}
// Agent Deck refuses a save that raced another program's save of the same chat
// (a new chat is busy for its first seconds). Reads and settings are safe to
// repeat, so those are tried again; adding and starting chats are not.
const REPEATABLE=new Set(['list','session show','session set','session set-title-lock','session stop','session archive','remove']);
const RACED=/stale concurrent|concurrent .*conflict|database is locked|SQLITE_BUSY/i;
async function cli(args,timeout=30000){
  const repeatable=REPEATABLE.has(args[0]==='session'?'session '+args[1]:args[0]);
  for(let attempt=1;;attempt++){
    try{return await run(args,timeout);}
    catch(error){if(!repeatable||attempt>=6||!RACED.test(error.message))throw error;}
    await new Promise(resolve=>setTimeout(resolve,300*attempt));
  }
}
function running(info){try{cp.execFileSync(mux,['-u','-L','agent-deck-managed','has-session','-t',info.tmux_session],{env,stdio:'ignore',timeout:10000});return true;}catch{return false;}}

function room(value,now){
  const windows=(value?.windows||[]).filter(w=>typeof w.used_pct==='number'&&Number.isFinite(w.used_pct)&&Date.parse(w.resets_at)>now);
  return windows.length?Math.min(...windows.map(w=>100-w.used_pct)):-1;
}
const accountOf=slot=>accounts.find(a=>a.slot===slot);
// The other accounts of the same subscription a chat can carry on in.
function choices(source,snapshot=usage.read(),now=Date.now()){
  const from=accountOf(source.account);
  const list=accounts.filter(a=>from&&a.provider===from.provider&&a.slot!==from.slot).map(account=>{
    const value=snapshot.accounts[account.slot],ready=value?.status==='ready',fresh=ready&&!value.unavailable&&now-Date.parse(value.updated_at)<600000;
    const windows=(value?.windows||[]).filter(w=>['5h','7d','Week'].includes(w.window)||(w.window==='7d-model'&&/^opus(?:\s|$)/i.test(w.model||''))).filter(w=>typeof w.used_pct==='number'&&Number.isFinite(w.used_pct)&&Date.parse(w.resets_at)>now);
    const blocked=fresh&&windows.some(w=>w.used_pct>=100);
    // A subscription that reports no limits is worth trying whenever it is signed in.
    const measured=windows.length>0,available=measured?fresh&&!blocked:ready&&!value.unavailable;
    return {account,value,enabled:ready&&!blocked,available,blocked,room:measured?room(value,now):-1};
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
// Limits other tools showed on screen, as the limit router saw them: chat id → time.
function screenLimits(){try{return JSON.parse(fs.readFileSync(root+'/limit-router.json','utf8')).screens||{};}catch{return {};}}
// A limit stops this session only if it came after the session started; a
// moved Claude chat shares its transcript with the one that stopped.
function stoppedByLimit(info){
  const at=info.tool==='claude'?limitedAt(info.transcript_path):screenLimits()[info.id]||0;
  return at>Date.parse(info.created_at||0)?at:0;
}

// Registers a chat with a title that is free in its folder. Without `base`,
// Agent Deck names it and follows the name the tool shows for it.
async function create(args,account,folder,base,checkpoint=()=>{}){
  if(!base){const created=JSON.parse(await cli(args));catalog.remember({...created,account});return created;}
  let rows=catalog.read(),authoritative=false;
  if(!rows){rows=JSON.parse(await cli(['list','--json']));authoritative=true;}
  for(let attempt=0;attempt<3;attempt++){checkpoint();let name=base,count=2;while(rows.some(s=>s.path===folder&&s.title===name))name=base+' ('+(count++)+')';
    try{const created=JSON.parse(await cli([...args,'-t',name]));catalog.remember({...created,account});return created;}catch(error){const duplicate=/duplicate|already exists|already registered|stale concurrent|database is locked/i.test(error.message);const fresh=JSON.parse(await cli(['list','--json']));if(!duplicate&&authoritative){const committed=fresh.filter(s=>s.path===folder&&s.title===name&&s.account===account&&!rows.some(old=>old.id===s.id));if(committed.length===1){catalog.remember(committed[0]);return committed[0];}}if(!duplicate)throw error;rows=fresh;authoritative=true;}
  }throw new Error('Could not register a new chat');
}

// Whether someone wrote in the conversation after `since`.
function writtenSince(file,since){
  if(!file)return false;
  let fd;
  try{
    fd=fs.openSync(file,'r');const size=fs.fstatSync(fd).size,length=Math.min(size,256*1024),buffer=Buffer.alloc(length);
    fs.readSync(fd,buffer,0,length,size-length);
    return buffer.toString('utf8').split('\n').some(line=>{
      if(!line.includes('"type":"user"'))return false;
      try{const row=JSON.parse(line),content=row.message?.content;return Date.parse(row.timestamp)>since&&!row.isMeta&&(typeof content==='string'||content?.some?.(part=>part.type==='text'));}catch{return false;}
    });
  }catch{return false;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
// Types "continue" once the resumed chat is ready. A busy input box (a draft,
// or a question on screen) is waited out for up to 15 minutes and never
// overwritten; once anyone has written in the chat, there is nothing to send.
let resending=0;
async function resend(id,transcript){
  const since=Date.now();resending++;
  try{
    for(;;){
      if(writtenSince(transcript,since))return;
      try{await cli(['session','send',id,'continue','--no-tag','-q','--timeout','1m'],90000);return;}
      catch(error){if(Date.now()-since>15*60000||!/occupied|unreadable|not ready|timed out|timeout/i.test(error.message)){log('Resend: '+error.message.trim().split('\n').pop());return;}}
      await new Promise(resolve=>setTimeout(resolve,10000));
    }
  }finally{resending--;}
}
// A program waits for its pending "continue" before restarting on new code.
const sending=()=>resending>0;
// The account a chat moves to answers Claude's start-up questions about its
// folder the way the original account did, so the moved chat does not stop
// at one before it can continue: trusting the folder, and loading files that
// its CLAUDE.md files import from outside it. Accounts that were never asked
// about imports load them.
function carryTrust(from,to,folder){
  const read=home=>{try{return JSON.parse(fs.readFileSync(home+'/.claude.json','utf8'));}catch{return null;}};
  const trusted=(config,dir)=>{for(let d=dir;;d=path.dirname(d)){if(config?.projects?.[d]?.hasTrustDialogAccepted)return true;if(d===path.dirname(d))return false;}};
  try{
    const file=to.home+'/.claude.json',target=read(to.home),source=read(from.home);
    if(!target)return;
    const was=source?.projects?.[folder]||{},now=target.projects?.[folder]||{},answers={};
    if(!trusted(target,folder)&&trusted(source,folder))answers.hasTrustDialogAccepted=true;
    if(!now.hasClaudeMdExternalIncludesWarningShown)Object.assign(answers,{hasClaudeMdExternalIncludesWarningShown:true,hasClaudeMdExternalIncludesApproved:Boolean(was.hasClaudeMdExternalIncludesApproved||!was.hasClaudeMdExternalIncludesWarningShown)});
    if(!Object.keys(answers).length)return;
    target.projects={...target.projects,[folder]:{...now,...answers}};
    const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(target,null,2),{mode:fs.statSync(file).mode&0o777});fs.renameSync(temp,file);
  }catch(error){log('Trust: '+error.message);}
}

class MoveRefused extends Error {}
// One move per conversation at a time: the limit router and a panel's chooser
// can both start one for the same chat.
function claimMove(sid){
  const dir=root+'/moves',lock=dir+'/'+sid;
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  try{fs.mkdirSync(lock,{mode:0o700});}catch(error){
    if(error.code!=='EEXIST')throw error;
    let pid=0;try{pid=Number(fs.readFileSync(lock+'/pid','utf8'));}catch{}
    if(pid)try{process.kill(pid,0);return null;}catch{}
    if(!pid&&Date.now()-fs.statSync(lock).mtimeMs<15000)return null;
    fs.rmSync(lock,{recursive:true,force:true});try{fs.mkdirSync(lock,{mode:0o700});}catch{return null;}
  }
  fs.writeFileSync(lock+'/pid',String(process.pid),{mode:0o600});
  return ()=>fs.rmSync(lock,{recursive:true,force:true});
}
// Another running chat already carries this conversation: it was moved
// meanwhile. `continuesAt` names it so a panel can open it instead.
async function movedElsewhere(info,provider,conversation){
  const rows=JSON.parse(await cli(['list','--json'])).filter(r=>r.id!==info.id&&r.tool===info.tool&&!r.archived);
  for(const row of rows){
    const other=row.claude_session_id!==undefined&&info.tool==='claude'?row:JSON.parse(await cli(['session','show',row.id,'--json']));
    if(provider.conversation(other)?.id===conversation.id&&running(other))return other;
  }
  return null;
}
// Whether the deck lets chats work without asking (the setup's choice).
function skipsPermissions(){return /^\[claude\][^\[]*^\s*dangerous_mode\s*=\s*true\b/m.test(fs.readFileSync(root+'/config.toml','utf8'));}
// Moves a chat to another `account` of its subscription. Codex chats switch in
// place; others resume the same saved conversation in a new entry there, and
// the old entry is archived. An interrupted request is sent again.
async function moveChat(info,account,{checkpoint=()=>{},onMoving=()=>{}}={}){
  const source=accountOf(info.account),provider=providers.of(account);
  if(!source||source.provider!==account.provider||!provider.continues)throw new MoveRefused('This chat cannot continue on that account.');
  if(!await providers.signedIn(account))throw new MoveRefused('Sign in to '+account.title+' first.');
  checkpoint();
  const interrupted=Boolean(stoppedByLimit(info));
  if(provider.continues==='codex'){
    const preview=JSON.parse(await cli(['session','switch-preview',info.id,'--to-harness',account.tool,'--to-account',account.slot,'--json']));checkpoint();
    if(preview.refusal||preview.capability!=='native-resume'||preview.execution!=='supported')throw new MoveRefused('This chat cannot be resumed on that account.');
    if(!info.codex_session_id||!info.transcript_path)throw new MoveRefused('This chat has no saved conversation to continue.');
    onMoving();
    let failure;try{await cli(['session','switch',info.id,'--to-harness',account.tool,'--to-account',account.slot,'--json'],120000);}catch(error){failure=error;}
    const changed=JSON.parse(await cli(['session','show',info.id,'--json']));
    if(failure)log('Continue: '+failure.message);
    if(changed.account!==account.slot)throw new MoveRefused('Could not switch. r Return to your chat.');
    if(failure)throw new MoveRefused('Switch needs recovery. r Return to your chat.');
    if(interrupted)void resend(info.id);
    return changed;
  }
  const conversation=provider.conversation(info);
  if(!conversation)throw new MoveRefused('This chat has no saved conversation to continue.');
  if(!provider.shares(source,account,info))throw new MoveRefused('This account cannot access the saved conversation.');
  const release=claimMove(conversation.id);
  if(!release)throw new MoveRefused('This chat is already moving to another account.');
  try{
    const elsewhere=await movedElsewhere(info,provider,conversation);
    if(elsewhere)throw Object.assign(new MoveRefused('This chat already continues on another account.'),{continuesAt:elsewhere.id});
    onMoving();
    // Named as before, without the number an earlier move added.
    const created=await create(['add',info.path,'-c',account.tool,'-g',info.group,'--account',account.slot,'--no-parent','--json'],account.slot,info.path,(info.title||'New conversation').replace(/ \(\d+\)$/,''),checkpoint);
    try{
      await cli(['session','set-title-lock',created.id,'off','--json']);
      // The resumed chat starts like a new one: the account's own model, and
      // no permission prompts only when the deck is set to skip them.
      await cli(['session','set',created.id,'command',provider.resume(conversation.id,skipsPermissions()),'--json']);
      if(provider.sessionField)await cli(['session','set',created.id,provider.sessionField,conversation.id,'--json']);
      if(account.tool==='claude')carryTrust(source,account,info.path);
      // Stop the old writer before opening the same saved conversation
      // elsewhere. A chat stopped by its limit may have ended already.
      if(running(info))await cli(['session','stop',info.id,'--json'],60000).catch(error=>{if(!/is not running/.test(error.message))throw error;});
    }catch(error){
      // Nothing new has started: drop the half-made entry so a retry starts clean.
      await cli(['remove',created.id]).catch(()=>{});
      throw error;
    }
    let launchError;try{await cli(['session','start',created.id,'--no-wait','--json'],60000);}catch(error){launchError=error;}
    const target=JSON.parse(await cli(['session','show',created.id,'--json']));
    if(!running(target)){if(launchError)log('Continue: '+launchError.message);throw new MoveRefused('Chat saved on '+account.name+' but did not start. Open it to retry.');}
    if(interrupted)void resend(created.id,conversation.file);
    // Keep one entry per conversation; the old one stays recoverable in the archive.
    await cli(['session','archive',info.id,'--json'],60000).catch(error=>log('Archive: '+error.message.replace(/\s+/g,' ')));
    return target;
  }finally{release();}
}

// Moves a chat its limit stopped to the account of its subscription with the
// most room left, passing over accounts not signed in. `avoid(slot)` leaves
// out accounts that reached their limit a moment ago; `onMoving(account)` is
// told where it goes as the move starts. Returns the account and the chat as
// it continues there.
async function moveToBest(info,{avoid=()=>false,onMoving=()=>{},checkpoint}={}){
  const source=accountOf(info.account),kind=source?providers.of(source).name:'other';
  const ranked=choices(info,await refreshedUsage()).filter(c=>c.available&&!avoid(c.account.slot)).sort((a,b)=>b.room-a.room);
  if(!ranked.length)throw new MoveRefused('No other '+kind+' account has room.');
  for(const {account} of ranked){
    try{return {account,chat:await moveChat(info,account,{checkpoint,onMoving:()=>onMoving(account)})};}
    catch(error){if(!(error instanceof MoveRefused)||!/^Sign in/.test(error.message))throw error;}
  }
  throw new MoveRefused('No signed-in '+kind+' account has room.');
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

module.exports={cli,running,skipsPermissions,choices,refreshedUsage,limitedAt,stoppedByLimit,create,resend,sending,moveChat,moveToBest,MoveRefused,panesShowing,repointPanels};
