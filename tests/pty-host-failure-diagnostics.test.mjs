import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import {createRequire} from 'node:module';
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/failure-evidence-'));isolateHome(root);
const require=createRequire(import.meta.url),diagnostics=require('./helpers/pty-host-failure-diagnostics.cjs');
test('failure evidence retains bounded process/file/proof metadata without capability or ticket payloads',()=>{
 const home=process.env.AYA_HOME,secret='NEVER_PRINT_PRIVATE_CAPABILITY';fs.mkdirSync(path.join(home,'pty-hosts'),{recursive:true});fs.mkdirSync(path.join(home,'pty-owner'));
 fs.writeFileSync(path.join(home,'pty-hosts','123.json'),JSON.stringify({pid:123,pgid:123,startTime:'recorded-start',version:'test',scriptHash:'a'.repeat(64),nonce:secret}),{mode:0o600});
 fs.writeFileSync(path.join(home,'pty-owner','record.json'),JSON.stringify({pid:124,jsPid:123,startTime:'owner-start',jsStartTime:'recorded-start',startIdentity:'1:2',secret}),{mode:0o600});
 fs.writeFileSync(path.join(home,'pty-handover.secret.json'),secret,{mode:0o600});
 fs.writeFileSync(path.join(home,'pty-hosts','invalid.json'),secret,{mode:0o600});
 const output=[],error=console.error,exec=cp.execFileSync,calls=[];console.error=(...args)=>output.push(args.join(' '));cp.execFileSync=(...args)=>{calls.push(args);return 'bounded process evidence';};
 try{
  const proof={state:'unknown',hosts:[{pid:123,startTime:'recorded-start',state:'unknown'}]};diagnostics.creationFailure(home,proof,Error('original refusal'));
  diagnostics.cleanupFailure(home,[{pid:123,startIdentity:'1:2'}],Object.assign(Error('original cleanup'),{code:'ENOTEMPTY'}));
  assert.equal(output.length,2);assert.ok(output.every(line=>!line.includes(secret)));
  const creation=JSON.parse(output[0].slice(output[0].indexOf(' ')+1)),cleanup=JSON.parse(output[1].slice(output[1].indexOf(' ')+1));
  assert.deepEqual(creation.refusalProof,proof);assert.equal(creation.records[0].pid,123);assert.equal(creation.records[0].startTime,'recorded-start');assert.equal(typeof creation.records[0].stat.mtimeMs,'number');assert.equal(creation.owner.startIdentity,'1:2');assert.equal(typeof creation.monotonicMs,'number');
  assert.match(cleanup.error,/original cleanup/);assert.ok(cleanup.remaining.some(item=>item.path==='pty-handover.secret.json'));assert.equal(cleanup.processes.known[0].startIdentity,'1:2');assert.equal(cleanup.openFiles,'bounded process evidence');
  const psCalls=calls.filter(([command])=>command==='ps');assert.ok(psCalls.length>0);assert.ok(psCalls.every(([_command,args])=>args.at(-1)==='pid=,ppid=,pgid=,stat=,lstart=,comm='));
  assert.ok(calls.some(([command])=>command==='lsof'));assert.ok(calls.every(([_command,_args,options])=>options.timeout===1000&&options.maxBuffer===65536));
 }finally{console.error=error;cp.execFileSync=exec;fs.rmSync(root,{recursive:true,force:true});}
});

test('real controls helper prints the original START_BLOCKED proof and still fails without creating a host',()=>{
 const home=process.env.AYA_HOME;fs.mkdirSync(path.join(home,'pty-hosts'),{recursive:true});
 fs.chmodSync(path.join(home,'pty-hosts'),0o777);
 const file=path.join(home,'pty-hosts',`${process.pid}.json`);fs.writeFileSync(file,JSON.stringify({pid:process.pid,pgid:process.pid,startTime:'unverified fixture',nonce:'PRIVATE_RECORD_FIELD'}),{mode:0o644});
 fs.chmodSync(file,0o644);
 fs.chmodSync(path.join(home,'pty-hosts'),0o777);
 const file=path.join(home,'pty-hosts',`${process.pid}.json`);fs.writeFileSync(file,JSON.stringify({pid:process.pid,pgid:process.pid,startTime:'unverified fixture',nonce:'PRIVATE_RECORD_FIELD'}),{mode:0o644});
 fs.chmodSync(file,0o644);
 try{
  const child=cp.spawnSync(process.execPath,['tests/helpers/pty-host-auth-controls.cjs','publish-planned'],{encoding:'utf8',timeout:10000,maxBuffer:262144,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  assert.equal(child.status,1,child.stderr);assert.match(child.stderr,/PTY_HOST_START_BLOCKED/);
  const lines=child.stderr.split('\n').filter(line=>line.startsWith('PTY_FIXTURE_CREATION_REFUSAL '));assert.ok(lines.length>=1);
  const evidence=JSON.parse(lines[0].slice(lines[0].indexOf(' ')+1));assert.equal(evidence.refusalProof.state,'unknown');assert.equal(evidence.records[0].pid,process.pid);assert.equal(evidence.records[0].stat.mode,0o644);
  assert.ok(!child.stderr.includes('PRIVATE_RECORD_FIELD'));assert.equal(fs.existsSync(path.join(home,'pty-host.sock')),false);assert.equal(fs.existsSync(path.join(home,'pty-owner/record.json')),false);assert.equal(fs.existsSync(path.join(home,'pty-host-auth/key')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('controls helper retires a started host when its parent IPC channel is missing',{timeout:30000},async()=>{
 const home=process.env.AYA_HOME;fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(home,{recursive:true,mode:0o700});
 const {ownerProcessStartIdentity}=require('../dist-electron/pty-owner-client.js');
 let hostPid,hostStartIdentity;
 try{
  const child=cp.spawnSync(process.execPath,['tests/helpers/pty-host-auth-controls.cjs','publish-planned'],{encoding:'utf8',timeout:25000,maxBuffer:262144,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  const marker=child.stderr.split('\n').find(line=>line.startsWith('PTY_FIXTURE_PARENT_CHANNEL_MISSING '));
  if(marker)({hostPid,hostStartIdentity}=JSON.parse(marker.slice(marker.indexOf(' ')+1)));
  assert.equal(child.status,1,child.stderr);assert.match(child.stderr,/requires an IPC parent channel/);
  assert.ok(marker,'helper reports the exact host identity it must clean up');assert.ok(Number.isSafeInteger(hostPid));assert.match(hostStartIdentity,/^\d+:\d+$/);
  assert.notEqual(ownerProcessStartIdentity(hostPid),hostStartIdentity,'failed handoff left its exact PTY host alive');
  assert.equal(fs.existsSync(path.join(home,'pty-host.sock')),false,'failed handoff left a socket behind');
  assert.equal(fs.existsSync(path.join(home,'pty-owner','record.json')),false,'failed handoff left its native owner behind');
  // Host records remain as absence-proof evidence after a clean shutdown.
 }finally{
  if(hostPid&&hostStartIdentity&&ownerProcessStartIdentity(hostPid)===hostStartIdentity){
   process.kill(hostPid,'SIGTERM');const deadline=Date.now()+3000;
   while(ownerProcessStartIdentity(hostPid)===hostStartIdentity&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
   if(ownerProcessStartIdentity(hostPid)===hostStartIdentity)process.kill(hostPid,'SIGKILL');
  }
  await import('./helpers/pty-host.mjs').then(({cleanupNativeOwner})=>cleanupNativeOwner(home));
  fs.rmSync(root,{recursive:true,force:true});
 }
});
