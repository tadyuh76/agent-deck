// The AI subscriptions a deck account can use, and what each needs: the
// agent-deck tool its chats run in, the program to install, how one
// account's sign-in is kept apart from another's, how it signs in, and how a
// chat carries on in another account of the same subscription.
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const paths=require('./paths');
const home=os.homedir();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);}
function env(){return require('./terminal-env');}
function run(bin,args,extra={},timeout=20000){
  return new Promise(resolve=>cp.execFile(bin,args,{env:{...env(),...extra},timeout,maxBuffer:4*1024*1024},(error,stdout)=>resolve(error?null:stdout)));
}
// Links `inside` to `shared`, keeping what was there; history kept in one place
// lets a chat move between accounts.
function share(inside,shared){
  fs.mkdirSync(shared,{recursive:true});
  if(path.resolve(inside)===path.resolve(shared))return;
  try{if(fs.realpathSync(inside)===fs.realpathSync(shared))return;}catch{}
  fs.mkdirSync(path.dirname(inside),{recursive:true});
  let stat=null;try{stat=fs.lstatSync(inside);}catch{}
  if(stat?.isSymbolicLink())fs.unlinkSync(inside);
  else if(stat){cp.spawnSync('cp',['-Rn',inside+'/',shared+'/']);fs.renameSync(inside,inside+'.before-deck-'+Date.now());}
  fs.symlinkSync(shared,inside);
}
function sameFolder(a,b){try{return fs.realpathSync(a)===fs.realpathSync(b);}catch{return false;}}
// Runs a program in the Terminal, for signing in.
function interactive(bin,args,extra){cp.spawnSync(bin,args,{stdio:'inherit',env:{HOME:home,PATH:paths.binPath,TERM:process.env.TERM||'xterm-256color',LANG:'en_US.UTF-8',...extra}});}
function located(provider){return [paths.program(provider.bin),...(provider.where||[])].find(file=>fs.existsSync(file));}
function folder(account){fs.mkdirSync(account.home,{recursive:true,mode:0o700});}
const toml=value=>JSON.stringify(value);
// An account's own variables in config.toml, for tools without a config_dir setting.
function envProfile(account,values){const set=Object.entries(values).filter(([,v])=>v);return '    [profiles.'+account.slot+']'+(set.length?'\n      env = { '+set.map(([k,v])=>k+' = '+toml(v)).join(', ')+' }':'');}

// Claude Code, signed in to an Anthropic account.
const claudeCode={
  tool:'claude',bin:'claude',install:'curl -fsSL https://claude.ai/install.sh | bash',
  namesChats:true,continues:'claude',sessionField:'claude-session-id',
  conversation:info=>{const id=info.claude_session_id;return UUID.test(id||'')&&info.transcript_path&&path.basename(info.transcript_path)===id+'.jsonl'?{id,file:info.transcript_path}:null;},
  // Every Claude Code account reads and writes one transcripts folder.
  shares:(source,target,info)=>sameFolder(source.home+'/projects',target.home+'/projects')&&fs.realpathSync(info.transcript_path).startsWith(fs.realpathSync(source.home+'/projects')+'/'),
  resume:(id,skip)=>'claude --resume '+id+(skip?' --dangerously-skip-permissions':''),
  prepare:account=>{folder(account);share(account.home+'/projects',home+'/.claude/projects');},
  profile:account=>'    [profiles.'+account.slot+'.claude]\n      config_dir = '+toml(account.home),
};
// A subscription reached through Claude Code at its own Anthropic-compatible
// address: the account's Claude Code settings hold the address, key and models.
function throughClaude(details){
  const keyEnv=details.keyEnv||'ANTHROPIC_AUTH_TOKEN';
  const endpoint=(account,key)=>{
    const file=account.home+'/settings.json',settings=readJson(file)||{};
    const {ANTHROPIC_AUTH_TOKEN,ANTHROPIC_API_KEY,...rest}=settings.env||{},saved=key||settings.env?.[keyEnv];
    settings.env={...rest,ANTHROPIC_BASE_URL:details.baseUrl,...details.env,...(saved?{[keyEnv]:saved}:{})};
    writeJson(file,settings);
    // A key needs no sign-in: skip Claude Code's welcome, and approve the key
    // so it is not asked about on the first chat.
    const configFile=account.home+'/.claude.json',config=readJson(configFile)||{};
    config.hasCompletedOnboarding=true;
    if(saved&&keyEnv==='ANTHROPIC_API_KEY'){const tail=saved.slice(-20),answers=config.customApiKeyResponses||{};config.customApiKeyResponses={approved:[...new Set([...(answers.approved||[]),tail])],rejected:(answers.rejected||[]).filter(k=>k!==tail)};}
    writeJson(configFile,config);
  };
  return {
    ...claudeCode,...details,
    key:{url:details.keyUrl},
    signedIn:async account=>Boolean(readJson(account.home+'/settings.json')?.env?.[keyEnv]),
    saveKey:(account,key)=>{folder(account);endpoint(account,key);},
    prepare:account=>{claudeCode.prepare(account);endpoint(account);},
  };
}
// A tool that signs in with a key kept in the account's folder and given to its chats.
function withKey(details){
  const keyFile=account=>account.home+'/key',read=account=>{try{return fs.readFileSync(keyFile(account),'utf8').trim();}catch{return '';}};
  return {
    namesChats:false,...details,
    key:{url:details.keyUrl},
    signedIn:async account=>Boolean(read(account)),
    saveKey:(account,key)=>{folder(account);fs.writeFileSync(keyFile(account),key+'\n',{mode:0o600});},
    prepare:folder,
    profile:account=>envProfile(account,{...(details.homeEnv?{[details.homeEnv]:account.home}:{}),[details.keyEnv]:read(account)}),
  };
}

// Google Antigravity's agy, with a pool of Google accounts kept by the
// Antigravity account switcher (github.com/muriel-gasparini/antigravity-account-switcher).
// One deck account stands for the whole pool: with auto-continue on, its chats
// run through the switcher (agy-chat), and a request that finds one account
// used up moves to the next by itself, without restarting anything.
const switcher={
  bin:home+'/.local/bin/antigravity-account-switcher',
  source:home+'/.local/share/antigravity-account-switcher',
  config:home+'/.config/antigravity-account-switcher',
};
// The pool's Google accounts, as the switcher lists them.
async function poolAccounts(){
  const out=await run(switcher.bin,['list-accounts'],{},20000);
  return (out||'').split('\n').filter(line=>/^\S+\s+[^\s@]+@\S+/.test(line)).length;
}
// The room left in the 5-hour and weekly windows of the account the pool uses
// now, for the scarcer of agy's two model families, as agy reports it.
async function agyLimits(){
  const out=await run(switcher.bin,['wrap','--',located(list.antigravity),'-p','/quota'],{},60000);
  const windows=new Map();
  for(const line of (out||'').split('\n')){
    const [,limit,left,reset]=line.split('\t');
    if(!left||!/%$/.test(left))continue;
    const window=/five hour/i.test(limit)?'5h':/week/i.test(limit)?'Week':null,used=100-parseFloat(left);
    if(window&&Number.isFinite(used)&&!(windows.get(window)?.used_pct>=used))windows.set(window,{window,used_pct:used,resets_at:reset});
  }
  if(!windows.size)throw new Error('Usage unavailable');
  const count=await poolAccounts();
  return {windows:[...windows.values()],plan:count===1?'1 Google account':count+' Google accounts',updated_at:new Date().toISOString()};
}
// Installs the switcher from its source, with the sign-in details agy itself uses.
function installSwitcher(){
  if(!fs.existsSync(switcher.source+'/bin/antigravity-account-switcher')){
    console.log('  Installing the Antigravity account switcher…');
    if(!fs.existsSync(switcher.source))cp.execFileSync('git',['clone','-q','https://github.com/muriel-gasparini/antigravity-account-switcher.git',switcher.source],{stdio:'inherit',env:{...process.env,PATH:paths.binPath}});
    cp.execFileSync('make',['build'],{cwd:switcher.source,stdio:'ignore',env:{...process.env,PATH:paths.binPath}});
  }
  const credentials=switcher.config+'/oauth.env';
  if(!fs.existsSync(credentials)){
    const text=fs.readFileSync(located(list.antigravity),'latin1');
    const id=text.match(/\d+-[a-z0-9_]+\.apps\.googleusercontent\.com/)?.[0],secret=text.match(/GOCSPX-[A-Za-z0-9_-]{28}/)?.[0];
    if(!id||!secret)throw new Error('Could not read Antigravity sign-in details from agy.');
    fs.mkdirSync(switcher.config,{recursive:true,mode:0o700});
    fs.writeFileSync(credentials,'export ANTIGRAVITY_CLIENT_ID='+id+'\nexport ANTIGRAVITY_CLIENT_SECRET='+secret+'\n',{mode:0o600});
  }
  if(!fs.existsSync(switcher.bin)){
    fs.mkdirSync(path.dirname(switcher.bin),{recursive:true});
    fs.writeFileSync(switcher.bin,'#!/bin/zsh\numask 077\nsource "$HOME/.config/antigravity-account-switcher/oauth.env"\nexec "$HOME/.local/share/antigravity-account-switcher/bin/antigravity-account-switcher" "$@"\n',{mode:0o755});
  }
}

const list={
  claude:{
    ...claudeCode,name:'Claude',company:'Anthropic',plans:'Pro, Max, Team, Enterprise',
    signInNote:'A browser window opens.',
    signedIn:async account=>{const out=await run(paths.claude,['auth','status'],{CLAUDE_CONFIG_DIR:account.home});try{const s=JSON.parse(out);return Boolean(s.loggedIn&&s.email===account.email);}catch{return false;}},
    signIn:account=>interactive(paths.claude,['auth','login','--email',account.email],{CLAUDE_CONFIG_DIR:account.home}),
  },
  codex:{
    name:'Codex',company:'OpenAI',plans:'ChatGPT Plus, Pro, Business, Enterprise',
    tool:'codex',bin:'codex',install:'brew install --cask codex',namesChats:true,continues:'codex',
    // Codex's own limit banner ("■ You've hit your usage limit…"), not a chat that mentions it.
    limitText:/^\s*■\s*You['’]ve hit your usage limit/im,
    signInNote:'A browser window opens.',
    signedIn:async account=>{try{return (await require('./codex-app').email(account.home))===account.email;}catch{return false;}},
    signIn:account=>interactive(paths.codex,['login'],{CODEX_HOME:account.home}),
    prepare:folder,
    profile:account=>'    [profiles.'+account.slot+'.codex]\n      config_dir = '+toml(account.home),
  },
  copilot:{
    name:'Copilot',company:'GitHub',plans:'Pro, Pro+, Max, Business, Enterprise',
    tool:'copilot',bin:'copilot',install:'brew install --cask copilot-cli',namesChats:false,continues:'resume',
    signInNote:'Enter the code it shows at github.com/login/device.',
    signedIn:async account=>{try{return /logged_?in_?users?|last_?logged_?in|"login"\s*:/i.test(fs.readFileSync(account.home+'/config.json','utf8'));}catch{return false;}},
    signIn:account=>interactive(paths.program('copilot'),['login'],{COPILOT_HOME:account.home}),
    // Saved chats are shared, so one can resume in another account.
    prepare:account=>{folder(account);share(account.home+'/session-state',home+'/.copilot/session-state');},
    profile:account=>envProfile(account,{COPILOT_HOME:account.home}),
    conversation:info=>info.copilot_session_id?{id:info.copilot_session_id}:null,
    shares:(source,target)=>sameFolder(source.home+'/session-state',target.home+'/session-state'),
    resume:(id,skip)=>'copilot --resume '+id+(skip?' --yolo':''),
    limitText:/reached your monthly credit limit|out of (AI )?credits/i,
  },
  gemini:{
    name:'Gemini',company:'Google',plans:'Gemini Code Assist Standard, Enterprise',
    tool:'gemini',bin:'gemini',install:'npm install -g --prefix "$HOME/.local" @google/gemini-cli',namesChats:false,continues:'resume',sessionField:'gemini-session-id',
    signInNote:'Sign in in the browser, then type /quit.',
    signedIn:async account=>fs.existsSync(account.home+'/.gemini/oauth_creds.json'),
    signIn:account=>interactive(paths.program('gemini'),[],{GEMINI_CLI_HOME:account.home}),
    prepare:account=>{
      folder(account);share(account.home+'/.gemini/tmp',home+'/.gemini/tmp');
      // Sign in with Google straight away rather than asking how.
      const file=account.home+'/.gemini/settings.json',settings=readJson(file)||{};
      if(!settings.security?.auth?.selectedType){settings.security={...settings.security,auth:{...settings.security?.auth,selectedType:'oauth-personal'}};writeJson(file,settings);}
    },
    profile:account=>envProfile(account,{GEMINI_CLI_HOME:account.home}),
    conversation:info=>info.gemini_session_id?{id:info.gemini_session_id}:null,
    shares:(source,target)=>sameFolder(source.home+'/.gemini/tmp',target.home+'/.gemini/tmp'),
    // Agent Deck resumes the saved session, with the deck's permission setting.
    resume:()=>'gemini',
    limitText:/Usage limit reached for|exhausted your daily quota/i,
  },
  glm:throughClaude({
    name:'GLM',company:'Z.ai',plans:'GLM Coding Plan',plan:'GLM Coding Plan',
    baseUrl:'https://api.z.ai/api/anthropic',keyUrl:'https://z.ai/manage-apikey/apikey-list',
    env:{ANTHROPIC_DEFAULT_OPUS_MODEL:'glm-5.3[1m]',ANTHROPIC_DEFAULT_SONNET_MODEL:'glm-5.3[1m]',ANTHROPIC_DEFAULT_HAIKU_MODEL:'glm-5.3-flash[1m]',API_TIMEOUT_MS:'3000000',CLAUDE_CODE_AUTO_COMPACT_WINDOW:'1000000',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'},
    // The plan's 5-hour window, as Z.ai reports it.
    limits:async account=>{
      const key=readJson(account.home+'/settings.json')?.env?.ANTHROPIC_AUTH_TOKEN;
      const response=await fetch('https://api.z.ai/api/monitor/usage/quota/limit',{headers:{Authorization:key,'Accept-Language':'en-US,en'},signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error('Usage unavailable');
      const body=await response.json(),limits=(body.data||body).limits||[];
      const windows=limits.filter(l=>l.type==='TOKENS_LIMIT'&&typeof l.percentage==='number').map(l=>{
        const reset=typeof l.nextResetTime==='number'?new Date(l.nextResetTime).toISOString():l.nextResetTime;
        return {window:reset&&Date.parse(reset)-Date.now()>86400000?'Week':'5h',used_pct:l.percentage,resets_at:reset};
      });
      return {windows,updated_at:new Date().toISOString()};
    },
  }),
  kimi:throughClaude({
    name:'Kimi',company:'Moonshot AI',plans:'Kimi Code membership',plan:'Kimi Code',
    baseUrl:'https://api.kimi.ai/coding/',keyUrl:'https://www.kimi.com/code/console',keyEnv:'ANTHROPIC_API_KEY',
    env:{ANTHROPIC_MODEL:'k3-256k',ANTHROPIC_DEFAULT_FABLE_MODEL:'k3-256k',ANTHROPIC_DEFAULT_OPUS_MODEL:'k3-256k',ANTHROPIC_DEFAULT_SONNET_MODEL:'k3-256k',ANTHROPIC_DEFAULT_HAIKU_MODEL:'k3-256k',CLAUDE_CODE_SUBAGENT_MODEL:'k3-256k',CLAUDE_CODE_AUTO_COMPACT_WINDOW:'262144',CLAUDE_CODE_MAX_CONTEXT_TOKENS:'262144'},
  }),
  minimax:throughClaude({
    name:'MiniMax',company:'MiniMax',plans:'M Plan',plan:'M Plan',
    baseUrl:'https://api.minimax.io/anthropic',keyUrl:'https://platform.minimax.io/console/plan',
    env:{ANTHROPIC_MODEL:'MiniMax-M3.1-Flash-Preview[1m]',ANTHROPIC_DEFAULT_OPUS_MODEL:'MiniMax-M3.1-Flash-Preview[1m]',ANTHROPIC_DEFAULT_SONNET_MODEL:'MiniMax-M3.1-Flash-Preview[1m]',ANTHROPIC_DEFAULT_HAIKU_MODEL:'MiniMax-M3.1-Flash-Preview[1m]',CLAUDE_CODE_AUTO_COMPACT_WINDOW:'524288'},
  }),
  qwen:throughClaude({
    name:'Qwen',company:'Alibaba Cloud',plans:'Model Studio Coding Plan',plan:'Coding Plan',
    baseUrl:'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',keyUrl:'https://modelstudio.console.alibabacloud.com/?tab=coding-plan',
    env:{ANTHROPIC_MODEL:'qwen3.7-plus',ANTHROPIC_DEFAULT_OPUS_MODEL:'qwen3.7-plus',ANTHROPIC_DEFAULT_SONNET_MODEL:'qwen3.7-plus',ANTHROPIC_DEFAULT_HAIKU_MODEL:'qwen3.7-plus'},
  }),
  synthetic:throughClaude({
    name:'Synthetic',company:'Synthetic',plans:'subscription packs',plan:'Subscription',
    baseUrl:'https://api.synthetic.new/anthropic',keyUrl:'https://synthetic.new/user-settings/api',
    env:{ANTHROPIC_DEFAULT_OPUS_MODEL:'syn:large:vision',ANTHROPIC_DEFAULT_SONNET_MODEL:'syn:large:vision',ANTHROPIC_DEFAULT_HAIKU_MODEL:'syn:small:text',CLAUDE_CODE_SUBAGENT_MODEL:'syn:large:vision'},
  }),
  cursor:withKey({
    name:'Cursor',company:'Anysphere',plans:'Plus, Premium, Super, Ultra',plan:'',
    tool:'cursor',bin:'cursor-agent',install:'curl -fsS https://cursor.com/install | bash',
    keyEnv:'CURSOR_API_KEY',keyUrl:'https://cursor.com/dashboard?tab=integrations',
  }),
  opencode:{
    name:'OpenCode',company:'OpenCode',plans:'Go, Zen, or any provider it signs in to',plan:'',
    tool:'opencode',bin:'opencode',install:'curl -fsSL https://opencode.ai/install | bash && ln -sf "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode"',namesChats:false,
    signInNote:'Choose the provider and sign in.',
    signedIn:async account=>Object.keys(readJson(account.home+'/opencode/auth.json')||{}).length>0,
    signIn:account=>interactive(paths.program('opencode'),['auth','login'],{XDG_DATA_HOME:account.home}),
    prepare:folder,
    profile:account=>envProfile(account,{XDG_DATA_HOME:account.home}),
  },
  droid:withKey({
    name:'Droid',company:'Factory',plans:'Pro, Plus, Max',plan:'',
    tool:'droid',bin:'droid',install:'brew install --cask droid',
    keyEnv:'FACTORY_API_KEY',keyUrl:'https://app.factory.ai/settings/api-keys',
  }),
  kiro:withKey({
    name:'Kiro',company:'Amazon',plans:'Pro, Pro+, Pro Max, Power',plan:'',
    tool:'kiro',bin:'kiro-cli',where:['/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli'],install:'curl -fsSL https://cli.kiro.dev/install | bash',
    keyEnv:'KIRO_API_KEY',keyUrl:'https://kiro.dev/docs/getting-started/authentication/',
  }),
  vibe:withKey({
    name:'Vibe',company:'Mistral',plans:'Le Chat Pro, Team',plan:'',
    tool:'vibe',bin:'vibe',install:'brew install mistral-vibe',
    keyEnv:'MISTRAL_API_KEY',homeEnv:'VIBE_HOME',keyUrl:'https://console.mistral.ai/',
  }),
  antigravity:{
    name:'Antigravity',company:'Google',plans:'Google AI Pro, Ultra, or free',plan:'',pool:true,
    tool:'agy',bin:'agy',install:'curl -fsSL https://antigravity.google/cli/install.sh | bash',namesChats:false,
    signInNote:'A browser window opens.',
    signedIn:async()=>(await poolAccounts())>0,
    signIn:()=>interactive(switcher.bin,['add-account']),
    prepare:account=>{folder(account);installSwitcher();},
    profile:account=>envProfile(account,{}),
    limits:agyLimits,
  },
  amp:withKey({
    name:'Amp',company:'Amp',plans:'Individual, or credits',plan:'',
    tool:'amp',bin:'amp',install:'curl -fsSL https://ampcode.com/install.sh | bash',
    keyEnv:'AMP_API_KEY',keyUrl:'https://ampcode.com/settings',
  }),
};

module.exports={
  list,
  of:account=>list[account.provider],
  // Where a pool's sign-ins live (the switcher's folder).
  poolHome:()=>switcher.config,
  installed:account=>Boolean(located(list[account.provider])),
  signedIn:account=>list[account.provider].signedIn(account),
  signIn:account=>list[account.provider].signIn(account),
  saveKey:(account,key)=>list[account.provider].saveKey(account,key),
  prepare:account=>list[account.provider].prepare(account),
  profile:account=>list[account.provider].profile(account),
  // Installs the program a subscription needs, when missing.
  install:id=>{
    const provider=list[id];
    if(located(provider))return;
    console.log('  Installing '+provider.name+'…');
    cp.execSync(provider.install,{stdio:'inherit',shell:'/bin/zsh',env:{...process.env,PATH:paths.binPath}});
    if(!located(provider))throw new Error(provider.name+' did not install.');
  },
};
