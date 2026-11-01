// Claude Code's /resume lists conversations from every folder but opens one
// from another folder only in a new run there: it prints `cd <folder> &&
// claude --resume <id>`, which cannot be run inside a deck chat. The deck does
// it instead: the conversation opens in that panel, in its own folder, on the
// chat's account; one already open in a panel comes forward there. A chat that
// held nothing but the /resume is closed and its empty transcript deleted.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const {mux,logFile}=require('./paths');
const env=require('./terminal-env'),accounts=require('./account-registry').accounts,providers=require('./providers'),folders=require('./folders'),iterm=require('./iterm');
const {cli,running,create,moveChat,MoveRefused,skipsPermissions,panesShowing,repointPanels}=require('./continuation');
// A refusal is acted on only while the person who asked is still looking.
const FRESH=60000;
const REFUSAL=/^<local-command-stdout>\s*This conversation is from a different directory\.\s+To resume, run:\s+cd (.+) (?:&&|;) claude --resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s/;
const log=text=>fs.appendFileSync(logFile,new Date().toISOString()+' Resume: '+text.replace(/\s+/g,' ').trim()+'\n');
const notify=text=>iterm.request({cmd:'notify',text}).catch(()=>{});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function tail(file,bytes){
  let fd;
  try{fd=fs.openSync(file,'r');const size=fs.fstatSync(fd).size,length=Math.min(size,bytes),buffer=Buffer.alloc(length);fs.readSync(fd,buffer,0,length,size-length);return buffer.toString('utf8').split('\n');}
  catch{return [];}finally{if(fd!==undefined)fs.closeSync(fd);}
}
// A folder as the shell reads it from Claude Code's quoted `cd` argument.
function unquote(text){
  let out='';
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==="'"){const end=text.indexOf("'",i+1);if(end<0)return '';out+=text.slice(i+1,end);i=end;}
    else if(c==='"'){for(i++;i<text.length&&text[i]!=='"';i++)out+=text[i]==='\\'?text[++i]??'':text[i];}
    else out+=c==='\\'?text[++i]??'':c;
  }
  return out;
}
// Refusals Claude Code wrote lately at the end of a transcript.
function refusals(file,now=Date.now()){
  const found=[];
  for(const line of tail(file,64*1024)){
    if(!line.includes('from a different directory')||!line.includes('"type":"user"'))continue;
    let row;try{row=JSON.parse(line);}catch{continue;}
    const content=row.message?.content,match=row.type==='user'&&typeof content==='string'&&content.match(REFUSAL);
    if(match&&row.uuid&&now-Date.parse(row.timestamp)<=FRESH)found.push({key:row.uuid,session:path.basename(file,'.jsonl'),folder:unquote(match[1]),id:match[2]});
  }
  return found;
}
// Whether a transcript holds only commands like /resume: no message, no reply.
function onlyCommands(file){
  let text;try{if(fs.statSync(file).size>256*1024)return false;text=fs.readFileSync(file,'utf8');}catch{return false;}
  return text.split('\n').every(line=>{
    if(!line.trim())return true;
    let row;try{row=JSON.parse(line);}catch{return false;}
    if(row.type==='assistant')return false;
    if(row.type!=='user'||row.isMeta)return true;
    const content=row.message?.content;
    return typeof content==='string'&&/^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/.test(content.trim());
  });
}
// The conversation's transcript where `account` reads them.
function transcript(account,id){
  let dir;try{dir=fs.realpathSync(account.home+'/projects');}catch{return null;}
  for(const project of fs.readdirSync(dir)){const file=path.join(dir,project,id+'.jsonl');if(fs.existsSync(file))return file;}
  return null;
}
// The conversation's name: the one given with /rename, else Claude's own.
function titleOf(file){
  let named='',titled='';
  for(const line of tail(file,2*1024*1024).reverse()){
    if(!named&&line.includes('"type":"custom-title"'))try{named=JSON.parse(line).customTitle||'';}catch{}
    if(!titled&&line.includes('"type":"ai-title"'))try{titled=JSON.parse(line).aiTitle||'';}catch{}
    if(named)break;
  }
  return (named||titled||'New conversation').trim().slice(0,80);
}
// The deck chat that carries conversation `id` on `account`: one running
// anywhere; else its saved chat, moved to `account` when it was on another;
// else a new chat in `folder` that resumes it.
async function reach(rows,chat,account,{id,folder}){
  const held=rows.filter(r=>r.tool==='claude'&&r.claude_session_id===id&&!r.archived&&r.id!==chat.id);
  const live=held.find(running);
  if(live)return live;
  const saved=held.sort((a,b)=>Date.parse(b.last_activity_at||0)-Date.parse(a.last_activity_at||0))[0];
  if(saved&&saved.account!==account.slot){
    try{const moved=await moveChat(JSON.parse(await cli(['session','show',saved.id,'--json'])),account);repointPanels(saved.id,moved.id);return moved;}
    catch(error){
      if(!(error instanceof MoveRefused))throw error;
      if(error.continuesAt)return JSON.parse(await cli(['session','show',error.continuesAt,'--json']));
      log('opening '+saved.id+' on its own account: '+error.message);
    }
  }
  if(saved)return saved;
  const file=transcript(account,id),provider=providers.of(account);
  if(!file)throw new MoveRefused(account.name+' cannot open that conversation.');
  const created=await create(['add',folder,'-c',account.tool,'-g',folders.group(folder,account),'--account',account.slot,'--no-parent','--json'],account.slot,folder,titleOf(file));
  try{
    await cli(['session','set-title-lock',created.id,'off','--json']);
    await cli(['session','set',created.id,'command',provider.resume(id,skipsPermissions()),'--json']);
    await cli(['session','set',created.id,provider.sessionField,id,'--json']);
  }catch(error){await cli(['remove',created.id]).catch(()=>{});throw error;}
  return JSON.parse(await cli(['session','show',created.id,'--json']));
}
// Waits for the panels asked to switch to let go of the chat's session.
async function released(chat){
  for(let i=0;i<25;i++){
    let attached='';try{attached=cp.execFileSync(mux,['-u','-L','agent-deck-managed','list-clients','-F','#{client_session}'],{env,encoding:'utf8',timeout:5000});}catch{}
    if(!attached.split('\n').includes(chat.tmux_session))return;
    await sleep(200);
  }
}
async function resume(refusal,file){
  const rows=JSON.parse(await cli(['list','--json']));
  const chat=rows.find(r=>r.tool==='claude'&&r.claude_session_id===refusal.session&&!r.archived);
  // Outside the deck, Claude Code's own advice stands.
  if(!chat)return;
  const account=accounts.find(a=>a.slot===chat.account);
  if(!account||providers.of(account).continues!=='claude')return;
  let isFolder=false;try{isFolder=fs.statSync(refusal.folder).isDirectory();}catch{}
  if(!isFolder){notify('That conversation’s folder no longer exists.');return;}
  const panes=panesShowing(chat),target=await reach(rows,chat,account,refusal);
  const empty=onlyCommands(file),shown=panesShowing(target).filter(p=>!panes.some(q=>q.pid===p.pid));
  log('opening '+refusal.id+' from '+chat.id+' as '+target.id);
  if(shown.length){
    await iterm.request({cmd:'focus',tty:shown[0].tty}).catch(()=>{});
    await iterm.request({cmd:'flash',tty:shown[0].tty}).catch(()=>{});
    if(empty)repointPanels(chat.id,target.id);
  }else if(panes.length)repointPanels(chat.id,target.id,panes);
  else{
    if(!running(target))await cli(['session','start',target.id,'--no-wait','--json'],60000);
    notify('“'+target.title+'” is ready in the list.');
  }
  if(!empty)return;
  if(panes.length&&!shown.length)await released(chat);
  await cli(['remove',chat.id]).catch(error=>log('remove '+chat.id+': '+error.message));
  try{fs.unlinkSync(file);}catch{}
}
// Acts on the refusals in transcripts written lately (`files`), each once:
// `handled` remembers them and `save` keeps that.
async function scan(files,handled,save){
  for(const file of files)for(const refusal of refusals(file)){
    const key='resume:'+refusal.key;
    if(handled[key])continue;
    handled[key]=Date.now();save();
    try{await resume(refusal,file);}
    catch(error){log(error.message);notify(error instanceof MoveRefused?error.message:'Could not open that conversation. Open it from the list.');}
  }
}
module.exports={scan};
