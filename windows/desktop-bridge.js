const net=require('net');
function request(payload){return new Promise((resolve,reject)=>{
  const connection=net.createConnection(process.env.AGENT_DECK_DESKTOP_SOCKET);let text='';
  const timer=setTimeout(()=>{connection.destroy();reject(new Error('Desktop controller timed out'));},15000);
  connection.on('connect',()=>connection.write(JSON.stringify(payload)+'\n'));
  connection.on('data',chunk=>{text+=chunk;const end=text.indexOf('\n');if(end<0)return;clearTimeout(timer);connection.end();try{const result=JSON.parse(text.slice(0,end));result.ok?resolve(result):reject(new Error(result.error));}catch(error){reject(error);}});
  connection.on('error',error=>{clearTimeout(timer);reject(error);});
});}
module.exports={request};
