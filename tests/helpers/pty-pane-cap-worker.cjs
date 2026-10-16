const fs=require('node:fs');
const path=require('node:path');
const mode=process.argv[2];
const count=Number(process.argv[3]);
const home=process.env.AYA_HOME;
const core=require('../../dist-electron/pty-core.js');
const runtime=require('../../dist-electron/pty-owner-runtime.js');
const {acknowledgePtyRestoration}=core;
const events=[];
const output=new Map();
const exits=new Map();
const sink={isDestroyed:()=>false,sendPtyEvent(event){
 events.push(event);
 if(event.type==='data')output.set(event.ptyId,(output.get(event.ptyId)||'')+event.chunk);
 if(event.type==='exit')exits.set(event.ptyId,event);
}};
const send=value=>process.send(value);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=30000){const end=Date.now()+timeout;while(!predicate()){if(Date.now()>end)throw Error('pane cap trial readiness timeout');await sleep(2);}}
const requestFor=id=>{
 const script=`stty -echo; printf 'READY:${id}\\n'; while IFS= read -r line; do case "$line" in quit) exit 23 ;; *) printf 'REPLY:${id}:%s\\n' "$line" ;; esac; done`;
 return {request:{ptyId:id,command:script,cwd:home,cols:80,rows:24,agent:'custom'},launch:{command:script,cwd:home},script};
};
async function spawnPanes(){
 const started=Date.now();
 for(let i=0;i<count;i++){
  const id=`cap-${i}`,item=requestFor(id);
  await core.spawnPty(item.request,sink,{prepare:async()=>({argv:['/bin/sh','-c',item.script],env:{HOME:home,PATH:'/usr/bin:/bin',TERM:'xterm-256color'},command:item.script,launch:item.launch,ownSessionId:null,spawnedAt:Date.now()})});
  await waitFor(()=>String(output.get(id)||'').includes(`READY:${id}`));
 }
 return Date.now()-started;
}
function recoveryBootstrap(parts,owner){
 const launches=new Map(parts.filter(part=>!('kind'in part)).map(part=>[part.id,part]));
 const panes=owner.record.panes.filter(pane=>!pane.exited&&!pane.acknowledged).map(pane=>{
  const part=launches.get(pane.id);if(!part)throw Error(`missing checkpoint launch ${pane.id}`);
  const request={...part.request};delete request.attachOnly;delete request.attachIfReused;delete request.replayAfter;
  return {id:pane.id,generation:pane.generation,pid:pane.pid,startIdentity:pane.startIdentity,request,launch:part.launch,spawnedAt:part.spawnedAt};
 });
 return {format:1,kind:'crash',owner:{pid:owner.record.pid,startTime:owner.record.startTime,instanceId:owner.record.instanceId,binaryHash:owner.record.binaryHash},panes};
}
async function oldHost(){
 const started=Date.now();await runtime.getOwnerRuntime();const spawnMs=await spawnPanes();
 let limitRefusal=null;
 if(count===require('../../dist-electron/pty-pane-limits.js').MAX_PTY_PANES){
  const over=requestFor('cap-over');
  await core.spawnPty(over.request,sink,{prepare:async()=>({argv:['/bin/sh','-c',over.script],env:{HOME:home,PATH:'/usr/bin:/bin',TERM:'xterm-256color'},command:over.script,launch:over.launch,ownSessionId:null,spawnedAt:Date.now()})});
  const failure=events.find(event=>event.type==='spawn-failed'&&event.ptyId==='cap-over');
  limitRefusal=failure?{reason:failure.reason,detail:failure.detail,exit127:events.some(event=>event.type==='exit'&&event.ptyId==='cap-over'&&event.exitCode===127)}:null;
 }
 const owner=runtime.currentOwnerRuntime();
 const pids=owner.record.panes.map(pane=>({id:pane.id,pid:pane.pid,generation:pane.generation,startIdentity:pane.startIdentity}));
 send({type:'old-ready',count,pids,spawnMs,limitRefusal,owner:{pid:owner.record.pid,startTime:owner.record.startTime,instanceId:owner.record.instanceId,binaryHash:owner.record.binaryHash},rss:process.memoryUsage().rss,elapsedMs:Date.now()-started});
 const message=await new Promise(resolve=>process.once('message',resolve));
 if(message.type!=='handover')throw Error('expected B3 handover');
 const {HostHandover}=require('../../dist-electron/pty-host-handover.js');
 const {PTY_HANDOVER_CORE_DIRECTORY,PTY_HANDOVER_DISPLAY_DIRECTORY}=require('../../dist-electron/pty-host-paths.js');
 const {ownerProcessStartIdentity}=require('../../dist-electron/pty-owner-client.js');
 const self={pid:process.pid,startIdentity:ownerProcessStartIdentity(process.pid)};
 const handover=new HostHandover(PTY_HANDOVER_CORE_DIRECTORY,PTY_HANDOVER_DISPLAY_DIRECTORY);
 const prepared=await handover.prepare(self,Date.now()+120000);
 await handover.publish(self,null);
 handover.adopt(message.recipient);
 const detached=await handover.detach(message.recipient,[]);
 if(detached.stopped.length)throw Error('B3 trial unexpectedly stopped a pane');
 send({type:'b3-detached',state:prepared,oldPid:process.pid,rss:process.memoryUsage().rss,at:Date.now()});
 setTimeout(()=>process.exit(0),50);
}
async function successor(){
 const message=await new Promise(resolve=>process.once('message',resolve));
 if(message.type!=='restore')throw Error('expected B3 restore');
 const {readCoreHandover,preflightCoreHandover}=require('../../dist-electron/pty-handover-bootstrap.js');
 const {acknowledgeCheckpoint}=require('../../dist-electron/pty-checkpoint-store.js');
 const {PTY_HANDOVER_CORE_DIRECTORY}=require('../../dist-electron/pty-host-paths.js');
 const parts=[];for await(const pane of readCoreHandover(message.state.core))parts.push(pane);
 const sizes=await preflightCoreHandover(message.state.core,message.state.eligible);
 await runtime.getOwnerRuntime();
 const restoreStart=Date.now();for(const pane of parts)await core.restorePtyCorePane(pane,sink);
 await acknowledgeCheckpoint(PTY_HANDOVER_CORE_DIRECTORY,message.state.core);
 const owner=runtime.currentOwnerRuntime(),inventory=await owner.client.list();
 if(owner.record.pid!==message.owner.pid||owner.record.instanceId!==message.owner.instanceId)throw Error('B3 changed native owner identity');
 const samePids=inventory.length===count&&inventory.every(pane=>message.pids.some(before=>before.id===pane.id&&before.pid===pane.pid&&before.generation===pane.generation));
 if(!samePids)throw Error('B3 changed owner pane identities');
 const bootstrap=recoveryBootstrap(parts,owner);
 fs.writeFileSync(path.join(home,'recovery-bootstrap.json'),JSON.stringify(bootstrap),{mode:0o600});
 send({type:'successor-ready',count,coreRawBytes:sizes.rawBytes,coreEncodedBytes:sizes.encodedBytes,bootstrapBytes:Buffer.byteLength(JSON.stringify(bootstrap)),samePids,owner:bootstrap.owner,pids:inventory.map(pane=>({id:pane.id,pid:pane.pid,generation:pane.generation,startIdentity:pane.startIdentity})),restoreMs:Date.now()-restoreStart,rss:process.memoryUsage().rss});
 await new Promise(resolve=>process.once('message',resolve));
}
async function recoveryHost(){
 const bootstrap=JSON.parse(fs.readFileSync(path.join(home,'recovery-bootstrap.json'),'utf8'));
 runtime.requireRecoveryOwner(bootstrap.owner);
 const owner=await runtime.getOwnerRuntime();
 if(owner.record.pid!==bootstrap.owner.pid||owner.record.instanceId!==bootstrap.owner.instanceId)throw Error('B4 changed native owner identity');
 const restoreStart=Date.now();for(const pane of bootstrap.panes)await core.recoverPtyCorePane(pane,sink);
 const displayGenerations=Object.fromEntries(core.ptyRecoveryStates().map(state=>[state.id,state.generation]));
 const inventory=await owner.client.list();
 if(inventory.length!==count||!inventory.every(pane=>bootstrap.panes.some(saved=>saved.id===pane.id&&saved.pid===pane.pid&&saved.generation===pane.generation)))throw Error('B4 changed owner pane identities');
 for(const pane of bootstrap.panes){
  const token=`trial-replay-${pane.id}`;let replayed=false;
  const request={...pane.request,attachOnly:true,replayAfter:{generation:displayGenerations[pane.id],offset:0,token}};
  await core.spawnPty(request,{...sink,sendPtyEvent(event){sink.sendPtyEvent(event);if(event.type==='data'&&event.replayToken===token)replayed=true;}},{});
  if(!replayed||!acknowledgePtyRestoration(pane.id,request.replayAfter.generation,token))throw Error(`B4 applied replay fence refused for ${pane.id}`);
 }
 for(let i=0;i<count;i++)await core.writePty(`cap-${i}`,`probe-${i}\n`);
 await waitFor(()=>Array.from({length:count},(_,i)=>String(output.get(`cap-${i}`)||'').includes(`REPLY:cap-${i}:probe-${i}`)).every(Boolean),60000);
 for(let i=0;i<count;i++)await core.writePty(`cap-${i}`,'quit\n');
 await waitFor(()=>exits.size===count,30000);
 for(const event of exits.values())if(event.exitCode!==23)throw Error(`unexpected B4 pane exit ${event.ptyId}: ${event.exitCode}`);
 for(const event of exits.values())if(event.ownerExit)await core.acknowledgePtyExit(event.ptyId,event.ownerExit.generation,event.ownerExit.event);
 await runtime.shutdownOwnerRuntime();
 send({type:'recovered',count,samePids:true,exit23:exits.size,roundTrips:count,recoveryMs:Date.now()-restoreStart,rss:process.memoryUsage().rss});
 setTimeout(()=>process.exit(0),50);
}
(async()=>{
 if(!Number.isInteger(count)||count<1)throw Error('invalid pane count');
 if(mode==='old')await oldHost();else if(mode==='successor')await successor();else if(mode==='recovery')await recoveryHost();else throw Error('unknown trial mode');
})().catch(error=>{console.error(error);process.exit(1);});
