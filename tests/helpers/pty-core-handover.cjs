const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const core=require('../../dist-electron/pty-core.js');
const {getOwnerRuntime,shutdownOwnerRuntime}=require('../../dist-electron/pty-owner-runtime.js');
const {checkpointVtPane}=require('../../dist-electron/vt-mirror.js');
const {validatePaneCoreCheckpoint}=require('../../dist-electron/pty-core-checkpoint.js');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate){const end=Date.now()+6000;while(!predicate()){if(Date.now()>end)throw Error('core handover readiness timeout');await sleep(2);}}
const home=process.env.AYA_HOME,mode=process.argv[2],variant=process.argv[3];let output='',exits=[],events=[];
const sink={isDestroyed:()=>false,sendPtyEvent:e=>{events.push(e);if(e.type==='data')output+=e.chunk;if(e.type==='exit')exits.push(e);}};
(async()=>{
 if(variant.startsWith('prepare-')){
  let release,entered=false;
  const script="stty -echo; printf 'READY\\n'; while IFS= read -r line; do case \"$line\" in quit) exit 23 ;; *) printf 'R:%s\\n' \"$line\" ;; esac; done";
  const prepared={argv:['/bin/sh','-c',script],env:{HOME:home,PATH:'/usr/bin:/bin'},command:script,launch:{command:script,cwd:home},ownSessionId:null,spawnedAt:12345};
  const spawning=core.spawnPty({ptyId:'flight',command:script,cwd:home,cols:80,rows:24},sink,{prepare:()=>{entered=true;return new Promise(r=>{release=r;});}});
  await waitFor(()=>entered);const queued=core.writePty('flight','queued-original\n');
  const freezing=core.freezePtyCore(variant==='prepare-abort'?30:1000);
  await assert.rejects(core.writePty('flight','forbidden\n'),/handover/);
  if(variant==='prepare-abort')await assert.rejects(freezing,/drain timed out/);
  release(prepared);await spawning;assert.equal(await queued,true);
  if(variant==='prepare-success'){
   const result=await freezing;assert.deepEqual(result.ineligible,[]);assert.equal(result.eligible[0].id,'flight');core.abortPtyCoreHandover();
  }
  await waitFor(()=>output.includes('R:queued-original'));
  await core.writePty('flight','quit\n');await waitFor(()=>exits.length===1);
  assert.equal(exits[0].exitCode,23);assert.equal(output.split('R:queued-original').length-1,1);assert.ok(!output.includes('forbidden'));
  await shutdownOwnerRuntime();process.send({preparation:true},()=>process.exit(0));return;
 }
 if(mode==='old'||mode==='abort'){
  const prefix={osc:"\\033]9001;aya.status=active:bu",vt:"\\033[3",utf8:"\\360\\237",'exit-gap':""}[variant];
  const suffix={osc:"sy\\007TAIL",vt:"1mTAIL\\033[0m",utf8:"\\230\\200TAIL",'exit-gap':""}[variant];
  const after=variant==='exit-gap'?'exit 23':`printf '${suffix}\\n'; while IFS= read -r line; do case "$line" in quit) exit 23 ;; *) printf 'R:%s:%s\\n' "$$" "$line" ;; esac; done`;
  const script=`stty -echo; printf 'READY:%s\\n' "$$"; IFS= read -r line; printf '\\033[38;2;12;34;56mHISTORY\\033[0m\\n\\033[?1049hALTERNATE\\033[?1049l${prefix}'; touch "$HOME/produced"; while [ ! -f "$HOME/release" ]; do sleep 0.01; done; ${after}`;
  const request={ptyId:'core',command:script,cwd:home,cols:80,rows:24,agent:'custom'};
  const services={prepare:async()=>({argv:['/bin/sh','-c',script],env:{HOME:home,PATH:'/usr/bin:/bin',TERM:'xterm-256color'},command:script,launch:{command:script,cwd:home,added:['fixture']},ownSessionId:null,spawnedAt:12345})};
  await core.spawnPty(request,sink,services);const pid=core.getPtyPid('core');
  await waitFor(()=>output.includes(`READY:${pid}`));core.resizePty('core',101,39);
  await core.writePty('core','start\n');await waitFor(()=>fs.existsSync(path.join(home,'produced'))&&output.includes('HISTORY'));
  // The known prefix follows HISTORY in the same printf; wait for its observed
  // semantic boundary, rather than assuming the file means the read completed.
  let preflight,checkpoint;
  const prefixDeadline=Date.now()+5000;
  for(;;){
   if(Date.now()>prefixDeadline)throw Error('Known prefix was not consumed');
   preflight=await core.freezePtyCore();checkpoint=core.frozenPtyCoreParts()[0];
   assert.deepEqual(preflight.ineligible,[]);
   const ready=variant==='exit-gap'||(variant==='osc'?checkpoint.oscCarry==='\x1b]9001;aya.status=active:bu':variant==='utf8'?checkpoint.adapter.decoderCarry==='8J8=':checkpoint.vt.tail.some(op=>op.text?.includes('\x1b[3')));
   if(ready)break;core.abortPtyCoreHandover();await sleep(2);
  }
  assert.equal(checkpoint.adapter.pane.cols,101);assert.equal(checkpoint.adapter.pane.rows,39);
  const before=core.getBufferedOutput('core'),search=core.searchPtyOutputs('history');
  for(const mutate of [c=>{c.output.total++;},c=>{c.output.end=-1;},c=>{c.adapter.pane.pid=1;},c=>{c.adapter.pane.generation=0;},c=>{c.adapter.readBytes=-1;},c=>{c.adapter.decoderCarry='////';},c=>{c.adapter.credential='forbidden';},c=>{c.request.ptyId='other';},c=>{c.vt.metadata.generation='';},c=>{c.launch.mode={};},c=>{c.extra=true;}]){
   const bad=structuredClone(checkpoint);mutate(bad);await assert.rejects(validatePaneCoreCheckpoint(bad));
  }
  await assert.rejects(core.writePty('core','MUST_NOT_DELIVER\n'),/handover/);
  assert.throws(()=>core.resizePty('core',80,24),/handover/);
  await assert.rejects(core.killPty('core'),/handover/);
  await assert.rejects(core.spawnPty({...request,ptyId:'duplicate'},sink,services),/handover/);
  const owner=await getOwnerRuntime();
  if(mode==='abort'){
   core.abortPtyCoreHandover();fs.writeFileSync(path.join(home,'release'),'go');
   await core.writePty('core','after\nquit\n');await waitFor(()=>exits.length===1);
   assert.equal(exits[0].exitCode,23);assert.ok(output.includes(`R:${pid}:after`));assert.ok(!output.includes('MUST_NOT_DELIVER'));
   await shutdownOwnerRuntime();process.send({aborted:true,pid},()=>process.exit(0));return;
  }
  fs.writeFileSync(path.join(home,'core.json'),JSON.stringify(checkpoint),{mode:0o600});
  fs.writeFileSync(path.join(home,'expected.json'),JSON.stringify({before,search,output,vt:checkpoint.vt,ownerPid:owner.record.pid,pid}));
  await core.detachPtyCoreForHandover();
  process.send({pid,ownerPid:owner.record.pid},()=>process.exit(0));
 }else{
  const checkpoint=JSON.parse(fs.readFileSync(path.join(home,'core.json'),'utf8')),expected=JSON.parse(fs.readFileSync(path.join(home,'expected.json'),'utf8'));
  await core.restorePtyCorePane(checkpoint,sink);
  assert.equal(core.getPtyPid('core'),expected.pid);assert.equal((await getOwnerRuntime()).record.pid,expected.ownerPid);
  assert.equal(core.getBufferedOutput('core'),expected.before);assert.deepEqual(core.searchPtyOutputs('history'),expected.search);
  assert.deepEqual(core.getPtyLaunch('core'),checkpoint.launch);
  if(variant!=='exit-gap')assert.deepEqual(await checkpointVtPane('core'),expected.vt);
  if(variant!=='exit-gap'){
   fs.writeFileSync(path.join(home,'release'),'go');await waitFor(()=>output.includes('TAIL'));
   await core.writePty('core','after\nquit\n');
  }
  await waitFor(()=>exits.length===1);assert.equal(exits[0].exitCode,23);assert.ok(!output.includes('MUST_NOT_DELIVER'));
  if(variant!=='exit-gap'){assert.ok(output.includes(`R:${expected.pid}:after`));assert.equal((expected.output+output).split('TAIL').length-1,1);}
  if(variant==='utf8')assert.equal((expected.output+output).split('😀').length-1,1);
  if(variant==='osc'){assert.ok(events.some(e=>e.type==='osc-status'&&e.level==='active'&&e.text==='busy'));assert.ok(!output.includes('aya.status'));}
  await shutdownOwnerRuntime();process.send({pid:expected.pid,ownerPid:expected.ownerPid,exits:exits.length},()=>process.exit(0));
 }
})().catch(e=>{console.error(e);process.exit(1);});
