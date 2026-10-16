import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

async function run(mode,bytes=Buffer.alloc(32,9)){
 fs.mkdirSync('test-results',{recursive:true});const home=fs.mkdtempSync(path.resolve('test-results/auth-bootstrap-'));
 let fd;
 const source=`const {readInheritedHostAuthKey}=require('./dist-electron/pty-host-auth-bootstrap.js');readInheritedHostAuthKey().then(key=>{if(key.length!==32||process.env.AYA_PTY_AUTH_FD)process.exit(3);process.stdout.write('READY');},()=>process.exit(2));`;
 if(mode==='file'){fs.writeFileSync(path.join(home,'regular'),bytes);fd=fs.openSync(path.join(home,'regular'),'r');}
 const child=spawn(process.execPath,['-e',source],{stdio:['ignore','pipe','pipe','ignore','ignore',fd??'pipe'],env:{...process.env,AYA_HOME:home,ELECTRON_RUN_AS_NODE:'1',AYA_PTY_AUTH_FD:mode==='missing'?'':'5'}});
 if(fd!==undefined)fs.closeSync(fd);
 const pipeErrors=[];if(mode!=='file')child.stdio[5].on('error',error=>pipeErrors.push(error.code));
 let output='',error='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);
 const began=performance.now(),exited=once(child,'exit');
 // Missing marker can make the child close before its parent finishes writing.
 // Exercise that Linux ECONNRESET observation deterministically on every OS.
 if(mode==='missing')child.stdio[5].emit('error',Object.assign(Error('early pipe close'),{code:'ECONNRESET'}));
 if(mode!=='file'){if(mode==='stalled')child.stdio[5].write(bytes);else child.stdio[5].end(bytes);}
 try{
  const result=await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('bootstrap child did not exit')),8000);timer.unref();})]);
  assert.equal(fs.existsSync(path.join(home,'pty-host-auth')),false,'a host bootstrap cannot create a capability');
  assert.ok(pipeErrors.every(code=>['ECONNRESET','EPIPE'].includes(code)),`unexpected bootstrap pipe error: ${pipeErrors}`);
  if(result[0]===0)assert.deepEqual(pipeErrors,[]);
  return {code:result[0],output,error,elapsed:performance.now()-began};
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}fs.rmSync(home,{recursive:true,force:true});}
}
test('host accepts exactly32 inherited bytes and consumes the descriptor marker',async()=>{const r=await run('pipe');assert.equal(r.code,0,r.error);assert.equal(r.output,'READY');});
test('missing, short, oversized and regular-file inheritance refuse without a fallback capability',async()=>{
 for(const [mode,bytes] of [['missing',Buffer.alloc(32)],['pipe',Buffer.alloc(31)],['pipe',Buffer.alloc(33)],['file',Buffer.alloc(32)]]){
  const r=await run(mode,bytes);assert.equal(r.code,2,r.error);assert.equal(r.output,'');
 }
});
test('a main that never closes the inherited pipe cannot leave a socketless host hanging', {timeout:15000},async()=>{
 const r=await run('stalled');assert.equal(r.code,2,r.error);assert.equal(r.output,'');assert.ok(r.elapsed>=4900);assert.ok(r.elapsed<8000);
});
