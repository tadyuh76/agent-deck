#!/usr/bin/env node
// Every skill, slash command and plugin a Claude account can use: the skills
// synced from claude.ai, the account's own skills and commands, and those of its
// installed plugins. `node claude-skills.js link` gathers all skill folders into
// one Agent Deck skill source so `agent-deck skill list/attach` sees them too.
const fs=require('fs'),path=require('path'),cp=require('child_process');
const {root,deck}=require('./paths');
const SOURCE='claude-code',linked=root+'/skills/'+SOURCE;
// Commands built into the Claude Code CLI itself.
const BUILTIN=[
  ['clear','Start a new conversation with empty context'],
  ['compact','Summarize the conversation to free context','[instructions]'],
  ['context','Show what is using the context window'],
  ['model','Choose the model','[model]'],
  ['effort','Set reasoning effort','[low|medium|high|xhigh|max]'],
  ['init','Write a CLAUDE.md describing this codebase'],
  ['memory','Edit Claude memory files'],
  ['code-review','Review the current diff for bugs','[level] [--fix|--comment]'],
  ['simplify','Clean up the changed code for reuse and simplicity'],
  ['security-review','Security review of the pending changes'],
  ['review','Review a pull request','[pr]'],
  ['loop','Run a prompt on a recurring interval','[interval] <prompt>'],
  ['schedule','Create or manage scheduled cloud agents'],
  ['fewer-permission-prompts','Allowlist common read-only commands'],
  ['agents','Manage subagents'],
  ['mcp','Manage MCP servers'],
  ['plugin','Manage plugins and marketplaces'],
  ['skills','List available skills'],
  ['hooks','Manage hooks'],
  ['permissions','Manage tool permissions'],
  ['config','Open settings'],
  ['add-dir','Add a working directory','<path>'],
  ['resume','Resume an earlier conversation'],
  ['rename','Rename this conversation','<title>'],
  ['export','Export the conversation'],
  ['usage','Show plan usage limits'],
  ['cost','Show token usage of this session'],
  ['status','Show account, model and connection status'],
  ['doctor','Check the Claude Code installation'],
  ['help','Show help'],
].map(([name,description,hint])=>({name,description,hint:hint||'',kind:'builtin',source:'Claude Code'}));
function read(file){try{return fs.readFileSync(file,'utf8');}catch{return '';}}
function json(file){try{return JSON.parse(read(file));}catch{return null;}}
function dirs(dir){try{return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>e.isDirectory()||e.isSymbolicLink()).map(e=>e.name).filter(n=>!n.startsWith('.'));}catch{return [];}}
function files(dir,ext){try{return fs.readdirSync(dir).filter(n=>n.endsWith(ext)&&!n.startsWith('.'));}catch{return [];}}
// The YAML header of a SKILL.md or command file: plain, quoted and folded values.
function front(text){
  const m=/^---\r?\n([\s\S]*?)\r?\n---/.exec(text),out={};
  if(!m)return out;
  const lines=m[1].split(/\r?\n/);
  for(let i=0;i<lines.length;i++){
    const kv=/^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if(!kv)continue;
    let value=kv[2].trim();
    if(/^[>|][-+]?$/.test(value)){
      const block=[];
      while(i+1<lines.length&&(/^\s/.test(lines[i+1])||!lines[i+1].trim()))block.push(lines[++i].trim());
      value=block.join(value[0]==='>'?' ':'\n').trim();
    }else value=value.replace(/^(["'])([\s\S]*)\1$/,'$2');
    out[kv[1]]=value;
  }
  return out;
}
function skill(dir,name,extra){
  const meta=front(read(dir+'/SKILL.md'));
  if(!Object.keys(meta).length&&!fs.existsSync(dir+'/SKILL.md'))return null;
  return {name:meta.name||name,description:meta.description||'',hint:meta['argument-hint']||'',path:dir,kind:'skill',...extra};
}
function skills(dir,extra,prefix=''){return dirs(dir).map(n=>skill(dir+'/'+n,n,extra)).filter(Boolean).map(s=>({...s,name:prefix+s.name}));}
function commands(dir,extra,prefix=''){
  return files(dir,'.md').map(file=>{
    const meta=front(read(dir+'/'+file));
    return {name:prefix+file.slice(0,-3),description:meta.description||'',hint:meta['argument-hint']||'',path:dir+'/'+file,kind:'command',...extra};
  });
}
function agents(dir){return files(dir,'.md').map(f=>front(read(dir+'/'+f)).name||f.slice(0,-3));}
// Synced claude.ai skills live in skills/synced/<org_user>/, one folder each.
function synced(home){
  return dirs(home+'/skills/synced').flatMap(bucket=>skills(home+'/skills/synced/'+bucket,{source:'claude.ai'},'anthropic-skills:'));
}
function plugins(home){
  const installed=json(home+'/plugins/installed_plugins.json')?.plugins||{};
  const enabled=json(home+'/settings.json')?.enabledPlugins||{};
  return Object.entries(installed).map(([id,installs])=>{
    const at=installs[installs.length-1]||{},dir=at.installPath||'';
    const manifest=json(dir+'/.claude-plugin/plugin.json')||{},name=manifest.name||id.split('@')[0];
    const extra={source:name,plugin:id};
    const mcp=json(dir+'/.mcp.json');
    return {
      id,name,marketplace:id.split('@')[1]||'',version:at.version||manifest.version||'',
      description:manifest.description||'',enabled:enabled[id]!==false,path:dir,
      skills:skills(dir+'/skills',extra,name+':'),commands:commands(dir+'/commands',extra,name+':'),
      agents:agents(dir+'/agents'),mcp:Object.keys(mcp?.mcpServers||mcp||{}),
      lsp:!!json(dir+'/.lsp.json')||!!manifest.lspServers,hooks:fs.existsSync(dir+'/hooks/hooks.json'),
    };
  }).sort((a,b)=>a.name.localeCompare(b.name));
}
// Everything one account (CLAUDE_CONFIG_DIR) offers, plus a project's own.
function catalog(home,project){
  const own=[...skills(home+'/skills',{source:'user'}),...commands(home+'/commands',{source:'user'})];
  const local=project?[...skills(project+'/.claude/skills',{source:'project'}),...commands(project+'/.claude/commands',{source:'project'})]:[];
  const list=plugins(home);
  const active=list.filter(p=>p.enabled).flatMap(p=>[...p.skills,...p.commands]);
  return {home,builtin:BUILTIN,skills:[...synced(home),...own,...local].filter(s=>s.kind==='skill'),commands:[...own,...local].filter(s=>s.kind==='command'),plugins:list,all:[...BUILTIN,...local,...own,...synced(home),...active]};
}
// Links every skill folder of the given homes into one Agent Deck source.
// Plugin skills are named plugin-skill so names never clash across plugins.
function link(homes){
  fs.mkdirSync(linked,{recursive:true});
  const want=new Map();
  for(const home of homes){
    for(const s of synced(home))want.set(s.name.replace(/^anthropic-skills:/,''),s.path);
    for(const s of skills(home+'/skills',{}))if(!want.has(s.name))want.set(path.basename(s.path),s.path);
    for(const p of plugins(home))for(const s of p.skills){const n=s.name.replace(':','-');if(!want.has(n))want.set(n,s.path);}
  }
  for(const name of fs.readdirSync(linked)){
    const file=linked+'/'+name;
    if(fs.lstatSync(file).isSymbolicLink()&&want.get(name)!==fs.readlinkSync(file))fs.unlinkSync(file);
  }
  for(const [name,target] of want)if(!fs.existsSync(linked+'/'+name))fs.symlinkSync(target,linked+'/'+name);
  const sources=cp.execFileSync(deck,['skill','source','list'],{encoding:'utf8'});
  if(!new RegExp('^'+SOURCE+'\\s','m').test(sources))cp.execFileSync(deck,['skill','source','add',SOURCE,linked,'--description','Claude Code skills from claude.ai and installed plugins'],{stdio:'ignore'});
  return want.size;
}
// Installs every plugin the official marketplace ships in its own repository
// into each account, so all deck sessions have the same plugins.
const MARKET='claude-plugins-official';
function install(homes){
  const {claude}=require('./paths');
  for(const home of homes){
    const env={...process.env,CLAUDE_CONFIG_DIR:home},run=args=>cp.spawnSync(claude,args,{env,encoding:'utf8',timeout:120000});
    const dir=home+'/plugins/marketplaces/'+MARKET;
    if(!fs.existsSync(dir))run(['plugin','marketplace','add','anthropics/'+MARKET]);
    const listed=new Set((json(dir+'/.claude-plugin/marketplace.json')?.plugins||[]).map(p=>p.name));
    const have=json(home+'/plugins/installed_plugins.json')?.plugins||{};
    const names=[...dirs(dir+'/plugins'),...dirs(dir+'/external_plugins')].filter(n=>listed.has(n)&&!have[n+'@'+MARKET]);
    let failed=0;
    for(const name of names)if(run(['plugin','install',name+'@'+MARKET,'--scope','user']).status!==0){failed++;console.error('Could not install '+name+' for '+home);}
    console.log(path.basename(home)+': '+(names.length-failed)+' plugins installed, '+Object.keys(have).length+' already present');
  }
}
module.exports={catalog,plugins,link,install,front,BUILTIN};
if(require.main===module){
  const homes=require('./account-registry').accounts.filter(a=>a.tool==='claude').map(a=>a.home);
  if(process.argv[2]==='install')install(homes);
  if(['install','link'].includes(process.argv[2]))console.log('Linked '+link(homes)+' skills into '+linked);
  else console.log(JSON.stringify(catalog(process.argv[2]||homes[0],process.argv[3]),null,1));
}
