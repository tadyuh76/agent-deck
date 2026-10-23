// The deck windows' panes as each one records itself: its deck window and slot
// (0 is the conversation list, 1–6 the chat panels), its terminal and process,
// and what a chat panel shows. Other deck programs find panels here and send
// them requests.
const fs=require('fs'),cp=require('child_process');
const {root}=require('./paths');
const directory=root+'/panels',WORKSPACE=/^claude-desk(?:-\d+)?$/;
function file(workspace,slot){return directory+'/'+workspace+'/'+slot+'.json';}
function read(workspace,slot){try{return JSON.parse(fs.readFileSync(file(workspace,slot),'utf8'));}catch{return {};}}
function write(workspace,slot,values){
  fs.mkdirSync(directory+'/'+workspace,{recursive:true,mode:0o700});
  const target=file(workspace,slot),temp=target+'.'+process.pid+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify({...read(workspace,slot),...values},null,2),{mode:0o600});fs.renameSync(temp,target);}finally{try{fs.unlinkSync(temp);}catch{}}
}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
// Chat panels running now, in one deck window or all of them.
function live(workspace){
  let workspaces;try{workspaces=fs.readdirSync(directory).filter(w=>WORKSPACE.test(w)&&(!workspace||w===workspace));}catch{return [];}
  const found=[];
  for(const w of workspaces)for(let slot=1;slot<=6;slot++){const s=read(w,slot);if(s.pid&&s.tty&&alive(s.pid))found.push({...s,workspace:w,slot});}
  return found;
}
// The terminal this process runs in.
function terminal(){try{return cp.execFileSync('/usr/bin/tty',{stdio:['inherit','pipe','ignore'],encoding:'utf8'}).trim();}catch{return '';}}
// Only signal a process that is still that panel.
// ps warns about the tty size on stderr; keep that out of the desktop log.
function owns(panel){try{const [tty,...command]=cp.execFileSync('/bin/ps',['-o','tty=,command=','-p',String(panel.pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split(/\s+/);return panel.tty.endsWith(tty)&&command.join(' ').includes('panel.js');}catch{return false;}}
// Asks a panel to open a chat ({open:id}), show its account menu ({menu:true}) or continue its chat on another account ({continue:true}).
function request(panel,values){
  if(!owns(panel))return false;
  const target=directory+'/'+panel.workspace+'/'+panel.slot+'.request.json',temp=target+'.'+process.pid+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(values),{mode:0o600});fs.renameSync(temp,target);
  process.kill(panel.pid,'SIGUSR2');return true;
}
function takeRequest(workspace,slot){const target=directory+'/'+workspace+'/'+slot+'.request.json';try{const value=JSON.parse(fs.readFileSync(target,'utf8'));fs.unlinkSync(target);return value;}catch{return null;}}
module.exports={read,write,live,terminal,request,takeRequest,WORKSPACE};
