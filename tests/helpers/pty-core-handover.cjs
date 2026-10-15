const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const core=require('../../dist-electron/pty-core.js');
const {getOwnerRuntime,shutdownOwnerRuntime}=require('../../dist-electron/pty-owner-runtime.js');
const {checkpointVtPane}=require('../../dist-electron/vt-mirror.js');
const {validatePaneCoreCheckpoint}=require('../../dist-electron/pty-core-checkpoint.js');
const {VtCheckpointTerminal}=require('../../dist-electron/vt-checkpoint.js');
const {capture}=require('../../dist-electron/vt-checkpoint-binding.js');
const {OwnerPty}=require('../../dist-electron/pty-owner-adapter.js');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate){const end=Date.now()+6000;while(!predicate()){if(Date.now()>end)throw Error('core handover readiness timeout');await sleep(2);}}
const home=process.env.AYA_HOME,mode=process.argv[2],scenario=process.argv[3],variant=scenario.startsWith('mount-')?'vt':scenario==='exit-late'?'exit-gap':scenario;let output='',exits=[],events=[];
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
  let attaches=0;const attach=OwnerPty.attach;
  OwnerPty.attach=async function(...args){attaches++;return attach.apply(this,args);};
  try{
   for(const mutate of [c=>{c.output.total++;},c=>{c.output.end=-1;},c=>{c.adapter.pane.pid=1;},c=>{c.adapter.pane.generation=0;},c=>{c.adapter.readBytes=-1;},c=>{c.adapter.decoderCarry='////';},c=>{c.adapter.credential='forbidden';},c=>{c.request.ptyId='other';},c=>{c.vt.metadata.generation='';},c=>{c.launch.mode={};},c=>{c.extra=true;}]){
    const bad=structuredClone(checkpoint);mutate(bad);await assert.rejects(core.restorePtyCorePane(bad,sink),/Invalid/);assert.equal(attaches,0,'malformed restore must not request a master');
   }
  }finally{OwnerPty.attach=attach;}
  await core.restorePtyCorePane(checkpoint,sink);
  assert.equal(core.getPtyPid('core'),expected.pid);assert.equal((await getOwnerRuntime()).record.pid,expected.ownerPid);
  assert.equal(core.getBufferedOutput('core'),expected.before);assert.deepEqual(core.searchPtyOutputs('history'),expected.search);
  assert.deepEqual(core.getPtyLaunch('core'),checkpoint.launch);
  if(variant!=='exit-gap'){
   const actual=await checkpointVtPane('core');assert.deepEqual(actual.metadata,expected.vt.metadata);
   const a=await VtCheckpointTerminal.import(expected.vt),b=await VtCheckpointTerminal.import(actual);
   try{
    const replies=[[],[]];a.terminal.onData(s=>replies[0].push(s));b.terminal.onData(s=>replies[1].push(s));
    // Ground compaction can move resize/output from the tail into the base.
    // Compare applied terminal state and subsequent parsing, not that layout.
    for(const text of ['1mCHECK','\x1b[?1049hFUTURE\x1b[?1049l','\x1b[6n']){
     await new Promise(r=>a.write(text,r));await new Promise(r=>b.write(text,r));
    }
    assert.deepEqual(JSON.parse(capture(a.terminal)),JSON.parse(capture(b.terminal)));assert.deepEqual(replies[0],replies[1]);
   }finally{a.dispose();b.dispose();}
  }
  if(scenario.startsWith('mount-') || scenario==='exit-late'){
   const mountEvents=[];
   const mountSink={isDestroyed:()=>false,sendPtyEvent:e=>mountEvents.push(e)};
   const request={...checkpoint.request,attachOnly:true,replayAfter:{generation:checkpoint.vt.metadata.generation,offset:checkpoint.output.end}};
   const services={prepare:()=>{throw Error('restored pane must never respawn');}};
   if(scenario==='mount-empty'){
    await core.spawnPty(request,mountSink,services);
    assert.deepEqual(mountEvents.filter(e=>e.type==='data'),[{type:'data',ptyId:'core',chunk:'',replay:true,reset:false}]);
    fs.writeFileSync(path.join(home,'release'),'go');await core.writePty('core','quit\n');await waitFor(()=>exits.length===1);
    await shutdownOwnerRuntime();process.send({pid:expected.pid,ownerPid:expected.ownerPid,exits:1},()=>process.exit(0));return;
   }
   fs.writeFileSync(path.join(home,'release'),'go');
   if(scenario==='exit-late'){
    await waitFor(()=>!core.getPtyPid('core'));
    assert.equal(exits.length,0,'unattached real exit must stay retained');
    await core.spawnPty(request,mountSink,services);
    assert.deepEqual(mountEvents.filter(e=>e.type==='exit').map(e=>e.exitCode),[23]);
    assert.ok(mountEvents.some(e=>e.type==='data'&&e.replay));
    await core.spawnPty(request,mountSink,services);
    assert.equal(mountEvents.filter(e=>e.type==='exit').length,1,'exit delivered once');
   }else{
    // The original broadcast sink has no renderer. The successor must keep
    // consuming output immediately, independently of when a view mounts.
    await waitFor(()=>output.includes('TAIL'));
    await core.writePty('core','before-mount\n');await waitFor(()=>output.includes(`R:${expected.pid}:before-mount`));
    if(scenario==='mount-late'){
     // Advance application time without sleeping: mount correctness has no
     // timeout or timer dependency, even five minutes after replacement.
     const now=Date.now;Date.now=()=>now()+300000;
     try {await core.spawnPty(request,mountSink,services);} finally {Date.now=now;}
    }else{
     if(scenario==='mount-trim')for(let i=0;i<20;i++)core.__testAppendToOutputBuffer('core',`TRIM${i}:`+'x'.repeat(65536));
     await core.spawnPty(request,mountSink,services);
    }
    const replay=mountEvents.filter(e=>e.type==='data'&&e.replay);
    assert.equal(replay.length,1);assert.equal(replay[0].reset,scenario==='mount-trim');
    if(scenario==='mount-trim')assert.equal(replay[0].chunk,core.getBufferedOutput('core'));
    else{
     assert.ok(!replay[0].chunk.includes('HISTORY'),'captured display must not be replayed twice');
     assert.equal(replay[0].chunk.split('TAIL').length-1,1);
     assert.equal(replay[0].chunk.split(`R:${expected.pid}:before-mount`).length-1,1);
     assert.ok(replay[0].chunk.indexOf('TAIL')<replay[0].chunk.indexOf('before-mount'));
    }
    assert.equal(core.getPtyPid('core'),expected.pid);
    await core.writePty('core','quit\n');await waitFor(()=>exits.length===1);assert.equal(exits[0].exitCode,23);
   }
   await shutdownOwnerRuntime();process.send({pid:expected.pid,ownerPid:expected.ownerPid,exits:1},()=>process.exit(0));return;
  }
  await core.spawnPty({...checkpoint.request,attachOnly:true,replayAfter:{generation:checkpoint.vt.metadata.generation,offset:checkpoint.output.end}},sink,{prepare:()=>{throw Error('must never respawn');}});
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
