const fs=require('fs'),cp=require('child_process');
const paths=require('./paths');
const accounts=require('./account-registry').accounts,env=require('./terminal-env');
const root=__dirname,file=root+'/account-usage.json',lock=root+'/account-usage.lock';
function read(){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return {accounts:{}};}}
function execute(bin,args,environment=env){return new Promise((resolve,reject)=>cp.execFile(bin,args,{env:environment,timeout:25000,maxBuffer:4*1024*1024},(error,out)=>{try{resolve(JSON.parse(out));}catch{reject(error||new Error('No account data'));}}));}
function claudePlan(account,status){
  if(status.subscriptionType!=='team')return status.subscriptionType;
  try{
    const profile=JSON.parse(fs.readFileSync(account.home+'/.claude.json','utf8')).oauthAccount;
    if(profile?.emailAddress!==status.email)return 'team';
    const tier=profile.seatTier;
    if(typeof tier!=='string')return 'team';
    const seat=/(?:^|_)premium(?:_|$)/.test(tier)?'Premium':/(?:^|_)standard(?:_|$)/.test(tier)?'Standard':'';
    return seat?'Team '+seat+(/(?:^|_)nonprofit(?:_|$)/.test(tier)?' (nonprofit)':''):'team';
  }catch{return 'team';}
}
function claudeUsage(account){return new Promise((resolve,reject)=>{
  const environment={...env,CLAUDE_CONFIG_DIR:account.home};
  delete environment.ANTHROPIC_API_KEY;delete environment.CLAUDE_CODE_OAUTH_TOKEN;
  const child=cp.spawn(paths.claude,['-p','--safe-mode','--input-format','stream-json','--output-format','stream-json','--verbose'],{cwd:paths.home,env:environment,stdio:['pipe','pipe','ignore']});
  let buffer='',finished=false;
  const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);child.stdin.end();child.kill();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(new Error('Usage unavailable')),25000);
  child.on('error',finish);child.stdin.on('error',finish);child.on('exit',()=>{if(!finished)finish(new Error('Usage unavailable'));});
  child.stdout.on('data',data=>{buffer+=data;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{
    const message=JSON.parse(line),response=message.response;
    if(message.type!=='control_response'||response?.request_id!=='account-usage')continue;
    const limits=response.response?.rate_limits;
    if(response.subtype!=='success'||!limits)return finish(new Error('Usage unavailable'));
    const windows=[['5h',limits.five_hour],['7d',limits.seven_day]].filter(([,w])=>w&&typeof w.utilization==='number').map(([window,w])=>({window,used_pct:w.utilization,resets_at:w.resets_at}));
    const opus=limits.seven_day_opus;
    if(opus&&typeof opus.utilization==='number')windows.push({window:'7d-model',model:'Opus',used_pct:opus.utilization,resets_at:opus.resets_at});
    for(const w of limits.model_scoped||[])if(typeof w.display_name==='string'&&/^opus(?:\s|$)/i.test(w.display_name)&&typeof w.utilization==='number'&&!opus)windows.push({window:'7d-model',model:w.display_name,used_pct:w.utilization,resets_at:w.resets_at});
    finish(null,{windows,usage_checked_at:Date.now(),updated_at:new Date().toISOString()});
  }catch{}}});
  child.stdin.write(JSON.stringify({type:'control_request',request_id:'account-usage',request:{subtype:'get_usage',skip_behaviors:true}})+'\n');
});}
function codex(account){return new Promise((resolve,reject)=>{
  const child=cp.spawn(paths.codex,['app-server','--listen','stdio://'],{env:{...env,CODEX_HOME:account.home},stdio:['pipe','pipe','ignore']});
  let buffer='',id=0,finished=false;const pending=new Map();
  const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);child.stdin.end();child.kill();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(new Error('Usage unavailable')),25000);
  child.on('error',finish);child.stdin.on('error',finish);child.on('exit',()=>{if(!finished)finish(new Error('Usage unavailable'));});
  function request(method,params){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});child.stdin.write(JSON.stringify({id:n,method,params})+'\n');});}
  child.stdout.on('data',data=>{buffer+=data;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const message=JSON.parse(line),p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(new Error('Usage unavailable')):p.resolve(message.result);}}catch{}}});
  (async()=>{try{
    await request('initialize',{clientInfo:{name:'agent_deck_usage',version:'1.0.0'}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
    const identity=(await request('account/read',{refreshToken:false})).account;
    if(!identity)return finish(null,{status:'signed-out'});
    if(identity.email!==account.email)return finish(null,{status:'mismatch'});
    const result=await request('account/rateLimits/read',{}),bucket=result.rateLimitsByLimitId?.codex||result.rateLimits;
    const windows=[bucket?.primary,bucket?.secondary].filter(w=>w&&typeof w.usedPercent==='number').map(w=>({window:w.windowDurationMins===10080?'Week':w.windowDurationMins===300?'5h':w.windowDurationMins>=1440?Math.round(w.windowDurationMins/1440)+'d':Math.round(w.windowDurationMins/60)+'h',used_pct:w.usedPercent,resets_at:new Date(w.resetsAt*1000).toISOString()}));
    finish(null,{status:'ready',plan:identity.planType,windows,updated_at:new Date().toISOString()});
  }catch(error){finish(error);}})();
});}
async function collect(force){
  const old=read(),now=Date.now(),deep=force||!old.checked_at||now-old.checked_at>300000;
  let native=[];try{native=(await execute(paths.deck,['limits','--json'])).accounts||[];}catch{}
  const entries=await Promise.all(accounts.map(async a=>{
    let value=old.accounts[a.slot];
    if(deep||!value){try{
      if(a.tool==='codex')value=await codex(a);
      else{const status=await execute(paths.claude,['auth','status'],{...env,CLAUDE_CONFIG_DIR:a.home});value={status:!status.loggedIn?'signed-out':status.email!==a.email?'mismatch':'ready',plan:claudePlan(a,status)};if(value.status==='ready'){try{value={...value,...await claudeUsage(a)};}catch{value={...value,windows:old.accounts[a.slot]?.windows||[],usage_checked_at:old.accounts[a.slot]?.usage_checked_at,unavailable:true};}}}
    }catch{value=value?{...value,unavailable:true}:{status:'unavailable'};}}
    if(a.tool==='claude'&&value.status==='ready'){
      const limits=native.find(n=>n.harness===a.tool&&n.name===a.slot);
      if(limits&&Date.parse(limits.updated_at)>(value.usage_checked_at||0)){
        const windows=new Map((value.windows||[]).map(w=>[w.window+(w.model||''),w]));
        for(const w of limits.windows||[])windows.set(w.window,w);
        value={...value,windows:[...windows.values()],updated_at:limits.updated_at,stale:limits.stale};
      }
    }
    return [a.slot,value];
  }));
  const result={refreshed_at:now,checked_at:deep?now:old.checked_at,accounts:Object.fromEntries(entries)};
  const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(result),{mode:0o600});fs.renameSync(temp,file);return result;
}
function refresh(force=false){
  const cache=read();if(!force&&cache.refreshed_at&&Date.now()-cache.refreshed_at<30000)return false;
  try{fs.mkdirSync(lock,{mode:0o700});}catch{try{if(Date.now()-fs.statSync(lock).mtimeMs>60000)fs.rmdirSync(lock);}catch{}return false;}
  const worker=cp.spawn(process.execPath,[__filename,...(force?['--force']:[])],{env,stdio:'ignore',detached:true});worker.on('error',()=>{try{fs.rmdirSync(lock);}catch{}});worker.unref();return true;
}
function countdown(reset,now){
  const minutes=Math.max(1,Math.ceil((reset-now)/60000)),days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60),rest=minutes%60;
  return days?days+'d'+(hours?' '+hours+'h':''):hours?hours+'h'+(rest?' '+rest+'m':''):minutes+'m';
}
// Room left in each limit window, 0–100. A window that has not started or has
// already reset is full; the weekly window is left out when the plan has none.
function windows(value,now){
  const list=value.windows||[],result=[];
  const room=(label,window)=>{
    if(!window||typeof window.used_pct!=='number'||!Number.isFinite(window.used_pct))return;
    const reset=Date.parse(window.resets_at),fresh=!Number.isFinite(reset)||reset<=now;
    result.push({label,left:fresh?100:Math.max(0,Math.min(100,100-window.used_pct)),reset:fresh?null:reset});
  };
  room('5h',list.find(w=>w.window==='5h'));
  let weekly=list.find(w=>['7d','weekly','Week'].includes(w.window)),label='Week';
  const opus=list.find(w=>w.window==='7d-model'&&/^opus(?:\s|$)/i.test(w.model||''));
  if(opus&&(!weekly||opus.used_pct>=weekly.used_pct)){weekly=opus;label='Opus';}
  room(label,weekly);
  // A used-up week leaves no room in the 5h window either.
  if(result.some(p=>p.label!=='5h'&&p.left===0))for(const p of result)if(p.label==='5h'){p.left=0;p.blocked=true;}
  return result;
}
const GREEN='87;199;133',AMBER='234;181;80',RED='232;98;92',TRACK='\x1b[38;5;237m',DIM='\x1b[2m',RESET='\x1b[0m';
// A solid bar of the room left, drawn to an eighth of a cell.
function bar(left,width){
  const color=left<10?RED:left<30?AMBER:GREEN,cells=left/100*width;
  let full=Math.floor(cells),eighths=Math.round((cells-full)*8);
  if(eighths===8){full++;eighths=0;}
  let text='\x1b[38;2;'+color+'m'+'█'.repeat(full),rest=width-full;
  if(eighths&&rest){text+='\x1b[48;5;237m'+' ▏▎▍▌▋▊▉'[eighths]+'\x1b[49m';rest--;}
  return text+TRACK+'█'.repeat(rest)+RESET;
}
// The account's plan, and its limits as one line of usage bars that fits `width`.
function display(value,width=46,now=Date.now()){
  if(!value)return {plan:'',limits:DIM+'Loading limits…'+RESET};
  if(value.status==='signed-out')return {plan:'Signed out',limits:DIM+'Sign in to see limits'+RESET};
  if(value.status==='mismatch')return {plan:'Check account',limits:DIM+'Signed into a different account'+RESET};
  if(value.status!=='ready')return {plan:'',limits:DIM+'Account details unavailable'+RESET};
  const plan=typeof value.plan==='string'?value.plan.charAt(0).toUpperCase()+value.plan.slice(1):'Plan unavailable';
  const parts=windows(value,now);
  if(!parts.length)return {plan,limits:DIM+'Limits not reported yet'+RESET};
  // Same bar width on every account, so the bars line up down the menu.
  const tail=8,size=Math.max(6,Math.min(14,Math.floor((width-3-5-2*(1+tail)-2)/2)));
  const segments=parts.map(p=>{
    // When a window is used up, when it comes back: "↻ 2d 11h", "↻ 21h", "↻ 3h 34m".
    const back=countdown(p.reset,now).replace(/^(\d{2,}h) \d+m$/,'$1');
    const note=p.left>0?Math.round(p.left)+'%':p.blocked?'0%':'↻ '+back;
    return DIM+p.label.padEnd(p.label==='5h'?3:5)+RESET+bar(p.left,size)+' '+(p.left>0?note:'\x1b[38;2;'+RED+'m'+note+RESET)+' '.repeat(Math.max(0,tail-note.length));
  });
  return {plan,limits:segments.join('  ').trimEnd()};
}
module.exports={read,refresh,display};
if(require.main===module)collect(process.argv.includes('--force')).catch(()=>{}).finally(()=>{try{fs.rmdirSync(lock);}catch{}});
