const fs=require('fs'),os=require('os');
const {logFile}=require('./paths'),providers=require('./providers');
const file=require.resolve('./accounts');
const accounts=[],listeners=new Set();
let stamp='',snapshot='',lastError='';
// The name an account goes by: "Gemini Work" in menus; on chats, Claude
// accounts are plain "Work" and others keep their subscription's name. A pool
// of accounts (Antigravity) goes by its subscription's name alone.
function described(a){
  const provider=providers.of(a),title=[provider.name,a.name].filter(Boolean).join(' ');
  return {...a,tool:provider.tool,title,tag:a.provider==='claude'?a.name:title};
}
function reload(){
  const stat=fs.statSync(file),nextStamp=stat.mtimeMs+':'+stat.size+':'+stat.ino;
  if(nextStamp===stamp)return false;
  delete require.cache[file];
  // Homes may be written as ~/.claude-name so the same file works for anyone.
  const values=require(file).map(a=>typeof a?.home==='string'?{...a,home:a.home.replace(/^~(?=\/|$)/,os.homedir())}:a);
  if(!Array.isArray(values)||values.some(a=>!a||!providers.list[a.provider]||typeof a.slot!=='string'||typeof a.name!=='string'||typeof a.email!=='string'||typeof a.home!=='string'||typeof a.color!=='string')||new Set(values.map(a=>a.slot)).size!==values.length)throw new Error('Invalid account catalog');
  const next=JSON.stringify(values);
  lastError='';
  stamp=nextStamp;
  if(next===snapshot)return false;
  const previous=new Map(accounts.map(a=>[a.slot,a]));
  const updated=values.map(described).map(value=>{
    const account=previous.get(value.slot)||{};
    for(const key of Object.keys(account))if(!(key in value))delete account[key];
    return Object.assign(account,value);
  });
  accounts.splice(0,accounts.length,...updated);
  snapshot=next;
  for(const listener of listeners)listener();
  return true;
}
function refresh(){try{return reload();}catch(error){if(!accounts.length)throw error;if(lastError!==error.message){lastError=error.message;fs.appendFileSync(logFile,'Account catalog: '+error.message+'\n');}return false;}}
function onChange(listener){listeners.add(listener);return ()=>listeners.delete(listener);}
// Each account's name and colour, by slot, as the conversation list shows them.
function labels(){return JSON.stringify(Object.fromEntries(accounts.map(a=>[a.slot,{name:a.tag,color:'#'+a.color.split(';').map(n=>Number(n).toString(16).padStart(2,'0')).join('')}])));}
refresh();
fs.watchFile(file,{interval:1000,persistent:false},()=>{try{refresh();}catch(error){fs.appendFileSync(logFile,'Account catalog: '+error.message+'\n');}});
module.exports={accounts,refresh,onChange,labels};
