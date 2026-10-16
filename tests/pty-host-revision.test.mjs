import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});
const root=fs.mkdtempSync(path.resolve('test-results/revision-host-'));isolateHome(root);
const {PtyHostClient}=await import('../dist-electron/pty-host-client.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
const wait=async predicate=>{const deadline=Date.now()+8000;while(!await predicate()){if(Date.now()>deadline)throw Error('revision host timeout');await new Promise(done=>setTimeout(done,5));}};
const fence=s=>({generation:s.generation,revision:s.revision});
test('real host refuses stale snapshot ACK/input and accepts current input exactly once without broadcasts',async()=>{
 const wrapper=path.resolve(`dist-electron/pty-host-revision-${process.pid}.js`),script=path.join(process.env.HOME,'reader.cjs'),inputs=path.join(process.env.HOME,'input.log'),release=path.join(process.env.HOME,'release');
 fs.mkdirSync(process.env.HOME,{recursive:true});
 // Deliberately suppress fanout, not parser application: main cannot learn
 // the new revision from an event before the checked request reaches host.
 fs.writeFileSync(wrapper,`const vt=require('./vt-mirror'),open=vt.openVtPane;vt.openVtPane=(...args)=>{open(...args);Object.defineProperty(vt.panes.get(args[0]),'onSnapshot',{get:()=>undefined,set:()=>{}});};require('./pty-host');`);
 fs.writeFileSync(script,`const fs=require('fs'),readline=require('readline');console.log('Do you want to proceed?');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);console.log('NEW_APPROVAL');}},5);readline.createInterface({input:process.stdin}).on('line',line=>{fs.appendFileSync(${JSON.stringify(inputs)},line+'\\n');console.log('REPLY:'+line);});`);
 const c=new PtyHostClient(wrapper),events=[];c.attachWebContents({isDestroyed:()=>false,send:(_channel,event)=>events.push(event)});
 try{
  const quoted=s=>"'"+s.split("'").join("'"+String.fromCharCode(92)+"''")+"'";
  await c.spawn({ptyId:'p',agent:'custom',command:`stty -echo; exec ${quoted(process.execPath)} ${quoted(script)}`,cwd:process.env.HOME,cols:80,rows:24});
  await wait(async()=>(await c.getBuffer('p')).includes('Do you want to proceed?'));
  const before=await c.request({id:0,type:'snapshot',ptyId:'p'}),pid=await c.getPid('p');
  assert.ok(before.revision);assert.equal(await c.checkSnapshot('p',fence(before)),true);
  fs.writeFileSync(release,'go');await wait(async()=>(await c.getBuffer('p')).includes('NEW_APPROVAL'));
  assert.equal(events.filter(e=>e.type==='vt-status').length,0,'fanout stays absent');
  assert.equal(await c.checkSnapshot('p',fence(before)),false);
  assert.equal(await c.markComposerAtSnapshot('p',fence(before)),false);
  await assert.rejects(c.writeAtSnapshot('p','BAD\n',fence(before)),error=>error.code==='PTY_HOST_STALE_REVISION'&&error.message.includes('not sent'));
  assert.equal(fs.existsSync(inputs),false);assert.equal(await c.getPid('p'),pid);
  const current=await c.request({id:0,type:'snapshot',ptyId:'p'});assert.equal(current.generation,before.generation);assert.notEqual(current.revision,before.revision);
  assert.equal(await c.writeAtSnapshot('p','GOOD\n',fence(current)),true);
  await wait(()=>fs.existsSync(inputs)&&fs.readFileSync(inputs,'utf8')==='GOOD\n');
  await wait(async()=>(await c.getBuffer('p')).includes('REPLY:GOOD'));
  assert.equal(fs.readFileSync(inputs,'utf8'),'GOOD\n');
  const ack=await c.request({id:0,type:'snapshot',ptyId:'p'});assert.equal(await c.markComposerAtSnapshot('p',fence(ack)),true);
  const seen=await c.request({id:0,type:'snapshot',ptyId:'p'});assert.equal(seen.composerSeen,true);assert.notEqual(seen.revision,ack.revision);
  await c.shutdown();
 }finally{c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);fs.rmSync(wrapper,{force:true});fs.rmSync(root,{recursive:true,force:true});}
});
