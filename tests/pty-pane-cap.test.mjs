import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'aya-pane-cap-'));
process.env.AYA_HOME=path.join(root,'aya');
const require=createRequire(import.meta.url);
const {MAX_PTY_PANES}=require('../dist-electron/pty-pane-limits.js');
const {MAX_CHECKPOINT_PANES}=require('../dist-electron/vt-checkpoint-schema.js');
const {OwnerPty}=require('../dist-electron/pty-owner-adapter.js');
const {spawnPty}=require('../dist-electron/pty-core.js');

test('owner, checkpoint and recovery counts come from the same pane limit',()=>{
  assert.equal(MAX_PTY_PANES,128);
  assert.equal(MAX_CHECKPOINT_PANES,MAX_PTY_PANES);
  const build=JSON.parse(fs.readFileSync('dist-electron/pty-owner-build.json','utf8'));
  assert.equal(build.maxPanes,MAX_PTY_PANES);
});

test('pane cap refusal shows recovery guidance without a command failure exit 127',async(t)=>{
  t.mock.method(OwnerPty,'spawn',async()=>{throw Object.assign(new Error('Pane limit reached'),{code:'OWNER_REJECTED'});});
  const events=[];
  const sink={isDestroyed:()=>false,sendPtyEvent:event=>events.push(event)};
  const cwd=process.cwd();
  await spawnPty({ptyId:'at-cap',command:'sleep 30',cwd,cols:80,rows:24},sink,{
    prepare:async()=>({argv:['/bin/sleep','30'],env:{PATH:'/usr/bin:/bin'},command:'sleep 30',launch:{command:'sleep 30',cwd},ownSessionId:null,spawnedAt:Date.now()}),
  });
  const failure=events.find(event=>event.type==='spawn-failed');
  assert.equal(failure?.reason,'pane-limit-reached');
  assert.equal(failure?.detail,'Aya can run at most 128 terminals at once. Close a terminal you no longer need, then restart this tab.');
  const banner=events.find(event=>event.type==='data')?.chunk??'';
  assert.match(banner,/Aya can run at most 128 terminals at once/);
  assert.match(banner,/Close a terminal you no longer need/);
  assert.equal(events.some(event=>event.type==='exit'),false);
});

test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
