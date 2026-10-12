const fs=require('fs');
const file=__dirname+'/session-catalog.json',lock=__dirname+'/session-catalog.lock';
function snapshot(){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function read(){const value=snapshot(),age=Date.now()-value?.cached_at;return age>=0&&age<60000&&Array.isArray(value.sessions)?value.sessions:null;}
function row(value){return {id:value.id,title:value.title,path:value.path,account:value.account,tmux_session:value.tmux_session,catalog_observed_at:value.catalog_observed_at};}
function write(update){
  try{fs.mkdirSync(lock,{mode:0o700});}catch{try{if(Date.now()-fs.statSync(lock).mtimeMs>5000)fs.rmdirSync(lock);}catch{}return false;}
  const temp=file+'.'+process.pid+'.tmp';try{const value=update(snapshot());if(!value)return false;fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.renameSync(temp,file);return true;}catch{return false;}finally{try{fs.unlinkSync(temp);}catch{}try{fs.rmdirSync(lock);}catch{}}
}
function replace(sessions,cachedAt){return write(old=>{const entries=new Map(sessions.map(value=>[value.id,row(value)]));for(const value of old?.sessions||[])if(value.catalog_observed_at>cachedAt)entries.set(value.id,row(value));return {cached_at:cachedAt,sessions:[...entries.values()]};});}
function remember(value){return write(old=>{if(!old||!Array.isArray(old.sessions))return null;const entries=new Map(old.sessions.map(value=>[value.id,value]));entries.set(value.id,row({...value,catalog_observed_at:Date.now()}));return {...old,sessions:[...entries.values()]};});}
module.exports={read,replace,remember};
