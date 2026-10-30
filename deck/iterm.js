// Requests to the deck controller (iterm.py), which arranges the deck windows of the Agent Deck app.
const net=require('net');
const {root}=require('./paths');
const socket=root+'/iterm.sock';
function send(payload,timeout){return new Promise((resolve,reject)=>{
  const connection=net.createConnection(socket);let data='';
  const timer=setTimeout(()=>{connection.destroy();reject(new Error('The deck controller did not answer'));},timeout);
  connection.on('connect',()=>connection.write(JSON.stringify(payload)+'\n'));
  connection.on('data',chunk=>{data+=chunk;const end=data.indexOf('\n');if(end<0)return;clearTimeout(timer);connection.end();
    try{const reply=JSON.parse(data.slice(0,end));reply.ok?resolve(reply):reject(new Error(reply.error||'The deck controller could not do that'));}catch(error){reject(error);}});
  connection.on('error',error=>{clearTimeout(timer);reject(error);});
});}
const down=error=>['ENOENT','ECONNREFUSED'].includes(error.code);
// The Agent Deck app keeps the controller running while it is open and starts it again within seconds if it stops.
// `wait` is how long to wait for it, in milliseconds.
async function request(payload,timeout=20000,wait=5000){
  for(let attempt=0;;attempt++){
    try{return await send(payload,timeout);}catch(error){if(!down(error)||attempt>=wait/200)throw error;}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
}
module.exports={request};
