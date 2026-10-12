// Talks to a Codex account through Codex's own app server.
// Usage: codex-app.js email <home>   prints the email the account in <home> is signed in with
const cp=require('child_process'),paths=require('./paths');
// Runs work(request) against the account in home, then ends the server.
function withCodex(home,work,timeout=25000){return new Promise((resolve,reject)=>{
  const env=require('./terminal-env');
  const child=cp.spawn(paths.codex,['app-server','--listen','stdio://'],{env:{...env,CODEX_HOME:home},stdio:['pipe','pipe','ignore']});
  let buffer='',id=0,finished=false;const pending=new Map();
  const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);child.stdin.end();child.kill();error?reject(error):resolve(value);};
  const timer=setTimeout(()=>finish(new Error('Codex did not answer')),timeout);
  child.on('error',finish);child.stdin.on('error',finish);child.on('exit',()=>{if(!finished)finish(new Error('Codex stopped'));});
  function request(method,params){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});child.stdin.write(JSON.stringify({id:n,method,params})+'\n');});}
  child.stdout.on('data',data=>{buffer+=data;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{const message=JSON.parse(line),p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(new Error(message.error.message||'Codex request failed')):p.resolve(message.result);}}catch{}}});
  (async()=>{try{
    await request('initialize',{clientInfo:{name:'agent_deck',version:'1.0.0'}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
    finish(null,await work(request));
  }catch(error){finish(error);}})();
});}
async function email(home){return (await withCodex(home,request=>request('account/read',{refreshToken:false}))).account?.email||'';}
module.exports={withCodex,email};
if(require.main===module&&process.argv[2]==='email')email(process.argv[3]).then(value=>{if(value)console.log(value);},()=>{});
