const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const core=require('../../dist-electron/pty-core.js'),runtime=require('../../dist-electron/pty-owner-runtime.js');
const {parseRecoveryBootstrap}=require('../../dist-electron/pty-recovery-bootstrap.js');
const {vtSnapshot}=require('../../dist-electron/vt-mirror.js');
const {snapshotHold,snapshotBusy}=require('../../dist-electron/vt-state.js');
const {HOLD_RECOVERY_UNKNOWN,HOLD_SHELL}=require('../../dist-electron/pane-holds.js');
const home=process.env.AYA_HOME,mode=process.argv[2],variant=process.argv[3];
let output='',exit;const events=[];
const sink={isDestroyed:()=>false,sendPtyEvent:e=>{events.push(e);if(e.type==='data')output+=e.chunk;if(e.type==='exit')exit=e.exitCode;}};
const wait=async predicate=>{const end=Date.now()+6000;while(!await predicate()){if(Date.now()>end)throw Error('crash core readiness timeout');await new Promise(r=>setTimeout(r,2));}};
(async()=>{
 if(mode==='old'){
  const script=`stty -echo; echo OLD_CONSUMED; while [ ! -f "$HOME/release" ]; do sleep .01; done; ${variant==='exit-gap'?'':"printf 'UNREAD_BEFORE_ATTACH\\n'; "}touch "$HOME/produced"; ${variant==='exit-gap'?'exit 23':`while IFS= read -r line; do case "$line" in quit) exit 23 ;; *) printf 'R:%s:%s\\n' "$$" "$line" ;; esac; done`}`;
  const request={ptyId:'pane',command:script,cwd:home,cols:80,rows:24,agent:variant==='shell'?'custom':'claude'};
  const launch={command:script,cwd:home};
  await core.spawnPty(request,sink,{prepare:async()=>({argv:['/bin/sh','-c',script],env:{HOME:home,PATH:'/usr/bin:/bin'},command:script,launch,ownSessionId:null,spawnedAt:123})});
  await wait(()=>output.includes('OLD_CONSUMED'));await core.freezePtyCore();
  const owner=await runtime.getOwnerRuntime(),pane=owner.record.panes[0];
  process.send({format:1,kind:'crash',owner:{pid:owner.record.pid,startTime:owner.record.startTime,instanceId:owner.record.instanceId,binaryHash:owner.record.binaryHash},panes:[{id:pane.id,generation:pane.generation,pid:pane.pid,startIdentity:pane.startIdentity,request,launch,spawnedAt:123}]});
 }else{
  const bootstrap=parseRecoveryBootstrap(fs.readFileSync(path.join(home,'bootstrap.json')));
  const refused=['wrong-owner','missing-owner','wrong-secret'].includes(variant);
  const record=path.join(home,'pty-owner/record.json'),before=fs.readFileSync(record);
  if(variant==='wrong-owner')bootstrap.owner.instanceId='0'.repeat(32);
  if(variant==='missing-owner')fs.unlinkSync(record);
  runtime.requireRecoveryOwner(bootstrap.owner);
  if(refused){
   try{await assert.rejects(runtime.getOwnerRuntime(),/recorded PTY owner/);assert.equal(runtime.currentOwnerRuntime(),null);assert.equal(fs.existsSync(record),variant!=='missing-owner');if(variant!=='missing-owner')assert.deepEqual(fs.readFileSync(record),before);}
   finally{if(variant==='missing-owner')fs.writeFileSync(record,before,{mode:0o600});}
   process.send({refused:true},()=>process.exit(0));return;
  }
  const owner=await runtime.getOwnerRuntime();
  if(variant==='mismatch'){
   const bad={...bootstrap.panes[0],generation:bootstrap.panes[0].generation+1};
   const {OwnerPty}=require('../../dist-electron/pty-owner-adapter.js');let attaches=0;const attach=OwnerPty.attach;OwnerPty.attach=async(...args)=>{attaches++;return attach.apply(OwnerPty,args);};
   await assert.rejects(core.recoverPtyCorePane(bad,sink),/identity changed/);assert.equal(attaches,0);assert.equal(owner.disconnected.size,1);
   await runtime.shutdownOwnerRuntime();process.send({mismatch:true},()=>process.exit(0));return;
  }
  if(variant==='exit-gap')assert.equal(owner.disconnected.get('pane').exited,true,'native inventory already has exit before attaching master');
  await core.recoverPtyCorePane(bootstrap.panes[0],sink);
  if(variant!=='exit-gap'){await wait(()=>output.includes('UNREAD_BEFORE_ATTACH'));assert.equal(output.split('UNREAD_BEFORE_ATTACH').length-1,1);}
  assert.ok(!output.includes('OLD_CONSUMED'));
  if(variant!=='exit-gap'){
   const snapshot=await vtSnapshot('pane');assert.equal(snapshot.recoveryUnknown,true);
   assert.equal(snapshotHold(snapshot).hold,variant==='shell'?HOLD_SHELL:HOLD_RECOVERY_UNKNOWN);assert.equal(snapshotBusy(snapshot),false);
   assert.equal(core.getPtyPid('pane'),bootstrap.panes[0].pid);core.resizePty('pane',101,39);
   assert.deepEqual(await owner.client.list().then(panes=>[panes[0].cols,panes[0].rows]),[101,39]);
   await core.writePty('pane','AFTER_RECOVERY\n');await wait(()=>output.includes(`R:${bootstrap.panes[0].pid}:AFTER_RECOVERY`));
   await core.writePty('pane','quit\n');
  }
  await wait(()=>core.getPtyPid('pane')===null);
  // The ended record stays pending until a real view asks for its replay.
  assert.equal(exit,undefined);await core.spawnPty({...bootstrap.panes[0].request,attachOnly:true},sink,{prepare:async()=>{throw Error('recovery must never prepare/spawn');}});
  assert.equal(exit,23);assert.equal(owner.record.pid,bootstrap.owner.pid);
  await runtime.shutdownOwnerRuntime();process.send({recovered:true,exit},()=>process.exit(0));
 }
})().catch(error=>{console.error(error);process.exit(1);});
