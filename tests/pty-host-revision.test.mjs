import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});
const root=fs.mkdtempSync(path.resolve('test-results/revision-host-'));isolateHome(root);
const {PtyHostClient}=await import('../dist-electron/pty-host-client.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
const wait=async predicate=>{const deadline=Date.now()+8000;while(!await predicate()){if(Date.now()>deadline)throw Error('revision host timeout');await new Promise(done=>setTimeout(done,5));}};
const fence=s=>({generation:s.generation,revision:s.revision});
test('real host fences the first automatic write after a rule reload and accepts current input exactly once',async()=>{
 const wrapper=path.resolve(`dist-electron/pty-host-revision-${process.pid}.js`),script=path.join(process.env.HOME,'reader.cjs'),inputs=path.join(process.env.HOME,'input.log'),release=path.join(process.env.HOME,'release');
 fs.mkdirSync(process.env.HOME,{recursive:true});
 // Deliberately suppress fanout, not parser application: main cannot learn
 // the new revision from an event before the checked request reaches host.
 fs.writeFileSync(wrapper,`const vt=require('./vt-mirror'),open=vt.openVtPane;vt.openVtPane=(...args)=>{open(...args);Object.defineProperty(vt.panes.get(args[0]),'onSnapshot',{get:()=>undefined,set:()=>{}});};require('./pty-host');`);
 fs.writeFileSync(script,`const fs=require('fs'),readline=require('readline'),release=process.argv[2],inputs=process.argv[3];console.log('Do you want to proceed?');let previous='';setInterval(()=>{if(fs.existsSync(release)){const value=fs.readFileSync(release,'utf8');if(value!==previous){previous=value;console.log(value==='go'?'NEW_APPROVAL':'SECOND_APPROVAL');}}},5);readline.createInterface({input:process.stdin}).on('line',line=>{fs.appendFileSync(inputs,line+'\\n');console.log('REPLY:'+line);});`);
 const c=new PtyHostClient(wrapper),events=[];c.attachWebContents({isDestroyed:()=>false,send:(_channel,event)=>events.push(event)});
 try{
  const quoted=s=>"'"+s.split("'").join("'"+String.fromCharCode(92)+"''")+"'";
  await c.spawn({ptyId:'p',agent:'custom',command:`stty -echo; exec ${quoted(process.execPath)} ${quoted(script)} ${quoted(release)} ${quoted(inputs)}`,cwd:process.env.HOME,cols:80,rows:24});
  await wait(async()=>(await c.getBuffer('p')).includes('Do you want to proceed?'));
  const before=await c.request({id:0,type:'snapshot',ptyId:'p'}),pid=await c.getPid('p');
  assert.ok(before.revision);assert.equal(await c.checkSnapshot('p',fence(before)),true);
  fs.writeFileSync(release,'go');await wait(async()=>(await c.getBuffer('p')).includes('NEW_APPROVAL'));
  assert.equal(events.filter(e=>e.type==='vt-status').length,0,'fanout stays absent');
  assert.equal(await c.checkSnapshot('p',fence(before)),false);
  assert.equal(await c.markComposerAtSnapshot('p',fence(before)),false);
  await assert.rejects(c.writeAtSnapshot('p','BAD\n',fence(before)),error=>error.code==='PTY_HOST_STALE_REVISION'&&error.message.includes('not sent'));
  assert.equal(fs.existsSync(inputs),false);assert.equal(await c.getPid('p'),pid);
  const {GuardedRuleInput}=await import('../dist-electron/screen-user-rule-input.js'),{UserRuleRuntime}=await import('../dist-electron/screen-user-rule-runtime.js'),{RULE_AGENTS}=await import('../dist-electron/screen-rule-data.js');
  const runtime=new UserRuleRuntime(),rule={id:'local-never',kind:'prompt',region:'tail',pattern:'NEVER_LOCAL_RULE',flags:'',source:'user/claude.json',version:'local-1'},manifest={digest:'a'.repeat(64),sets:Object.fromEntries(RULE_AGENTS.map(a=>[a,[rule]])),files:[]};
  assert.equal(await runtime.replace(manifest),true);
  const reloadedManifest={...manifest,digest:'b'.repeat(64),sets:Object.fromEntries(RULE_AGENTS.map(a=>[a,[{...rule,version:'local-2'}]]))};
  assert.equal(await runtime.replace(reloadedManifest),true,'the new worker candidate is active before its first automatic write');
  const configuration={epoch:2,available:true,manifest:reloadedManifest};let attempts=0;
  const input=new GuardedRuleInput({configuration:()=>configuration,evaluate:r=>runtime.evaluate(r)},{snapshot:id=>c.appliedSnapshotForRules(id),check:(id,f)=>c.checkSnapshot(id,f),writeLegacy:()=>{throw Error('NO UNFENCED FALLBACK');},writeFenced:async(id,data,f)=>{
   attempts++;fs.writeFileSync(release,'next');await wait(async()=>(await c.getBuffer('p')).includes('SECOND_APPROVAL'));
   return c.writeAtSnapshot(id,data,f);
  }});
  try{
   await assert.rejects(input.write('direct','p','BAD_THROUGH_RULES\n',{phase:'paste'}),e=>e.code==='PTY_HOST_STALE_REVISION'&&/not sent/.test(e.message));
   assert.equal(attempts,1);assert.equal(fs.existsSync(inputs),false);assert.equal(await c.getPid('p'),pid);assert.equal(events.filter(e=>e.type==='vt-status').length,0);
  }finally{input.dispose();await runtime.dispose();}
  const current=await c.request({id:0,type:'snapshot',ptyId:'p'});assert.equal(current.generation,before.generation);assert.notEqual(current.revision,before.revision);
  for(const type of ['snapshot-check','composer-seen-checked','write-fenced']){
   const response=await new Promise((resolve,reject)=>{
    const socket=net.createConnection(path.join(process.env.AYA_HOME,'pty-host.sock'));let reply='';const timer=setTimeout(()=>{socket.destroy();reject(Error('unauthenticated fenced RPC was not promptly refused'));},3000);
    socket.setEncoding('utf8');socket.on('data',chunk=>reply+=chunk);socket.on('error',error=>{if(error.code!=='ECONNRESET'){clearTimeout(timer);reject(error);}});socket.once('close',()=>{clearTimeout(timer);resolve(reply);});
    socket.once('connect',()=>socket.write(JSON.stringify({id:900,type,ptyId:'p',fence:fence(current),...(type==='write-fenced'?{data:'UNAUTHENTICATED_BAD\n'}:{})})+'\n'));
   });
   if(response)assert.deepEqual(JSON.parse(response),{id:-1,ok:false,code:'PTY_HOST_AUTH_REQUIRED',error:'Terminal host authentication required'},'only the fixed authentication refusal may precede proof');assert.equal(await c.checkSnapshot('p',fence(current)),true,'unauthenticated composer ACK cannot mutate the revision');assert.equal(fs.existsSync(inputs),false);
  }

  assert.equal(await c.writeAtSnapshot('p','GOOD\n',fence(current)),true);
  await wait(()=>fs.existsSync(inputs)&&fs.readFileSync(inputs,'utf8')==='GOOD\n');
  await wait(async()=>(await c.getBuffer('p')).includes('REPLY:GOOD'));
  assert.equal(fs.readFileSync(inputs,'utf8'),'GOOD\n');
  const ack=await c.request({id:0,type:'snapshot',ptyId:'p'});assert.equal(await c.markComposerAtSnapshot('p',fence(ack)),true);
  const seen=await c.request({id:0,type:'snapshot',ptyId:'p'});assert.equal(seen.composerSeen,true);assert.notEqual(seen.revision,ack.revision);
  await c.shutdown();
 }finally{c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);fs.rmSync(wrapper,{force:true});fs.rmSync(root,{recursive:true,force:true});}
});
