import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { recoverOwnerProcessGroup, ownerRecoverySupported, ownerProcessStartIdentity } from '../dist-electron/pty-owner-client.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
fs.mkdirSync('test-results',{recursive:true});
test('a durable spawn intent blocks replacement after JS dies after fork before reply and then the owner dies',{timeout:20000},async()=>{
 const home=fs.mkdtempSync(path.resolve('test-results/spawn-intent-')),file=path.join(home,'pty-owner/record.json');
 const env={...process.env,AYA_HOME:home,HOME:home};
 const host=spawn(process.execPath,['tests/helpers/pty-owner-lost-spawn-intent.cjs'],{env,stdio:['ignore','ignore','pipe']});
 const closed=once(host,'exit'); let forked;
 try {
  let errors='';host.stderr.on('data',s=>errors+=s);
  assert.equal((await closed)[1],'SIGKILL',errors);
  forked=JSON.parse(fs.readFileSync(path.join(home,'forked.json')));
  const record=JSON.parse(fs.readFileSync(file));
  assert.deepEqual(record.panes,[]); assert.deepEqual(record.uncertain,['intent']);
  assert.equal(record.spawnIntents[0].id,'intent'); assert.match(record.spawnIntents[0].generation,/^[a-f0-9]{32}$/);
  process.kill(forked.pid,'SIGKILL'); while(alive(forked.pid))await sleep(5);
  assert.equal(alive(forked.pane.pid),true);
  const source=`const assert=require('node:assert/strict'); const {getOwnerRuntime}=require('./dist-electron/pty-owner-runtime.js');const {OwnerPty}=require('./dist-electron/pty-owner-adapter.js');(async()=>{const o=await getOwnerRuntime();assert.equal(o.incompatible,true);assert.deepEqual(o.record.uncertain,['intent']);await assert.rejects(OwnerPty.spawn({id:'intent'}),/disconnected or incompatible/);console.log('blocked');})().catch(e=>{console.error(e);process.exitCode=1;});`;
  const {stdout}=await promisify(execFile)(process.execPath,['-e',source],{env,timeout:5000}); assert.match(stdout,/blocked/);
  assert.equal(alive(forked.pane.pid),true); assert.equal(JSON.parse(fs.readFileSync(file)).pid,forked.pid);
 } finally {
  if(host.exitCode===null&&host.signalCode===null){host.kill('SIGKILL');await closed;}
  if(forked?.pane) {
   if(ownerRecoverySupported())recoverOwnerProcessGroup(forked.pane.pid,forked.pane.startIdentity);
   else if(ownerProcessStartIdentity(forked.pane.pid)===forked.pane.startIdentity)process.kill(forked.pane.pid,'SIGKILL');
  }
  fs.rmSync(home,{recursive:true,force:true});
 }
});
