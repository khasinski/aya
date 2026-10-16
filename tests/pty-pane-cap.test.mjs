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
const {spawnPty,killPty}=require('../dist-electron/pty-core.js');
const {getOwnerRuntime,currentOwnerRuntime,shutdownOwnerRuntime}=require('../dist-electron/pty-owner-runtime.js');

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

test('a real owner frees a pane slot and accepts a retry for the same refused pane id',{timeout:90000},async()=>{
  const events=[];
  const sink={isDestroyed:()=>false,sendPtyEvent:event=>events.push(event)};
  const cwd=process.cwd();
  const request=ptyId=>({ptyId,command:'sleep 30',cwd,cols:80,rows:24});
  const services={prepare:async req=>({
    argv:['/bin/sleep','30'],env:{PATH:'/usr/bin:/bin'},command:req.command,
    launch:{command:req.command,cwd},ownSessionId:null,spawnedAt:Date.now(),
  })};
  await getOwnerRuntime();
  const paneIds=Array.from({length:MAX_PTY_PANES},(_,index)=>`cap-live-${index}`);
  try{
    for(const ptyId of paneIds)await spawnPty(request(ptyId),sink,services);
    const owner=currentOwnerRuntime();
    assert.ok(owner);
    assert.equal(owner.record.panes.length,MAX_PTY_PANES);
    assert.deepEqual(owner.record.spawnIntents,[]);

    await spawnPty(request('cap-retry'),sink,services);
    const firstFailure=events.find(event=>event.type==='spawn-failed'&&event.ptyId==='cap-retry');
    assert.equal(firstFailure?.reason,'pane-limit-reached');
    assert.equal(events.some(event=>event.type==='exit'&&event.ptyId==='cap-retry'),false);
    assert.deepEqual(owner.record.spawnIntents,[],'a rejected spawn must not leave a durable intent');
    assert.ok(!owner.record.uncertain?.includes('cap-retry'));

    await killPty(paneIds[0]);
    const deadline=Date.now()+5000;
    while(owner.record.panes.length!==MAX_PTY_PANES-1&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(owner.record.panes.length,MAX_PTY_PANES-1,'the freed slot is reflected in the native inventory');

    await spawnPty(request('cap-retry'),sink,services);
    assert.equal(owner.record.panes.length,MAX_PTY_PANES);
    assert.ok(owner.record.panes.some(pane=>pane.id==='cap-retry'));
    assert.deepEqual(owner.record.spawnIntents,[]);
    assert.ok(!owner.record.uncertain?.includes('cap-retry'));
    assert.equal(events.filter(event=>event.type==='spawn-failed'&&event.ptyId==='cap-retry').length,1);
  }finally{
    await Promise.all([...paneIds,'cap-retry'].map(ptyId=>killPty(ptyId).catch(()=>{})));
    await shutdownOwnerRuntime();
  }
});

test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
