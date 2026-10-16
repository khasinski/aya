// Real local capacity trial: native PTY owner + JS core, B3 checkpoint/detach/
// restore, then B4 SIGKILL/recover. This is not a renderer paint measurement.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork,execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ownerProcessStartIdentity} from '../dist-electron/pty-owner-client.js';
import {cleanupNativeOwner} from '../tests/helpers/pty-host.mjs';
import {MAX_PTY_PANES} from '../dist-electron/pty-pane-limits.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const helper=path.join(root,'tests/helpers/pty-pane-cap-worker.cjs');
const outputDirectory=path.join(root,'test-results');fs.mkdirSync(outputDirectory,{recursive:true});
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fdCount(pid){try{return Math.max(0,execFileSync('lsof',['-nP','-p',String(pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trimEnd().split('\n').length-1);}catch{return null;}}
function rssBytes(pid){try{return Number(execFileSync('ps',['-o','rss=','-p',String(pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim())*1024||null;}catch{return null;}}
function procSample(label,pids){return {label,at:Date.now(),processes:Object.fromEntries(Object.entries(pids).map(([name,pid])=>[name,pid?{pid,rssBytes:rssBytes(pid),openFds:fdCount(pid)}:null]))};}
function launch(mode,count,home,secret){
 const child=fork(helper,[mode,String(count)],{cwd:root,env:{...process.env,AYA_HOME:home,AYA_PTY_OWNER_FD:'3',PATH:'/usr/bin:/bin'},stdio:['ignore','ignore','pipe','pipe','ipc']});
 child.stdio[3].on('error',()=>{});child.stdio[3].end(secret);
 child.__stderr='';child.stderr.on('data',chunk=>{child.__stderr+=chunk.toString();});
 return child;
}
function nextMessage(child,type,timeoutMs=120000){
 child.__waiting=true;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>finish(Error(`${type} message timed out`)),timeoutMs);
  const onMessage=value=>{if(value?.type===type)finish(null,value);};
  const onError=error=>finish(error);
  const onExit=(code,signal)=>finish(Error(`${type} worker exited ${code}/${signal}: ${child.__stderr}`));
  function finish(error,value){clearTimeout(timer);child.off('message',onMessage);child.off('error',onError);child.off('exit',onExit);child.__waiting=false;error?reject(error):resolve(value);}
  child.on('message',onMessage);child.once('error',onError);child.once('exit',onExit);
 });
}
async function exited(child){if(child.exitCode!==null||child.signalCode!==null)return;await new Promise(resolve=>child.once('exit',resolve));}
async function runTrial(count){
 const home=fs.mkdtempSync(path.join(outputDirectory,`pane-cap-${count}-`));fs.chmodSync(home,0o700);
 const secret=randomBytes(32);let old,successor,recovery;const samples=[];let ownerPid=null;
 try{
  old=launch('old',count,home,secret);const started=await nextMessage(old,'old-ready');ownerPid=started.owner.pid;
  samples.push(procSample('spawned', {jsHost:old.pid,owner:ownerPid}));
  const ownerStart=ownerProcessStartIdentity(ownerPid);if(!ownerStart)throw Error('cannot prove trial owner identity');
  let refusal=null;
  if(count===MAX_PTY_PANES){
   refusal=started.limitRefusal;
   if(!refusal||refusal.reason!=='pane-limit-reached'||refusal.exit127||!refusal.detail.includes(`at most ${MAX_PTY_PANES} terminals`))throw Error(`N+1 did not get the plain pane-limit refusal: ${JSON.stringify(refusal)}`);
  }
  successor=launch('successor',count,home,secret);const recipientStart=ownerProcessStartIdentity(successor.pid);if(!recipientStart)throw Error('cannot prove B3 successor identity');
  const b3Started=Date.now();old.send({type:'handover',recipient:{pid:successor.pid,startIdentity:recipientStart}});
  const detached=await nextMessage(old,'b3-detached');await exited(old);
  samples.push(procSample('B3-old-detached-before-restore',{jsHost:successor.pid,owner:ownerPid}));
  successor.send({type:'restore',state:detached.state,pids:started.pids,owner:started.owner});
  const restored=await nextMessage(successor,'successor-ready',180000);
  samples.push(procSample('B3-successor-restored',{jsHost:successor.pid,owner:ownerPid}));
  if(!restored.samePids||restored.count!==count||restored.bootstrapBytes>1024*1024)throw Error(`B3 validation failed: ${JSON.stringify(restored)}`);
  const b4Started=Date.now();successor.send({type:'crash'});successor.kill('SIGKILL');await exited(successor);
  samples.push(procSample('B4-old-js-killed',{owner:ownerPid}));
  recovery=launch('recovery',count,home,secret);
  const recovered=await nextMessage(recovery,'recovered',180000);
  samples.push(procSample('B4-recovered-before-cleanup',{jsHost:recovery.pid,owner:ownerPid}));
  await exited(recovery);
  samples.push(procSample('B4-recovered-and-exited',{owner:ownerPid}));
  if(recovered.count!==count||recovered.roundTrips!==count||recovered.exit23!==count||!recovered.samePids)throw Error(`B4 validation failed: ${JSON.stringify(recovered)}`);
  return {count,limit:MAX_PTY_PANES,spawnMs:started.spawnMs,b3:{handoverMs:Date.now()-b3Started,coreRawBytes:detached.state.coreRawBytes,coreEncodedBytes:detached.state.coreEncodedBytes,displayRawBytes:detached.state.displayRawBytes,eligible:detached.state.eligible.length,restoredMs:restored.restoreMs},b4:{recoveryMs:Date.now()-b4Started,attachAndRoundTripMs:recovered.recoveryMs,bootstrapBytes:restored.bootstrapBytes},rssBytes:{jsHostAtSpawn:started.rss,jsHostAfterB3:restored.rss,jsHostAfterB4:recovered.rss},fdSamples:samples,limitRefusal:refusal,scope:'Real native-owner PTYs and JS core; B3 captures/restores core checkpoint with display replay fallback (no renderer capture or paint); B4 uses actual successor SIGKILL and owner/child identity checks, then performs one round-trip and exit23 per pane.'};
 }finally{
  for(const child of [old,successor,recovery])if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  for(const child of [old,successor,recovery])if(child)await exited(child);
  await cleanupNativeOwner(home).catch(()=>{});
  fs.rmSync(home,{recursive:true,force:true});
 }
}

const counts=[64,MAX_PTY_PANES];
const report={at:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron??null,launchdLimit:process.platform==='darwin'?execFileSync('launchctl',['limit','maxfiles'],{encoding:'utf8'}).trim():null,results:[]};
for(const count of counts)report.results.push(await runTrial(count));
const file=path.join(outputDirectory,`pty-pane-cap-${process.platform}-${process.arch}.json`);
fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({file,...report},null,2));
