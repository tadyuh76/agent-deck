// The deck's own settings, switched from a panel (a) or the app's menus:
// whether a chat that reaches its plan limit carries on in another account
// of its subscription by itself.
const fs=require('fs');
const {root}=require('./paths');
const file=root+'/settings.json',DEFAULTS={autoContinue:true};
function read(){try{return {...DEFAULTS,...JSON.parse(fs.readFileSync(file,'utf8'))};}catch{return {...DEFAULTS};}}
function write(values){
  const next={...read(),...values},temp=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);
  return next;
}
module.exports={read,write};
