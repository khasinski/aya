import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {terminateVerifiedProcess,ownerProcessStartIdentity}=require('../dist-electron/pty-owner-client.js');
test('verified SIGTERM reaches only the same individual process instance and preserves its real exit status', {timeout:15000},async()=>{
 const source="process.on('SIGTERM',()=>{process.stdout.write('TERM_RECEIVED\\n');process.exit(23)});process.stdout.write('SIGNAL_READY\\n');setInterval(()=>{},1000);";
 const child=spawn(process.execPath,['-e',source],{detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
 let output='',error='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);
 const exited=once(child,'exit');
 try{
  const deadline=Date.now()+5000;while(!output.includes('SIGNAL_READY')){assert.ok(Date.now()<deadline,'child ready before signal: '+error);await new Promise(resolve=>setTimeout(resolve,5));}
  const startIdentity=ownerProcessStartIdentity(child.pid);assert.ok(startIdentity);
  const [seconds,fraction]=startIdentity.split(':'),wrong=`${BigInt(seconds)+1n}:${fraction}`;
  const refused=terminateVerifiedProcess({pid:child.pid,startIdentity:wrong},child.pid);
  assert.ok(refused==='mismatch'||refused==='unknown');assert.doesNotThrow(()=>process.kill(child.pid,0));assert.ok(!output.includes('TERM_RECEIVED'));
  const accepted=terminateVerifiedProcess({pid:child.pid,startIdentity},child.pid);
  if(accepted==='unknown'&&process.platform==='linux'&&process.env.AYA_OWNER_EXPECT_PIDFD!=='1'){
   assert.doesNotThrow(()=>process.kill(child.pid,0));return; // unsupported kernel refuses safely; real CI requires success
  }
  assert.equal(accepted,'signalled');const [code,signal]=await exited;
  assert.equal(code,23,error);assert.equal(signal,null);assert.equal(output.split('TERM_RECEIVED').length-1,1);
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
});
