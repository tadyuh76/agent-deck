const fs=require('fs'),os=require('os');
const {logFile}=require('./paths');
const file=require.resolve('./accounts');
const accounts=[],listeners=new Set();
let stamp='',snapshot='',lastError='';
function reload(){
  const stat=fs.statSync(file),nextStamp=stat.mtimeMs+':'+stat.size+':'+stat.ino;
  if(nextStamp===stamp)return false;
  delete require.cache[file];
  // Homes may be written as ~/.claude-name so the same file works for anyone.
  const values=require(file).map(a=>typeof a?.home==='string'?{...a,home:a.home.replace(/^~(?=\/|$)/,os.homedir())}:a);
  if(!Array.isArray(values)||values.some(a=>!a||!['claude','codex'].includes(a.tool)||typeof a.slot!=='string'||typeof a.name!=='string'||typeof a.email!=='string'||typeof a.home!=='string'||typeof a.color!=='string')||new Set(values.map(a=>a.slot)).size!==values.length)throw new Error('Invalid account catalog');
  const next=JSON.stringify(values);
  lastError='';
  stamp=nextStamp;
  if(next===snapshot)return false;
  const previous=new Map(accounts.map(a=>[a.slot,a]));
  const updated=values.map(value=>{
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
refresh();
fs.watchFile(file,{interval:1000,persistent:false},()=>{try{refresh();}catch(error){fs.appendFileSync(logFile,'Account catalog: '+error.message+'\n');}});
module.exports={accounts,refresh,onChange};
