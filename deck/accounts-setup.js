#!/usr/bin/env node
// The deck's accounts: which subscriptions and accounts it uses, the tools
// they need, a folder of its own for each account's sign-in, and signing in.
// Usage: accounts-setup.js --first      asks, in Terminal, which subscriptions and accounts to use
//        accounts-setup.js --add        asks for one more account
//        accounts-setup.js --prepare    installs missing tools; makes each account's folder and shared history
//        accounts-setup.js --sign-in    signs in each account that is not signed in yet
//        accounts-setup.js --check      lists accounts not signed in yet (exit 3 if any)
//        accounts-setup.js --profiles   the [profiles] part of config.toml
//        accounts-setup.js --homes <tool>   the folders of the accounts whose chats run in <tool>
const fs=require('fs'),os=require('os'),tty=require('tty'),cp=require('child_process');
const providers=require('./providers');
const file=__dirname+'/accounts.js',home=os.homedir();
const colors=['218;119;86','94;202;221','154;201;87','224;106;180','234;181;80','66;133;244','175;135;255','39;199;168','245;153;91','41;181;102'];
const portable=folder=>folder.replace(home,'~'),local=folder=>folder.replace(/^~(?=\/|$)/,home);

function readList(){try{delete require.cache[require.resolve(file)];return require(file).map(a=>({...a}));}catch{return [];}}
function writeList(list){fs.writeFileSync(file,'module.exports='+JSON.stringify(list.map(a=>({...a,home:portable(a.home)})),null,2)+';\n');}
function current(){return readList().map(a=>({...a,home:local(a.home),title:[providers.list[a.provider].name,a.name].filter(Boolean).join(' ')}));}

// Questions go to the Terminal window even when the setup's input is a pipe.
let terminal,lines;
function say(text){if(!terminal)openTerminal();fs.writeSync(terminal.fd,text);}
function openTerminal(){
  const fd=fs.openSync('/dev/tty','r+');
  terminal={fd,input:new tty.ReadStream(fd)};
  lines=require('readline').createInterface({input:terminal.input,terminal:false})[Symbol.asyncIterator]();
}
async function ask(question){say(question);const line=await lines.next();return line.done?'':line.value.trim();}
// A key is typed without showing it.
async function askSecret(question){
  say(question);
  cp.spawnSync('stty',['-echo'],{stdio:[terminal.fd,'ignore','ignore']});
  try{const line=await lines.next();return line.done?'':line.value.trim();}
  finally{cp.spawnSync('stty',['echo'],{stdio:[terminal.fd,'ignore','ignore']});say('\n');}
}
function closeTerminal(){if(terminal){terminal.input.destroy();terminal=null;}}

// A short name shown on its chats, e.g. "Work"; suggested from the email.
async function askName(email,fallback){
  const local=(email.includes('@')?email.split('@')[0]:email).replace(/[^A-Za-z0-9]+/g,' ').trim();
  const suggested=(local?local.replace(/\b\w/g,c=>c.toUpperCase()):fallback).slice(0,12).trim();
  return ((await ask('  Short name for it ['+suggested+']: '))||suggested).slice(0,12);
}
// Adds an account of `id` to `list`, unless it is there already.
function addAccount(list,id,email,name,folder){
  const provider=providers.list[id];
  if(email&&list.some(a=>a.provider===id&&a.email===email))return null;
  const base=name.replace(/[^A-Za-z0-9]/g,'')||'Account',start=id==='claude'?base:provider.name.replace(/[^A-Za-z0-9]/g,'')+(provider.pool?'':'-'+base);
  let slot=start;for(let n=2;list.some(a=>a.slot===slot);n++)slot=start+n;
  const account={name,provider:id,slot,email,color:colors[list.length%colors.length],home:folder||home+'/.'+id+'-'+slot.toLowerCase().replace(/^[^-]*-/,'')};
  list.push(account);return account;
}
// Antigravity keeps one pool of Google accounts, which the deck uses as one
// account; each Google account joins the pool by signing in.
async function askPool(list,id){
  const provider=providers.list[id];
  const account=list.find(a=>a.provider===id)||addAccount(list,id,'','',providers.poolHome(id));
  if(!await providers.signedIn(account)){say('  Each Google account you sign in joins it; when one runs out, chats carry on in the next.\n');return;}
  while(/^y/i.test(await ask('  Add another Google account to '+provider.name+'? [y/N]: '))){closeTerminal();providers.signIn(account);}
}
// Asks for accounts of one subscription until Enter; with one, stops after the first.
async function askAccounts(list,id,one=false){
  const provider=providers.list[id];
  if(provider.pool)return askPool(list,id);
  let first=!list.some(a=>a.provider===id);
  for(;;){
    let email='';
    if(provider.key){
      if(!first&&!one&&!/^y/i.test(await ask('  Another '+provider.name+' account? [y/N]: ')))return;
      email='';
    }else{
      const existing=first&&id==='claude'?claudeDefaultEmail():'';
      const question=first||one?'  '+provider.name+' account email'+(existing?' ['+existing+']':'')+': ':'  Another '+provider.name+" account's email (Enter to finish): ";
      email=(await ask(question))||existing;
      if(!email){if(first||one)say('  Skipped.\n');return;}
      if(!/^[^@\s]+@[^@\s]+$/.test(email)){say('  That is not an email address.\n');continue;}
    }
    const name=await askName(email,'Main');
    // The first Claude account keeps Claude Code's usual folder.
    const account=addAccount(list,id,email,name,id==='claude'&&!list.some(a=>a.provider==='claude')?home+'/.claude':'');
    if(!account){say('  Already added.\n');}
    else if(provider.key){
      say('  Get a key at '+provider.key.url+'\n');
      const key=await askSecret('  Paste its key (hidden): ');
      if(key)providers.saveKey(account,key);else say('  No key yet; add it later with --sign-in.\n');
    }
    first=false;
    if(one)return;
  }
}
function claudeDefaultEmail(){
  try{const out=cp.execFileSync('claude',['auth','status'],{env:{HOME:home,PATH:process.env.PATH},encoding:'utf8',timeout:20000,stdio:['ignore','pipe','ignore']});const s=JSON.parse(out);return s.loggedIn&&s.email||'';}catch{return '';}
}
function menu(){
  const ids=Object.keys(providers.list),width=Math.max(...ids.map(id=>providers.list[id].name.length));
  ids.forEach((id,i)=>{const p=providers.list[id];say('    '+String(i+1).padStart(2)+'  '+p.name.padEnd(width)+'  '+p.company+' · '+p.plans+'\n');});
  return ids;
}
async function first(){
  const list=readList().map(a=>({...a,home:local(a.home)}));
  say('\nAgent Deck runs chats on your AI subscriptions, several accounts each. When a\nchat reaches an account\'s limit, it carries on in another of the same subscription.\n\n  Which subscriptions do you use?\n');
  const ids=menu();
  let picked=[];
  for(;;){
    const answer=await ask('  Their numbers, e.g. 1 3 [1]: ')||'1';
    picked=[...new Set(answer.split(/[\s,]+/).filter(Boolean).map(n=>ids[Number(n)-1]))];
    if(picked.length&&picked.every(Boolean))break;
    say('    Type numbers from the list.\n');
  }
  for(const id of picked){say('\n  '+providers.list[id].name+'\n');await askAccounts(list,id);}
  if(!list.length)throw new Error('Add at least one account.');
  writeList(list);closeTerminal();
}
async function add(){
  const list=readList().map(a=>({...a,home:local(a.home)}));
  say('\n  Which subscription is the new account for?\n');
  const ids=menu();
  let id;
  for(;;){id=ids[Number(await ask('  Number: '))-1];if(id)break;say('    Type a number from the list.\n');}
  await askAccounts(list,id,true);
  writeList(list);closeTerminal();
}
// Each account's folder; the tools its subscriptions need; history shared between
// accounts of a subscription so a chat can move between them.
function prepare(){
  const list=current();
  for(const id of new Set(list.map(a=>a.provider)))providers.install(id);
  for(const account of list)providers.prepare(account);
}
async function signIn(){
  let missing=0;
  for(const account of current()){
    const label=account.title.padEnd(20)+(account.email||'');
    if(await providers.signedIn(account)){say('  signed in      '+label+'\n');continue;}
    const provider=providers.list[account.provider];
    if(provider.key){
      say('  '+account.title+' needs its key. Get one at '+provider.key.url+'\n');
      const key=await askSecret('  Paste it (hidden, Enter to skip): ');
      if(key)providers.saveKey(account,key);
    }else{
      say('  Sign in to '+provider.name+(account.email?' as '+account.email:'')+' ('+account.title+'). '+provider.signInNote+'\n');
      closeTerminal();
      providers.signIn(account);
    }
    if(await providers.signedIn(account)){
      say('  signed in      '+label+'\n');
      if(provider.pool)while(/^y/i.test(await ask('  Add another Google account to '+provider.name+'? [y/N]: '))){closeTerminal();providers.signIn(account);}
    }else{missing++;say('  NOT SIGNED IN  '+label+'\n');}
  }
  closeTerminal();
  return missing;
}
async function check(){
  const missing=[];
  for(const account of current())if(!await providers.signedIn(account))missing.push(account);
  for(const account of missing)console.log('  NOT SIGNED IN  '+account.title.padEnd(20)+(account.email||''));
  return missing.length;
}
function profiles(){return current().map(providers.profile).join('\n');}

async function main(){
  const args=process.argv.slice(2);
  if(args[0]==='--first')return first();
  if(args[0]==='--add')return add();
  if(args[0]==='--prepare')return prepare();
  if(args[0]==='--sign-in'){if(await signIn())process.exitCode=3;return;}
  if(args[0]==='--check'){if(await check())process.exitCode=3;return;}
  if(args[0]==='--profiles')return console.log(profiles());
  if(args[0]==='--homes'){for(const a of current())if(providers.list[a.provider].tool===args[1])console.log(a.home);return;}
  throw new Error('Unknown option');
}
main().catch(error=>{closeTerminal();console.error(error.message);process.exit(1);});
