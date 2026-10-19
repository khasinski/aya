import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {cleanupNativeOwner} from './helpers/pty-host.mjs';
for(const scenario of ['normal','abort','exit-gap'])test(`adapter handover ${scenario} preserves queued output, UTF8 and real process outcomes`,{timeout:15000},async()=>{
 fs.mkdirSync('test-results',{recursive:true});const home=fs.mkdtempSync(path.resolve('test-results/owner-handover-')),credential=randomBytes(32),children=[];
 function reader(mode,checkpoint){
  const child=spawn(process.execPath,['tests/helpers/pty-owner-handover.cjs',mode],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',AYA_HOME:home,HOME:home,AYA_PTY_OWNER_FD:'3'},stdio:['ignore','ignore','pipe','pipe','pipe','ipc']});children.push(child);
  let stderr='';child.stderr.on('data',b=>{stderr+=b;});
  child.stdio[3].on('error',()=>{});child.stdio[3].end(credential);
  child.stdio[4].on('error',()=>{});child.stdio[4].end(checkpoint?JSON.stringify(checkpoint):'');
  let message;child.once('message',value=>{message=value;});
  const done=new Promise((resolve,reject)=>child.once('exit',(code,signal)=>{if(code===0&&message)resolve(message);else reject(Error(`reader ${mode} exited ${code}/${signal}: ${stderr}`));}));
  return done;
 }
 try{
  if(scenario==='abort'){const old=await reader('abort');assert.equal(old.aborted,true);assert.ok(old.output.includes(`😀TAIL:${old.childPid}`));assert.ok(old.output.includes(`R:${old.childPid}:after`));return;}
  const old=await reader(scenario==='exit-gap'?'old-exit':'old');assert.equal(old.pending,true);assert.ok(old.output.includes(`R:${old.childPid}:first`));assert.equal(old.output.includes('TAIL:'),scenario==='exit-gap');
  if(scenario==='exit-gap'){
   fs.writeFileSync(path.join(home,'exit'),'go');
   const deadline=Date.now()+5000;
   for(;;){let alive=true;try{process.kill(old.childPid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}if(!alive)break;if(Date.now()>deadline)throw Error('child did not exit during no-JS gap');await new Promise(resolve=>setTimeout(resolve,2));}
  }
  const next=await reader(scenario==='exit-gap'?'new-exit':'new',old.checkpoint);
  assert.equal(next.childPid,old.childPid);assert.equal(next.ownerPid,old.ownerPid);
  assert.equal(next.exit.exitCode,23);assert.equal((old.output+next.output).split('😀').length-1,1);
  assert.equal((old.output+next.output).split(`TAIL:${old.childPid}`).length-1,1);if(scenario==='normal'){assert.ok(next.output.includes('39 101'));assert.ok(next.output.includes(`R:${old.childPid}:after`));}
 }finally{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  await cleanupNativeOwner(home);fs.rmSync(home,{recursive:true,force:true});
 }
});
