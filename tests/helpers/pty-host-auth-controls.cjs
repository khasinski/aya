const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const {PtyHostClient}=require('../../dist-electron/pty-host-client.js');
const {writeAuthTransferTicket,authTransferTicketPath}=require('../../dist-electron/pty-host-auth-ticket.js');
const {isPtyHostRequest}=require('../../dist-electron/pty-host-protocol.js');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),wait=async f=>{const end=Date.now()+8000;while(!await f()){if(Date.now()>end)throw Error('control fixture readiness timeout');await sleep(5);}};
(async()=>{
 const custom=process.argv[2]==='publish-lost-completion',script=custom?path.resolve(`dist-electron/pty-host-completion-loss-${process.pid}.js`):path.resolve('dist-electron/pty-host.js');
 if(custom){fs.copyFileSync(path.resolve('dist-electron/pty-host.js'),script);fs.appendFileSync(script,`\nconst transferClass=require('./pty-host-auth-transfer').HostAuthTransfer,completeTransfer=transferClass.prototype.complete;let firstCompletion=true;transferClass.prototype.complete=function(...args){const result=completeTransfer.apply(this,args);require('node:fs').appendFileSync(require('node:path').join(process.env.AYA_HOME,'transfer-completions.jsonl'),JSON.stringify({attempt:args[1],receipt:args[2]})+'\\n',{mode:0o600});if(firstCompletion){firstCompletion=false;for(const socket of clients)socket.destroy();}return result;};\n`);}
 const c=new PtyHostClient(script);
 const recovered=[];if(process.argv[2]==='publish-empty-recovered')c.enableCrashRecovery({log:(event,fields)=>recovered.push({event,...fields})});fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true,mode:0o700});let keep=false;
 try{
  await c.spawn({ptyId:'kept',agent:'custom',command:'stty -echo; printf READY_CONTROLS; cat',cwd:process.env.HOME,cols:80,rows:24});await wait(async()=>(await c.getBuffer('kept')).includes('READY_CONTROLS'));
  const mode=process.argv[2];
  if(mode==='publish-empty-recovered'){
   const before=await c.hostStatus();process.kill(before.pid,'SIGKILL');await wait(()=>recovered.some(e=>e.event==='pty-crash-recovery'&&e.state==='recovered'));
   assert.equal((await c.hostStatus()).owner.pid,before.owner.pid);
  }
  if(mode==='publish-empty'||mode==='publish-empty-recovered'){await c.kill('kept');await wait(async()=>!(await c.hostStatus()).owner);}
  const pid=await c.getPid('kept'),status=await c.hostStatus();
  if(mode==='publish'||mode==='publish-lost-completion'||mode==='publish-alive'||mode==='publish-empty'||mode==='publish-empty-recovered'){
   const deadline=Date.now()+120000,nonce='a'.repeat(64),budget=performance.now()+2000;
   const reserved=await c.request({id:0,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce,deadline});
   const t={format:2,...reserved,nonce},file=authTransferTicketPath(process.env.AYA_HOME,t.attempt);
   await writeAuthTransferTicket(file,t,{deadline:budget});assert.equal(await c.request({id:0,type:'auth-transfer-activate',attempt:t.attempt}),true);
   keep=true;process.send({file,pid,hostPid:status.pid,ownerPid:status.owner?.pid??null,...(custom?{script}:{})});
   if(mode==='publish-alive')await new Promise(resolve=>process.once('message',resolve));
  }else if(mode==='ordinary-wins'){
   const reserved=await c.request({id:0,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce:'b'.repeat(64),deadline:Date.now()+120000});
   await assert.rejects(c.request({id:0,type:'handover-prepare',deadline:Date.now()+120000}));assert.equal(await c.request({id:0,type:'auth-transfer-cancel',attempt:reserved.attempt}),'cancelled');
   await c.write('kept','AFTER_REFUSED_FREEZE\n');await wait(async()=>(await c.getBuffer('kept')).includes('AFTER_REFUSED_FREEZE'));assert.equal(await c.getPid('kept'),pid);process.send({ok:true});
  }else if(mode==='core-wins'){
   await c.preparePlannedHandover(Date.now()+120000);await assert.rejects(c.request({id:0,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce:'b'.repeat(64),deadline:Date.now()+120000}));await c.cancelPlannedHandover();
   await c.write('kept','AFTER_REFUSED_RESERVATION\n');await wait(async()=>(await c.getBuffer('kept')).includes('AFTER_REFUSED_RESERVATION'));assert.equal(await c.getPid('kept'),pid);process.send({ok:true});
  }else if(mode==='planned-reserved'||mode==='planned-cancel'||mode==='publish-planned'){
   const deadline=Date.now()+120000,nonce='b'.repeat(64),reserved=await c.request({id:0,type:'auth-transfer-reserve',purpose:'planned-update',nonce,deadline});
   await assert.rejects(c.request({id:0,type:'auth-transfer-activate',attempt:reserved.attempt}),'cannot activate without published core/announcement');
   await c.request({id:0,type:'handover-prepare',deadline,transferAttempt:reserved.attempt});await c.request({id:0,type:'handover-publish',display:null,consented:[]});
   await assert.rejects(c.request({id:0,type:'handover-announce',nonce:'c'.repeat(64),deadline,transferAttempt:reserved.attempt}));
   await c.request({id:0,type:'handover-announce',nonce,deadline,transferAttempt:reserved.attempt});assert.equal(await c.request({id:0,type:'auth-transfer-activate',attempt:reserved.attempt}),true);
   let file;
   if(mode==='planned-cancel'||mode==='publish-planned'){
    const t={format:2,...reserved,nonce};file=authTransferTicketPath(process.env.AYA_HOME,t.attempt);await writeAuthTransferTicket(file,t,{deadline:performance.now()+2000});
   }else assert.equal(await c.request({id:0,type:'auth-transfer-cancel',attempt:reserved.attempt}),'cancelled');
   if(mode==='publish-planned'){keep=true;process.send({file,pid,hostPid:status.pid,ownerPid:status.owner.pid});return;}
   await c.cancelPlannedHandover();
   await c.write('kept','AFTER_PLANNED_ABORT\n');await wait(async()=>(await c.getBuffer('kept')).includes('AFTER_PLANNED_ABORT'));assert.equal(await c.getPid('kept'),pid);
   if(mode==='planned-cancel'||mode==='publish-planned'){keep=true;process.send({file,pid,hostPid:status.pid,ownerPid:status.owner?.pid??null,...(custom?{script}:{})});}else process.send({ok:true});
  }else throw Error('unknown fixture mode');
  for(const type of ['auth-transfer-reserve','auth-transfer-activate','auth-transfer-cancel','auth-transfer-complete'])assert.equal(isPtyHostRequest({id:1,type,attempt:'a'.repeat(64),extra:true}),false);
 }finally{if(!keep)await c.shutdown().catch(()=>{});c.dispose();c.dropSocket();if(custom&&!keep)fs.rmSync(script,{force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
