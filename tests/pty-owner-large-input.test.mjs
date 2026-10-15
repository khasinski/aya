import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanupNativeOwner } from './helpers/pty-host.mjs';
fs.mkdirSync('test-results',{recursive:true});
test('a 1 MiB paste behind foreground sleep yields to another pane and arrives in order once input resumes',async()=>{
 const home=fs.mkdtempSync(path.resolve('test-results/large-input-'));
 try {
  const {stdout}=await promisify(execFile)(process.execPath,['tests/helpers/pty-owner-large-input.cjs'],{env:{...process.env,AYA_HOME:home,HOME:home},timeout:15000});
  assert.match(stdout,/large input ordered; second pane responsive/);
 } finally { await cleanupNativeOwner(home); fs.rmSync(home,{recursive:true,force:true}); }
});
