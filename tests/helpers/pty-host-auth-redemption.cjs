const net=require('node:net'),{createHash}=require('node:crypto');
const {redeemHostCapability}=require('../../dist-electron/pty-host-auth-redemption.js');
const {ownerProcessStartIdentity}=require('../../dist-electron/pty-owner-client.js');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',async()=>{
 const {socket,ticket}=JSON.parse(input),connection=net.createConnection(socket);
 try{
  await new Promise((resolve,reject)=>{connection.once('connect',resolve);connection.once('error',reject);});
  const key=await redeemHostCapability(connection,ticket,{pid:process.pid,startIdentity:ownerProcessStartIdentity(process.pid)});
  try{process.send({success:true,pid:process.pid,hash:createHash('sha256').update(key).digest('hex')});}finally{key.fill(0);}
 }catch{connection.destroy();process.send({success:false,pid:process.pid});}
});
