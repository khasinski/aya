import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanupNativeOwner } from './helpers/pty-host.mjs';
fs.mkdirSync('test-results',{recursive:true});
test('a real core 1 MiB paste yields to resize and another pane, then arrives exactly once without trailing bytes',async()=>{
 const home=fs.mkdtempSync(path.resolve('test-results/large-input-'));
 try {
  const {stdout}=await promisify(execFile)(process.execPath,['tests/helpers/pty-owner-large-input.cjs'],{env:{...process.env,AYA_HOME:home,HOME:home},timeout:15000});
  assert.match(stdout,/core input ordered with exact count\/no trailing bytes; resize and second pane responsive/);
 } finally { await cleanupNativeOwner(home); fs.rmSync(home,{recursive:true,force:true}); }
});
test('a real core rechecks queued input after resize and refuses it without any bytes',async()=>{
 const home=fs.mkdtempSync(path.resolve('test-results/fenced-large-input-'));
 try{
  const {stdout}=await promisify(execFile)(process.execPath,['tests/helpers/pty-owner-large-input.cjs'],{env:{...process.env,AYA_HOME:home,HOME:home,AYA_TEST_FENCED_INPUT:'1'},timeout:15000});
  assert.match(stdout,/stale checked input refused after queued paste; zero trailing input/);
 }finally{await cleanupNativeOwner(home);fs.rmSync(home,{recursive:true,force:true});}
});
