const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const {PtyHostClient}=require('../../dist-electron/pty-host-client.js');
const {writeAuthTransferTicket,authTransferTicketPath}=require('../../dist-electron/pty-host-auth-ticket.js');
const {isPtyHostRequest}=require('../../dist-electron/pty-host-protocol.js');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),wait=async f=>{const end=Date.now()+8000;while(!await f()){if(Date.now()>end)throw Error('control fixture readiness timeout');await sleep(5);}};
(async()=>{
 const plannedLoss=process.argv[2]==='publish-planned-mixed-lost',lost=process.argv[2]==='publish-lost-completion'||plannedLoss;
 const completionFile=path.join(process.env.AYA_HOME,'transfer-completions-'+process.pid+'.jsonl');if(lost)process.env.AYA_TEST_COMPLETION_FILE=completionFile;
 const refusal=process.argv[2].startsWith('publish-refusal-'),custom=lost||refusal,script=custom?path.resolve(`dist-electron/pty-host-completion-loss-${process.pid}.js`):path.resolve('dist-electron/pty-host.js');
 if(custom)fs.copyFileSync(path.resolve('dist-electron/pty-host.js'),script);
 if(lost){fs.appendFileSync(script,`\nconst transferClass=require('./pty-host-auth-transfer').HostAuthTransfer,completeTransfer=transferClass.prototype.complete;let firstCompletion=true;transferClass.prototype.complete=function(...args){const result=completeTransfer.apply(this,args);require('node:fs').appendFileSync(process.env.AYA_TEST_COMPLETION_FILE,JSON.stringify({attempt:args[1],receipt:args[2]})+'\\n',{mode:0o600});if(firstCompletion){firstCompletion=false;for(const socket of clients)socket.destroy();}return result;};\n`);}
 if(refusal)fs.appendFileSync(script,`
const originalHandle=handle;handle=async function(req,socket,preparations){if(req.type!=='owner-continuity')return originalHandle(req,socket,preparations);const runtime=require('./pty-owner-runtime').currentOwnerRuntime(),oldUncertain=runtime.record.uncertain,oldIncompatible=runtime.incompatible;try{switch(process.env.AYA_TEST_CONTINUITY_CAUSE){case 'pending':preparations.set(-1,{});break;case 'uncertain':runtime.record.uncertain=['uncertain-fixture'];break;case 'incompatible':runtime.incompatible=true;break;default:throw Error('unknown continuity fixture');}return await originalHandle(req,socket,preparations);}finally{preparations.delete(-1);runtime.record.uncertain=oldUncertain;runtime.incompatible=oldIncompatible;}};
`);
 const c=new PtyHostClient(script),connectWithHostStart=c.connectWithHostStart.bind(c);
 c.connectWithHostStart=async(...args)=>{try{return await connectWithHostStart(...args);}catch(error){if(error.code==='PTY_HOST_START_BLOCKED')require('./pty-host-failure-diagnostics.cjs').creationFailure(process.env.AYA_HOME,error.proof,error);throw error;}};
 const recovered=[];if(process.argv[2]==='publish-empty-recovered')c.enableCrashRecovery({log:(event,fields)=>recovered.push({event,...fields})});fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true,mode:0o700});let keep=false;
 try{
  await c.spawn({ptyId:'kept',agent:'custom',command:process.argv[2]==='publish-planned-ended'?"exec /bin/sh -c 'stty -echo; printf READY_CONTROLS; read line; printf LAST_SUFFIX; exit 23'":'stty -echo; printf READY_CONTROLS; cat',cwd:process.env.HOME,cols:80,rows:24});await wait(async()=>(await c.getBuffer('kept')).includes('READY_CONTROLS'));
  const mode=process.argv[2];
  if(mode==='publish-empty-recovered'){
   const before=await c.hostStatus();process.kill(before.pid,'SIGKILL');await wait(()=>recovered.some(e=>e.event==='pty-crash-recovery'&&e.state==='recovered'));
   assert.equal((await c.hostStatus()).owner.pid,before.owner.pid);
  }
  if(mode==='publish-empty'||mode==='publish-empty-recovered'){await c.kill('kept');await wait(async()=>!(await c.hostStatus()).owner);}
  let endedOrigin;
  if(mode==='publish-ended'||plannedLoss){
   await c.spawn({ptyId:'ended',agent:'custom',command:"exec /bin/sh -c 'stty -echo; printf READY_ENDED; read line; printf LAST_SUFFIX; exit 23'",cwd:process.env.HOME,cols:80,rows:24});
   await wait(async()=>(await c.getBuffer('ended')).includes('READY_ENDED'));
   const state=await c.preparePlannedHandover(Date.now()+120000);endedOrigin=state.eligible.find(p=>p.id==='ended');
   const t=await c.announcePlannedHandover(state,null,[],'d'.repeat(64));await c.adoptPlannedHandover(t,c.expectedHostIdentity('reuse'),async()=>{});
   c.observeExit=()=>{};await c.write('ended','finish\n');await wait(async()=>await c.getPid('ended')===null);
  }
  const pid=await c.getPid('kept'),status=await c.hostStatus();
  if(mode==='publish-planned-ended'){
   const first=await c.preparePlannedHandover(Date.now()+120000);endedOrigin=first.eligible[0];
   const ticket=await c.announcePlannedHandover(first,null,[],'d'.repeat(64));
   await c.adoptPlannedHandover(ticket,c.expectedHostIdentity('reuse'),async()=>{});
   await c.write('kept','finish\n');await wait(async()=>await c.getPid('kept')===null);
  }
  if(mode==='publish-public'||refusal||mode==='publish-ended'){
   assert.equal(await c.announceOrdinaryQuit(),true);await c.write('kept','OUTPUT_DURING_ORDINARY_QUIT\n');await wait(async()=>(await c.getBuffer('kept')).includes('OUTPUT_DURING_ORDINARY_QUIT'));
   const names=fs.readdirSync(process.env.AYA_HOME).filter(name=>/^pty-handover\.[a-f0-9]{64}\.json$/.test(name));assert.equal(names.length,1);keep=true;process.send({file:path.join(process.env.AYA_HOME,names[0]),pid,hostPid:status.pid,ownerPid:status.owner.pid,endedOrigin,...(custom?{script}:{}),...(lost?{completions:completionFile}:{})});
  }else if(mode==='publish'||mode==='publish-lost-completion'||mode==='publish-alive'||mode==='publish-empty'||mode==='publish-empty-recovered'){
   const deadline=Date.now()+120000,nonce='a'.repeat(64),budget=performance.now()+2000;
   const reserved=await c.request({id:0,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce,deadline});
   const t={format:2,...reserved,nonce},file=authTransferTicketPath(process.env.AYA_HOME,t.attempt);
   await writeAuthTransferTicket(file,t,{deadline:budget});assert.equal(await c.request({id:0,type:'auth-transfer-activate',attempt:t.attempt}),true);
   keep=true;process.send({file,pid,hostPid:status.pid,ownerPid:status.owner?.pid??null,...(custom?{script}:{}),...(lost?{completions:completionFile}:{})});
   if(mode==='publish-alive')await new Promise(resolve=>process.once('message',resolve));
  }else if(mode==='ordinary-wins'){
   const reserved=await c.request({id:0,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce:'b'.repeat(64),deadline:Date.now()+120000});
   await assert.rejects(c.request({id:0,type:'handover-prepare',deadline:Date.now()+120000}));assert.equal(await c.request({id:0,type:'auth-transfer-cancel',attempt:reserved.attempt}),'cancelled');
   await c.write('kept','AFTER_REFUSED_FREEZE\n');await wait(async()=>(await c.getBuffer('kept')).includes('AFTER_REFUSED_FREEZE'));assert.equal(await c.getPid('kept'),pid);process.send({ok:true});
  }else if(mode==='core-wins'){
   await c.preparePlannedHandover(Date.now()+120000);await assert.rejects(c.request({id:0,type:'auth-transfer-reserve',purpose:'ordinary-quit',nonce:'b'.repeat(64),deadline:Date.now()+120000}));await c.cancelPlannedHandover();
   await c.write('kept','AFTER_REFUSED_RESERVATION\n');await wait(async()=>(await c.getBuffer('kept')).includes('AFTER_REFUSED_RESERVATION'));assert.equal(await c.getPid('kept'),pid);process.send({ok:true});
  }else if(mode==='planned-reserved'||mode==='planned-cancel'||mode==='publish-planned'||mode==='publish-planned-ended'||plannedLoss){
   const deadline=Date.now()+120000,nonce='b'.repeat(64),reserved=await c.request({id:0,type:'auth-transfer-reserve',purpose:'planned-update',nonce,deadline});
   await assert.rejects(c.request({id:0,type:'auth-transfer-activate',attempt:reserved.attempt}),'cannot activate without published core/announcement');
   await c.request({id:0,type:'handover-prepare',deadline,transferAttempt:reserved.attempt});await c.request({id:0,type:'handover-publish',display:null,consented:[]});
   await assert.rejects(c.request({id:0,type:'handover-announce',nonce:'c'.repeat(64),deadline,transferAttempt:reserved.attempt}));
   await c.request({id:0,type:'handover-announce',nonce,deadline,transferAttempt:reserved.attempt});assert.equal(await c.request({id:0,type:'auth-transfer-activate',attempt:reserved.attempt}),true);
   let file;
   if(mode==='planned-cancel'||mode==='publish-planned'||mode==='publish-planned-ended'||plannedLoss){
    const t={format:2,...reserved,nonce};file=authTransferTicketPath(process.env.AYA_HOME,t.attempt);await writeAuthTransferTicket(file,t,{deadline:performance.now()+2000});
   }else assert.equal(await c.request({id:0,type:'auth-transfer-cancel',attempt:reserved.attempt}),'cancelled');
   if(mode==='publish-planned'||mode==='publish-planned-ended'||plannedLoss){keep=true;process.send({file,pid,hostPid:status.pid,ownerPid:status.owner.pid,endedOrigin,...(custom?{script}:{}),...(lost?{completions:completionFile}:{})});return;}
   await c.cancelPlannedHandover();
   await c.write('kept','AFTER_PLANNED_ABORT\n');await wait(async()=>(await c.getBuffer('kept')).includes('AFTER_PLANNED_ABORT'));assert.equal(await c.getPid('kept'),pid);
   if(mode==='planned-cancel'){
    keep=true;process.send({file,pid,hostPid:status.pid,ownerPid:status.owner.pid});await new Promise(resolve=>process.once('message',resolve));
    assert.equal(await c.getPid('kept'),pid);assert.equal((await c.hostStatus()).owner.pid,status.owner.pid);assert.match(await c.getBuffer('kept'),/AFTER_PLANNED_ABORT/);
    await c.write('kept','AFTER_CANCEL_REDEMPTION\n');await wait(async()=>(await c.getBuffer('kept')).includes('AFTER_CANCEL_REDEMPTION'));
    process.send({verifiedAfterRejectedRedemption:true,pid,ownerPid:status.owner.pid});await c.shutdown();keep=false;
   }else process.send({ok:true});
  }else throw Error('unknown fixture mode');
  for(const type of ['auth-transfer-reserve','auth-transfer-activate','auth-transfer-cancel','auth-transfer-complete'])assert.equal(isPtyHostRequest({id:1,type,attempt:'a'.repeat(64),extra:true}),false);
 }finally{if(!keep)await c.shutdown().catch(()=>{});c.dispose();c.dropSocket();if(custom&&!keep)fs.rmSync(script,{force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
