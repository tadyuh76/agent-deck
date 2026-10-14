#!/usr/bin/env node
// The model and effort new chats start with: one choice for Claude accounts
// and one for Codex accounts, written into each such account's own settings.
// Other subscriptions start with their tool's own choice.
// Usage: models.js                         gives accounts without a model the one chosen before (or the setup kit's)
//        models.js --ask                   also asks, in Terminal, for each kind of account not chosen for yet
//        models.js --again                 asks again for each kind of account, for all of its accounts
//        models.js --set <kind> <model> <effort>   the same without asking ("default" leaves either to the tool)
//        models.js --current               the first account of each kind's model and effort, as JSON
//        --suggest <file>                  a setup kit's suggestion, as {"claude":{"model","effort"},…}
const fs=require('fs'),tty=require('tty');
const {accounts}=require('./account-registry'),{withCodex}=require('./codex-app');
const record=__dirname+'/models.json';
const kinds={
  claude:{name:'Claude',own:'Claude Code’s choice',models:async()=>[
    {value:'fable',label:'Fable',about:'the longest, hardest tasks'},
    {value:'opus',label:'Opus',about:'complex work'},
    {value:'sonnet',label:'Sonnet',about:'everyday work'},
    {value:'haiku',label:'Haiku',about:'quick, simple tasks'},
  // Claude Code keeps these between chats; max lasts only one chat.
  ].map(m=>({...m,efforts:['low','medium','high','xhigh']})),current:claudeCurrent,apply:claudeApply},
  codex:{name:'Codex',own:'Codex’s choice',models:codexModels,current:codexCurrent,apply:codexApply},
};
const effortNames={none:'None',minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max',ultra:'Ultra'};
const effortName=effort=>effortNames[effort]||effort;
function modelName(value,models){
  const known=models.find(m=>m.value===value);if(known)return known.label;
  const claude=/^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(value);
  return claude?claude[1][0].toUpperCase()+claude[1].slice(1)+' '+claude[2]+(claude[3]?'.'+claude[3]:''):value;
}

function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return {};}}
function claudeCurrent(home){const s=readJson(home+'/settings.json');return {model:s.model||null,effort:s.effortLevel||null};}
function claudeApply(home,choice,all){
  const file=home+'/settings.json',settings=readJson(file),before=JSON.stringify(settings);
  if(all){
    if(choice.model)settings.model=choice.model;else delete settings.model;
    if(choice.effort){
      settings.effortLevel=choice.effort;
      // An effort set for one model in a chat (/effort) would win over the default.
      for(const [model,value] of Object.entries(settings.modelSettings||{})){
        if(value&&typeof value==='object'){delete value.effortLevel;if(!Object.keys(value).length)delete settings.modelSettings[model];}
      }
      if(settings.modelSettings&&!Object.keys(settings.modelSettings).length)delete settings.modelSettings;
    }else delete settings.effortLevel;
  }else{
    if(choice.model&&!settings.model)settings.model=choice.model;
    if(choice.effort&&!settings.effortLevel)settings.effortLevel=choice.effort;
  }
  if(JSON.stringify(settings)===before)return;
  fs.mkdirSync(home,{recursive:true});fs.writeFileSync(file,JSON.stringify(settings,null,2)+'\n');
}
async function codexCurrent(home){
  const config=(await withCodex(home,request=>request('config/read',{}))).config||{};
  return {model:config.model||null,effort:config.model_reasoning_effort||null};
}
async function codexApply(home,choice,all){
  fs.mkdirSync(home,{recursive:true});
  await withCodex(home,async request=>{
    const config=all?{}:(await request('config/read',{})).config||{},edits=[];
    for(const [key,value] of [['model',choice.model],['model_reasoning_effort',choice.effort]]){
      if(all||(value&&!config[key]))edits.push({keyPath:key,value:value||null,mergeStrategy:'replace'});
    }
    if(edits.length)await request('config/batchWrite',{edits});
  });
}
// The models this account's plan offers, from the first signed-in Codex account.
async function codexModels(list){
  let fallback;
  for(const account of list){
    try{
      const found=await withCodex(account.home,async request=>{
        const signedIn=Boolean((await request('account/read',{refreshToken:false})).account);
        return {signedIn,models:(await request('model/list',{})).data.filter(m=>!m.hidden)};
      });
      if(found.signedIn)return codexOptions(found.models);
      fallback=fallback||found.models;
    }catch{}
  }
  return fallback?codexOptions(fallback):[];
}
function codexOptions(models){return models.map(m=>({value:m.model,label:m.displayName,about:m.description.replace(/\.$/,''),efforts:m.supportedReasoningEfforts.map(e=>e.reasoningEffort)}));}

// Questions go to the Terminal window even when the setup's input is a pipe.
let terminal,lines;
function say(text){fs.writeSync(terminal.fd,text);}
function openTerminal(){
  const fd=fs.openSync('/dev/tty','r+');
  terminal={fd,input:new tty.ReadStream(fd)};
  lines=require('readline').createInterface({input:terminal.input,terminal:false})[Symbol.asyncIterator]();
}
async function ask(question){say(question);const line=await lines.next();return line.done?'':line.value.trim();}
async function pick(question,options,current,own){
  for(;;){
    const answer=await ask('  '+question+' ['+(current?options.find(o=>o.value===current)?.label||current:own)+']: ');
    if(!answer)return current;
    const n=Number(answer),lower=answer.toLowerCase();
    const found=Number.isInteger(n)?options[n-1]:options.find(o=>o.label.toLowerCase()===lower||o.value.toLowerCase()===lower);
    if(found)return found.value;
    say('    Type a number from the list, or press Enter.\n');
  }
}
async function choose(kind,models,current){
  say('\n  '+kind.name+'\n');
  const width=Math.max(...models.map(m=>m.label.length));
  models.forEach((m,i)=>say('    '+String(i+1).padStart(2)+'  '+m.label.padEnd(width)+'  '+m.about+'\n'));
  const listed=models.map(m=>({value:m.value,label:m.label}));
  if(current.model&&!models.some(m=>m.value===current.model))listed.push({value:current.model,label:modelName(current.model,models)});
  const model=await pick('Model',listed,current.model,kind.own);
  // The efforts the chosen model offers (for one not listed, those of the tool's usual models).
  const efforts=models.find(m=>m.value===model)?.efforts||[...new Set(models.flatMap(m=>m.efforts))];
  say('    '+efforts.map((e,i)=>(i+1)+' '+effortName(e)).join('   ')+'\n');
  const effort=await pick('Effort',efforts.map(e=>({value:e,label:effortName(e)})),efforts.includes(current.effort)?current.effort:null,'the model’s default');
  return {model,effort};
}
function describe(kind,choice,models){
  return kind.name+' chats start with '+(choice.model?modelName(choice.model,models):kind.own)+(choice.effort?', '+effortName(choice.effort).toLowerCase()+' effort':'')+'.';
}

async function main(){
  const args=process.argv.slice(2),flag=name=>args.includes(name);
  const suggestFile=args[args.indexOf('--suggest')+1],suggested=flag('--suggest')?readJson(suggestFile):{};
  const present=Object.keys(kinds).filter(kind=>accounts.some(a=>a.provider===kind));
  const of=kind=>accounts.filter(a=>a.provider===kind);
  if(flag('--current')){
    const current={};for(const kind of present)try{current[kind]=await kinds[kind].current(of(kind)[0].home);}catch{}
    console.log(JSON.stringify(current,null,2));return;
  }
  const chosen=readJson(record),save=()=>fs.writeFileSync(record,JSON.stringify(chosen,null,2)+'\n');
  if(flag('--set')){
    const [kindName,model,effort]=args.slice(args.indexOf('--set')+1),kind=kinds[kindName];
    if(!kind||!present.includes(kindName))throw new Error('No '+(kind?.name||kindName)+' accounts here.');
    const models=await kind.models(of(kindName)),offered=models.find(m=>m.value===model);
    if(model!=='default'&&!offered&&!(kindName==='claude'&&/^claude-/.test(model)))throw new Error('Unknown model: '+model+'. Choose from: '+models.map(m=>m.value).join(', ')+', default.');
    const efforts=offered?.efforts||[...new Set(models.flatMap(m=>m.efforts))];
    if(effort!=='default'&&!efforts.includes(effort))throw new Error('Unknown effort: '+effort+'. Choose from: '+efforts.join(', ')+', default.');
    chosen[kindName]={model:model==='default'?null:model,effort:effort==='default'?null:effort};save();
    for(const a of of(kindName))await kind.apply(a.home,chosen[kindName],true);
    console.log(describe(kind,chosen[kindName],models));return;
  }
  const again=flag('--again'),asking=present.filter(kind=>again||(flag('--ask')&&!chosen[kind]));
  if(asking.length){
    openTerminal();
    say('\x1b[36m==>\x1b[0m Default model and effort (Enter keeps what is in brackets)\n');
    say('  New chats start with these. Any chat can still switch with /model.\n');
  }
  const summary=[];
  for(const kindName of present){
    const kind=kinds[kindName],list=of(kindName);
    if(asking.includes(kindName)){
      const models=await kind.models(list);
      if(!models.length){say('\n  '+kind.name+': its models could not be listed; run this again later.\n');continue;}
      let current=chosen[kindName]||suggested[kindName];
      if(!current){try{current=await kind.current(list[0].home);}catch{current={};}}
      chosen[kindName]=await choose(kind,models,{model:current.model||null,effort:current.effort||null});save();
      for(const a of list)await kind.apply(a.home,chosen[kindName],true);
      summary.push(describe(kind,chosen[kindName],models));
    }else{
      // Accounts added later get the same start as the others.
      const choice=chosen[kindName]||suggested[kindName];
      if(choice)for(const a of list)await kind.apply(a.home,choice,false);
    }
  }
  if(asking.length){say('\n'+summary.map(line=>'  '+line+'\n').join(''));terminal.input.destroy();}
}
main().catch(error=>{console.error(error.message);process.exit(1);});
