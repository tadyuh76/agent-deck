const fs=require('fs'),path=require('path');
const {home}=require('./paths');
const config=fs.readFileSync(__dirname+'/config.toml','utf8');
const defaultFolder=JSON.parse(config.match(/^default_path\s*=\s*(".*")$/m)[1]);
function display(folder){return folder===home?'~':folder.startsWith(home+'/')?'~'+folder.slice(home.length):folder;}
function resolve(value){const text=value.trim();return path.resolve(defaultFolder,text==='~'?home:text.startsWith('~/')?home+text.slice(1):text);}
function suggestions(value){
  const text=value.trim(),target=resolve(text);let directory,prefix;
  try{if(!text||text.endsWith('/')||fs.statSync(target).isDirectory()){directory=target;prefix='';}}catch{}
  if(!directory){directory=path.dirname(target);prefix=path.basename(target);}
  try{return fs.readdirSync(directory,{withFileTypes:true}).filter(entry=>{
    if(!entry.name.toLowerCase().startsWith(prefix.toLowerCase())||(entry.name.startsWith('.')&&!prefix.startsWith('.')))return false;
    if(entry.isDirectory())return true;
    try{return entry.isSymbolicLink()&&fs.statSync(path.join(directory,entry.name)).isDirectory();}catch{return false;}
  }).map(entry=>({name:entry.name+'/',value:display(path.join(directory,entry.name))+'/'})).sort((a,b)=>a.name.slice(0,-1).localeCompare(b.name.slice(0,-1),undefined,{numeric:true,sensitivity:'base'}));}catch{return [];}
}
module.exports={defaultFolder,display,resolve,suggestions};
