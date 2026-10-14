// The deck's background watchers (panel-labels.js, limit-router.js): one copy
// of each serves every deck window. A watcher stops when the deck's code
// changes, and each deck's list starts any watcher that is not running, so a
// change reaches them without anyone restarting anything.
const fs=require('fs'),cp=require('child_process');
const {root}=require('./paths');
const lockFor=file=>file.replace(/\.js$/,'.lock');
// The deck's code as of now; panels and watchers restart when it changes.
function codeStamp(){return fs.readdirSync(root).filter(f=>f.endsWith('.js')).map(f=>f+fs.statSync(root+'/'+f).mtimeMs).join();}
function owner(lock){try{const pid=Number(fs.readFileSync(lock+'/pid','utf8'));if(pid){process.kill(pid,0);return pid;}}catch{}return 0;}
// Starts the watcher in `file` unless a copy is running.
function ensure(file,env){
  if(owner(lockFor(file)))return;
  cp.spawn(process.execPath,[file,'--watch'],{env,detached:true,stdio:'ignore'}).unref();
}
// Makes this process the running copy of the watcher in `file`, or returns
// false when another copy runs. It exits on a code change once `idle()` says so.
function claim(file,idle=()=>true){
  const lock=lockFor(file);
  try{fs.mkdirSync(lock,{mode:0o700});}catch(error){
    if(error.code!=='EEXIST')throw error;
    if(owner(lock))return false;
    // A lock without its process number yet belongs to a copy that is starting.
    try{if(!fs.existsSync(lock+'/pid')&&Date.now()-fs.statSync(lock).mtimeMs<15000)return false;}catch{}
    fs.rmSync(lock,{recursive:true,force:true});try{fs.mkdirSync(lock,{mode:0o700});}catch{return false;}
  }
  fs.writeFileSync(lock+'/pid',String(process.pid),{mode:0o600});
  const release=()=>{try{if(fs.readFileSync(lock+'/pid','utf8')===String(process.pid))fs.rmSync(lock,{recursive:true,force:true});}catch{}};
  process.on('exit',release);for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>process.exit(0));
  const startedOn=codeStamp();
  setInterval(()=>{if(idle()&&codeStamp()!==startedOn)process.exit(0);},5000).unref();
  return true;
}
module.exports={codeStamp,ensure,claim};
