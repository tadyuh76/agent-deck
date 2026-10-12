#!/usr/bin/env node
const fs=require('fs'),cp=require('child_process'),readline=require('readline'),path=require('path');
const {root,deck,mux,claude,logFile}=require('./paths');
// One chat panel of a deck window, in its own pane: an account menu
// when empty, or a chat shown through its tmux session.
const slot=Number(process.argv[2]),initial=process.argv[3],workspace=process.env.AGENT_DECK_WORKSPACE||'claude-desk';
const panels=require('./panels');
if(!panels.WORKSPACE.test(workspace)||!(slot>=1&&slot<=6))throw new Error('Invalid panel');
const registry=require('./account-registry'),accounts=registry.accounts,usage=require('./account-usage');
const catalog=require('./session-catalog'),labels=require('./panel-labels');
const env=require('./terminal-env');
const folders=require('./folders');
const {choices:continuationChoices,stoppedByLimit,cli,running,create,resend,moveClaudeChat,MoveRefused,panesShowing,repointPanels}=require('./continuation');
let accountOffset=0,menuScreen=false;
// The chooser is temporary; saved chat history remains in the managed session.
function enterMenu(){if(menuScreen)return;process.stdout.write('\x1b[?1049l\x1b[2J\x1b[3J\x1b[H\x1b[?1049h');menuScreen=true;}
function leaveMenu(){if(!menuScreen)return;process.stdout.write('\x1b[?1049l\x1b[2J\x1b[3J\x1b[H');menuScreen=false;}
process.on('exit',()=>{if(menuScreen)process.stdout.write('\x1b[?1049l\x1b[?25h');});
const accountKey=i=>i===9?0:i+1;
const accountIndex=text=>text==='0'?9:Number(text)-1;
let job=null,editing=false,input='',cursor=0,notice='',lastTitle,matches=[],selected=0,continuation=null,continueRequested=false,pendingOpen=null,prefix=false,recorded={};
class Cancelled extends Error {}
class Queued extends Error {}
function state(){return {path:folders.defaultFolder,...panels.read(workspace,slot)};}
function save(values){panels.write(workspace,slot,values);}
// The pane's title bar; a chat's own tmux session titles it while it shows.
function title(text){if(lastTitle===text)return;lastTitle=text;process.stdout.write('\x1b]0;'+text+'\x07');}
// What this panel shows, for the list and the other deck programs.
function panelState(value,id){const next={view:value,...(id!==undefined?{chatId:id}:{})};if(Object.keys(next).every(k=>recorded[k]===next[k]))return;Object.assign(recorded,next);save(next);}
function inputMode(raw){process.stdin.setRawMode(raw);if(raw)process.stdin.resume();else process.stdin.pause();}
function clearSuggestions(){matches=[];selected=0;}
function chooseSuggestion(){input=matches[selected].value;cursor=input.length;clearSuggestions();notice='';}
function wordLeft(){const before=input.slice(0,cursor),match=before.match(/[\p{L}\p{N}\p{M}]+[^\p{L}\p{N}\p{M}]*$/u);return match?cursor-match[0].length:0;}
function wordRight(){const match=input.slice(cursor).match(/^[^\p{L}\p{N}\p{M}]*[\p{L}\p{N}\p{M}]+/u);return match?cursor+match[0].length:input.length;}
function previousCharacter(){return cursor-(Array.from(input.slice(0,cursor)).at(-1)?.length||0);}
function nextCharacter(){return cursor+(Array.from(input.slice(cursor))[0]?.length||0);}
function render(){if(job)return;enterMenu();panelState(editing?'folder':continuation?'continue':'empty','');const s=state(),width=process.stdout.columns||60,height=process.stdout.rows||24,dim=t=>'\x1b[2m'+t+'\x1b[0m',crop=t=>t.length>width-7?t.slice(0,Math.max(0,width-8))+'…':t;title(continuation?'Continue chat':'Choose account');let lines;
  if(continuation){
    const choices=continuationChoices(continuation),recommended=choices.find(c=>c.recommended),current=accounts.find(a=>a.tool===continuation.tool&&a.slot===continuation.account);
    lines=['',continuation.limited?'  \x1b[38;2;234;181;80m'+(current?.name||continuation.account)+' reached its limit\x1b[0m':'  Continue this chat','',dim('  '+crop(continuation.title)),continuation.limited?dim('  Pick up where it stopped on another account.'):dim('  Current: '+(current?.name||continuation.account)),''];
    for(const c of choices){const a=c.account,n=accountKey(accounts.indexOf(a)),details=usage.display(c.value,width-6);lines.push('  \x1b[38;2;'+a.color+'m'+n+'  '+(a.tool==='claude'?'Claude ':'Codex ')+a.name+'\x1b[0m'+dim(c===recommended?' · Most room':c.blocked?' · Limit reached':''));lines.push('     '+dim(crop(a.email)),'     '+details.limits);}
    lines.push('',recommended?'  \x1b[1mEnter\x1b[0m Continue on '+recommended.account.name:choices.every(c=>c.blocked)?'  All accounts have reached a limit.':'  Choose an account to check availability','  Number Continue   u Refresh   r Open chat   Esc Back');
  }else if(editing){
    const start=Math.max(0,cursor-Math.max(1,width-7)),visible=(start?'…':'')+input.slice(start,start+width-5-(start?1:0));
    lines=['','  Choose folder','','  '+visible,'',dim(matches.length?'  Tab / ↑↓ Select   Enter Choose   Esc Back':'  Tab Folders   Enter Save   Esc Cancel')];
    if(matches.length){const limit=Math.max(1,Math.min(8,(process.stdout.rows||24)-10)),offset=Math.max(0,Math.min(selected-Math.floor(limit/2),matches.length-limit));lines.push('');for(let i=offset;i<Math.min(matches.length,offset+limit);i++)lines.push(i===selected?'  \x1b[38;2;39;199;168m› '+crop(matches[i].name)+'\x1b[0m':'    '+crop(matches[i].name));if(matches.length>limit)lines.push('',dim('  '+(selected+1)+' / '+matches.length));}
  }else{
    const opening='  '+(accounts.length===10?'1–9 / 0':'1–'+accounts.length)+' Open   ↑↓ More',returning=s.lastId?'  r Return   s Continue chat':'';
    const controls=width>=57?[opening+'   f Folder   u Refresh',returning]:[opening,'  f Folder   u Refresh',returning];
    const footer=['',dim('  Folder'),'  '+crop(folders.display(s.path)),'',...controls];
    // Each account takes three lines (name, email, limits), or two without the email when that fits them all.
    const room=height-3-footer.length-1-(notice?2:0),perAccount=Math.floor(room/3)>=accounts.length?3:2;
    const snapshot=usage.read(),visible=Math.max(1,Math.floor(room/perAccount));
    accountOffset=Math.min(accountOffset,Math.max(0,accounts.length-visible));
    lines=['','  Choose an account'+(visible<accounts.length?dim('   '+(accountOffset+1)+'–'+Math.min(accounts.length,accountOffset+visible)+' / '+accounts.length):''),''];
    for(const [i,a] of accounts.entries()){
      if(i<accountOffset||i>=accountOffset+visible)continue;
      const details=usage.display(snapshot.accounts[a.slot],width-6),name=accountKey(i)+'  '+(a.tool==='claude'?'Claude':'Codex')+' '+a.name;
      const plan=details.plan?' · '+details.plan:'',room=Math.max(0,width-4-name.length);
      lines.push('  \x1b[38;2;'+a.color+'m'+name+'\x1b[0m'+dim(plan.length>room?plan.slice(0,Math.max(0,room-1))+'…':plan));
      if(perAccount===3)lines.push('     '+dim(a.email));
      lines.push('     '+details.limits);
    }
    lines.push(...footer);

  }
  if(notice)lines.push('','  '+crop(notice));process.stdout.write('\x1b[?25l\x1b[2J\x1b[H'+lines.join('\r\n')+'\x1b[0m\x1b['+Math.min(height,lines.length+1)+';1H\x1b[?25h');
  if(editing){const start=Math.max(0,cursor-Math.max(1,width-7));process.stdout.write('\x1b[4;'+(3+(start?1:0)+Array.from(input.slice(start,cursor)).length)+'H');}
}
function waiting(text){enterMenu();panelState('opening');process.stdout.write('\x1b[2J\x1b[H\r\n  '+text+'\r\n\r\n  Ctrl+C Cancel\r\n');}
function checkpoint(current){if(current.cancelled)throw new Cancelled();}
function cancel(){
  if(job){if(job.client||job.switching)return;job.cancelled=true;waiting('Canceling…');return;}
  continuation=null;editing=false;notice='';input='';clearSuggestions();inputMode(true);render();
}
async function showContinuation(known){
  const id=state().lastId;if(!id){notice='Open a chat first.';render();return;}
  await perform(async current=>{waiting('Checking this chat…');const info=known?.id===id?known:JSON.parse(await cli(['session','show',id,'--json']));checkpoint(current);
    catalog.remember(info);
    if(!['claude','codex'].includes(info.tool)){notice='Account switching is unavailable for this chat.';return;}
    continuation={...info,limited:Boolean(stoppedByLimit(info))};editing=false;usage.refresh(true);
  });
}
function requestContinuation(){
  if(job){continueRequested=true;if(job.client)leaveChat(job);return;}
  void showContinuation();
}
async function continueOn(choice,current){
  if(!choice.enabled){notice=choice.blocked?'This account has reached its limit.':'Sign in to this account first.';return;}
  const a=choice.account,id=continuation.id;
  waiting('Checking '+a.name+'…');
  const info=JSON.parse(await cli(['session','show',id,'--json']));checkpoint(current);
  if(info.status==='running'&&info.substate!=='usage-limit'&&!stoppedByLimit(info)){notice='Stop the current task before switching.';return;}
  if(a.tool!=='claude'){
    const before=usage.read().checked_at;usage.refresh(true);
    for(let i=0;i<30&&usage.read().checked_at===before;i++){checkpoint(current);await new Promise(resolve=>setTimeout(resolve,500));}
    if(usage.read().accounts[a.slot]?.status!=='ready'){notice='Check this account’s sign-in first.';return;}
  }
  const updated=continuationChoices(info).find(c=>c.account.slot===a.slot);if(!updated?.enabled){notice='This account is unavailable. Choose another.';return;}
  if(a.tool==='claude'){
    try{
      const panes=panesShowing(info),target=await moveClaudeChat(info,a,{checkpoint:()=>checkpoint(current),onMoving:()=>{current.switching=true;process.stdout.write('\x1b[2J\x1b[H\r\n  Continuing on '+a.name+'…\r\n');}});
      save({lastId:target.id,path:info.path});repointPanels(id,target.id,panes,process.pid);
      continuation=null;current.switching=false;await attach(target.id,current,target);
    }catch(error){if(!(error instanceof MoveRefused))throw error;notice=error.message;}finally{current.switching=false;}
    return;
  }
  const interrupted=Boolean(stoppedByLimit(info));
  const preview=JSON.parse(await cli(['session','switch-preview',id,'--to-harness',a.tool,'--to-account',a.slot,'--json']));checkpoint(current);
  if(preview.refusal||preview.capability!=='native-resume'||preview.execution!=='supported'){notice='This chat cannot be resumed on that account.';return;}
  if(!info.codex_session_id||!info.transcript_path){notice='This chat has no saved conversation to continue.';return;}
  current.switching=true;process.stdout.write('\x1b[2J\x1b[H\r\n  Continuing on '+a.name+'…\r\n');
  let failure;try{await cli(['session','switch',id,'--to-harness',a.tool,'--to-account',a.slot,'--json'],120000);}catch(error){failure=error;}finally{current.switching=false;}
  const changed=JSON.parse(await cli(['session','show',id,'--json']));
  if(changed.account!==a.slot){notice='Could not switch. r Return to your chat.';if(failure)fs.appendFileSync(logFile,'Continue: '+failure.message+'\n');return;}
  if(failure){notice='Switch needs recovery. r Return to your chat.';fs.appendFileSync(logFile,'Continue: '+failure.message+'\n');return;}
  if(interrupted)void resend(id);
  continuation=null;save({lastId:id,path:changed.path});await attach(id,current,changed);
}
async function attach(id,current,known){
  checkpoint(current);
  let info=known?.id===id?known:JSON.parse(await cli(['session','show',id,'--json']));checkpoint(current);
  // Save before starting so an interrupted launch can always be resumed.
  save({lastId:id,path:info.path});
  if(!running(info)){
    checkpoint(current);let result,error;try{result=JSON.parse(await cli(['session','start',id,'--no-wait','--json'],60000));}catch(failed){error=failed;}
    checkpoint(current);info=JSON.parse(await cli(['session','show',id,'--json']));
    if(!running(info)){if(result?.status==='queued')throw new Queued();if(error)throw error;throw new Error('Chat did not start');}
  }
  checkpoint(current);panelState('chat',info.id);labels.label(info);
  save({showing:true});leaveMenu();
  // Only release input when the native terminal is ready to take over.
  inputMode(false);
  try{
    let stderr='';current.client=cp.spawn(mux,['-u','-L','agent-deck-managed','attach-session','-t',info.tmux_session],{stdio:['inherit','inherit','pipe'],env});
    current.client.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-8192);});
    await new Promise((resolve,reject)=>{current.client.once('exit',(code,signal)=>{if(code&&!signal&&!current.leaving&&running(info))reject(new Error(stderr.trim()||'Attach failed'));else resolve();});current.client.once('error',reject);});
  }finally{current.client=null;if(terminalGone())process.exit(0);inputMode(true);}
  // Left on purpose, or the chat ended; a closed window keeps it for next time.
  save({showing:false});
}
async function open(index,current){
  const a=accounts[index],s=state();waiting('Opening '+(a.tool==='claude'?'Claude ':'Codex ')+a.name+'…');
  if(a.tool==='claude'){
    const output=await new Promise((resolve,reject)=>cp.execFile(claude,['auth','status'],{env:{...env,CLAUDE_CONFIG_DIR:a.home},timeout:30000},(error,out)=>error?reject(error):resolve(out)));
    checkpoint(current);const status=JSON.parse(output);
    if(!status.loggedIn||status.email!==a.email){notice='Sign in as '+a.email+' in the browser.';return;}
  }
  checkpoint(current);
  const group=s.path===folders.defaultFolder?'Terminals/'+(a.tool==='codex'?'Codex':a.name):'Projects/'+path.basename(s.path);
  const created=await create(['add',s.path,'-c',a.tool,'-g',group,'--account',a.slot,'--no-parent','--json'],a.slot,s.path,'New conversation',()=>checkpoint(current));
  await cli(['session','set-title-lock',created.id,'off','--json']);
  save({lastId:created.id,path:s.path});checkpoint(current);await attach(created.id,current);
}
async function perform(action){
  if(job)return;const current={cancelled:false,client:null};job=current;notice='';
  try{await action(current);}catch(error){notice=current.cancelled||error instanceof Cancelled?'Opening canceled. r Return to your chat.':error instanceof Queued?'Chat queued. r Return when ready.':'Could not open this chat. Press r to retry.';if(!(error instanceof Cancelled))fs.appendFileSync(logFile,'Panel '+slot+': '+error.message+'\n');}
  finally{job=null;lastTitle=null;inputMode(true);if(pendingOpen){const id=pendingOpen;pendingOpen=null;void openInitial(id);}else if(continueRequested){continueRequested=false;void showContinuation();}else render();}
}
function terminalGone(){return process.ppid===1;}
// Stops showing the chat; it keeps running in the background.
function leaveChat(current){
  current.leaving=true;
  cp.execFile(mux,['-u','-L','agent-deck-managed','detach-client','-t',me],{env,timeout:5000},error=>{if(error)current.client?.kill('SIGTERM');});
}
// Requests from the list and the shortcuts: open a chat here, show the menu, or continue on another account.
function takeRequest(){
  const value=panels.takeRequest(workspace,slot);if(!value)return;
  if(value.continue){requestContinuation();return;}
  pendingOpen=value.open||null;
  if(job){if(job.client)leaveChat(job);else if(!job.switching){job.cancelled=true;waiting('Canceling…');}return;}
  if(pendingOpen){const id=pendingOpen;pendingOpen=null;void openInitial(id);return;}
  continuation=null;editing=false;notice='';clearSuggestions();render();
}
// Ctrl+B then a key in the menu: the same deck shortcuts as in a chat.
function deckKey(letter){
  if(letter==='n'){if(!job){continuation=null;editing=false;notice='';clearSuggestions();render();}return;}
  if(letter==='s'){requestContinuation();return;}
  cp.execFile(root+'/workspace.js',['key',letter,me],{env},()=>{});
}
readline.emitKeypressEvents(process.stdin);inputMode(true);
const me=panels.terminal();
save({pid:process.pid,tty:me,view:'empty',chatId:''});recorded={view:'empty',chatId:''};
process.stdin.on('end',()=>process.exit(0));
process.stdout.on('error',()=>process.exit(0));
registry.onChange(()=>{accountOffset=0;if(!job&&!editing)render();});
process.stdin.on('keypress',(text,key)=>{
  if(prefix){prefix=false;if(/^[a-z]$/i.test(text||''))deckKey(text.toLowerCase());return;}
  if(key.ctrl&&key.name==='b'){prefix=true;return;}
  if(registry.refresh())return;
  if(key.ctrl&&key.name==='c'){cancel();return;}if(job){if(key.name==='escape')cancel();return;}
  if(continuation){
    if(key.name==='escape'){continuation=null;notice='';render();return;}
    if(text==='r'){continuation=null;void perform(current=>attach(state().lastId,current));return;}
    if(text==='u'){usage.refresh(true);notice='Refreshing limits…';render();return;}
    const choices=continuationChoices(continuation),choice=key.name==='return'?choices.find(c=>c.recommended):choices.find(c=>accounts.indexOf(c.account)===accountIndex(text));
    if(choice)void perform(current=>continueOn(choice,current));return;
  }
  if(editing){
    if(key.ctrl&&key.name==='u'){input='';cursor=0;clearSuggestions();notice='';render();return;}
    if(key.name==='home'||(key.ctrl&&key.name==='a')){cursor=0;clearSuggestions();render();return;}
    if(key.name==='end'||(key.ctrl&&key.name==='e')){cursor=input.length;clearSuggestions();render();return;}
    if(key.name==='left'||(key.ctrl&&key.name==='b')||(key.meta&&key.name==='b')){cursor=key.meta?wordLeft():previousCharacter();clearSuggestions();render();return;}
    if(key.name==='right'||(key.ctrl&&key.name==='f')||(key.meta&&key.name==='f')){cursor=key.meta?wordRight():nextCharacter();clearSuggestions();render();return;}
    if(key.name==='escape'){if(matches.length)clearSuggestions();else editing=false;notice='';render();return;}
    if(key.name==='tab'||((key.name==='up'||key.name==='down')&&matches.length)){
      if(matches.length){const backward=key.shift||key.name==='up';selected=(selected+(backward?-1:1)+matches.length)%matches.length;}else{matches=folders.suggestions(input);selected=0;notice=matches.length?'':'No matching folders.';}render();return;
    }
    if(key.name==='return'){
      if(matches.length){chooseSuggestion();render();return;}
      const candidate=folders.resolve(input);try{if(fs.statSync(candidate).isDirectory()){save({path:candidate});editing=false;notice='';}else notice='Choose an existing folder.';}catch{notice='Choose an existing folder.';}render();return;
    }
    if(key.name==='backspace'){const previous=key.meta?wordLeft():previousCharacter();input=input.slice(0,previous)+input.slice(cursor);cursor=previous;clearSuggestions();notice='';}
    else if(key.name==='delete'){input=input.slice(0,cursor)+input.slice(nextCharacter());clearSuggestions();notice='';}
    else if(text&&!key.ctrl&&!key.meta&&!/^[\x00-\x1f\x7f]/.test(text)){input=input.slice(0,cursor)+text+input.slice(cursor);cursor+=text.length;clearSuggestions();notice='';}render();return;
  }
  if(key.name==='up'||key.name==='down'){accountOffset=Math.max(0,accountOffset+(key.name==='down'?1:-1));render();return;}
  if(/^\d$/.test(text||'')&&accountIndex(text)>=0&&accountIndex(text)<accounts.length){void perform(current=>open(accountIndex(text),current));return;}
  if(text==='u'){usage.refresh(true);notice='Refreshing limits…';render();return;}
  if(text==='f'){editing=true;input=folders.display(state().path).replace(/\/$/,'')+'/';cursor=input.length;clearSuggestions();notice='';render();return;}
  if(text==='r'&&state().lastId){waiting('Returning to your chat…');void perform(current=>attach(state().lastId,current));}
  if(text==='s'){requestContinuation();return;}
});
process.on('SIGINT',cancel);
process.on('SIGUSR1',requestContinuation);
process.on('SIGUSR2',takeRequest);
process.stdout.on('resize',()=>{if(!job)render();});
// When the deck's code is updated, a panel showing its menu starts again on the new code.
const codeStamp=()=>fs.readdirSync(root).filter(f=>f.endsWith('.js')).map(f=>f+fs.statSync(root+'/'+f).mtimeMs).join();
const startedOn=codeStamp();
let usageStamp=JSON.stringify(usage.read());usage.refresh();
setInterval(()=>{if(!job&&!editing&&!continuation&&codeStamp()!==startedOn)process.exit(75);registry.refresh();usage.refresh();const next=JSON.stringify(usage.read());if(next!==usageStamp){usageStamp=next;if(notice==='Refreshing limits…')notice='';if(!job&&!editing)render();}},2000).unref();
async function openInitial(id){
  waiting('Opening your chat…');
  let info;try{info=JSON.parse(await cli(['session','show',id,'--json']));}catch{}
  if(info&&['claude','codex'].includes(info.tool)&&Date.now()-stoppedByLimit(info)<5*3600000){save({lastId:id,path:info.path});await showContinuation(info);return;}
  await perform(current=>attach(id,current,info));
}
// A deck window that opens again shows the chats its panels showed when it closed.
async function restore(){
  const id=state().lastId;if(!state().showing||!id)return render();
  let info;try{info=JSON.parse(await cli(['session','show',id,'--json']));}catch{}
  if(info&&running(info))return openInitial(id);
  save({showing:false});render();
}
if(initial==='--continue')requestContinuation();else if(initial==='--restore')void restore();else if(initial)void openInitial(initial);else render();
