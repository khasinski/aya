// Distinct benchmark issuer. Only public requests/identities cross IPC;
// capabilities stay in this process and the real one-use transfer protocol.
const {PtyHostClient}=require('../dist-electron/pty-host-client');
const {performance}=require('node:perf_hooks');
process.once('message',async({entry,requests})=>{
 const client=new PtyHostClient(entry);let announced=false;
 try{
  for(const request of requests){
   await client.spawn(request);
   const until=performance.now()+20000;
   while(!(await client.getBuffer(request.ptyId)).includes('READY:')){
    if(performance.now()>=until)throw Error('Measurement issuer pane readiness timeout');
    await new Promise(resolve=>setTimeout(resolve,5));
   }
  }
  const before=await client.hostStatus(),pids=await Promise.all(requests.map(request=>client.getPid(request.ptyId)));
  const started=performance.now();announced=await client.announceOrdinaryQuit();
  if(!announced)throw Error('Measurement issuer announcement failed');
  const result={before,pids,issuerPid:process.pid,announcementMs:performance.now()-started};
  await new Promise((resolve,reject)=>process.send(result,error=>error?reject(error):resolve()));
 }catch(error){console.error(error);process.exitCode=1;}
 finally{
  if(!announced)await client.shutdown().catch(()=>{});
  client.dispose();client.dropSocket();process.disconnect();
 }
});
