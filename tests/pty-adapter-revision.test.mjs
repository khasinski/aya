import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),native=require('../dist-electron/pty-owner-client.js');
const {OwnerPty}=require('../dist-electron/pty-owner-adapter.js');
const fake=()=>Object.assign(Object.create(OwnerPty.prototype),{pane:{fd:9876},owner:{client:{isConnected:()=>true}},operation:Promise.resolve(),writeOutcomes:new Set(),exited:null,readEnded:false,mutationsGated:false});
const stale=()=>Object.assign(Error('The screen changed. This input was not sent.'),{code:'PTY_HOST_STALE_REVISION'});
test('the adapter checks a fence after queued work, with zero master write attempts on refusal',async()=>{
 const p=fake(),original=fs.writeSync;let release,writes=0,current=true;
 p.operation=new Promise(resolve=>release=resolve);fs.writeSync=()=>{writes++;return 1;};
 try{
  const writing=p.writeAsync('X',()=>{if(!current)throw stale();});current=false;release();
  await assert.rejects(writing,{code:'PTY_HOST_STALE_REVISION'});assert.equal(writes,0);
 }finally{fs.writeSync=original;}
});
test('an EAGAIN before the first byte must recheck the fence after yielding, not send stale input',async()=>{
 const p=fake(),original=fs.writeSync,ready=native.ownerMasterWriteReady;let attempts=0,current=true,delivered='';
 native.ownerMasterWriteReady=()=>true;
 fs.writeSync=(_fd,bytes,offset,length)=>{attempts++;if(attempts===1){current=false;throw Object.assign(Error('full'),{code:'EAGAIN'});}delivered+=bytes.subarray(offset,offset+length);return length;};
 try{
  await assert.rejects(p.writeAsync('X',()=>{if(!current)throw stale();}),{code:'PTY_HOST_STALE_REVISION'});
  assert.equal(attempts,1);assert.equal(delivered,'');
 }finally{fs.writeSync=original;native.ownerMasterWriteReady=ready;}
});
test('a revision change after a partial write cannot relabel accepted bytes as not sent',async()=>{
 const p=fake(),original=fs.writeSync,ready=native.ownerMasterWriteReady;let attempts=0,checks=0,current=true,delivered='';
 native.ownerMasterWriteReady=()=>true;
 fs.writeSync=(_fd,bytes,offset,length)=>{attempts++;if(attempts===1){delivered+=bytes.subarray(offset,offset+1);current=false;return 1;}if(attempts===2)throw Object.assign(Error('full'),{code:'EAGAIN'});delivered+=bytes.subarray(offset,offset+length);return length;};
 try{
  await p.writeAsync('XY',()=>{checks++;if(!current)throw stale();});
  assert.equal(delivered,'XY');assert.equal(attempts,3);assert.equal(checks,2,'check on queue entry and before the first byte only');
 }finally{fs.writeSync=original;native.ownerMasterWriteReady=ready;}
});
