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
  await assert.rejects(c.writeAtSnapshot('p','BAD\n',fence(before),'a'.repeat(32)+':1'),error=>error.code==='PTY_HOST_STALE_REVISION'&&error.message.includes('not sent'));
  assert.equal(fs.existsSync(inputs),false);assert.equal(await c.getPid('p'),pid);
  const {GuardedRuleInput}=await import('../dist-electron/screen-user-rule-input.js'),{UserRuleRuntime}=await import('../dist-electron/screen-user-rule-runtime.js'),{RULE_AGENTS}=await import('../dist-electron/screen-rule-data.js');
  const runtime=new UserRuleRuntime(),rule={id:'local-never',kind:'prompt',region:'tail',pattern:'NEVER_LOCAL_RULE',flags:'',source:'user/claude.json',version:'local-1'},manifest={digest:'a'.repeat(64),sets:Object.fromEntries(RULE_AGENTS.map(a=>[a,[rule]])),files:[]};
  assert.equal(await runtime.replace(manifest),true);
  const reloadedManifest={...manifest,digest:'b'.repeat(64),sets:Object.fromEntries(RULE_AGENTS.map(a=>[a,[{...rule,version:'local-2'}]]))};
  assert.equal(await runtime.replace(reloadedManifest),true,'the new worker candidate is active before its first automatic write');
  const configuration={epoch:2,available:true,manifest:reloadedManifest};let attempts=0;
  const input=new GuardedRuleInput({configuration:()=>configuration,evaluate:r=>runtime.evaluate(r)},{snapshot:id=>c.appliedSnapshotForRules(id),check:(id,f)=>c.checkSnapshot(id,f),writeLegacy:()=>{throw Error('NO UNFENCED FALLBACK');},writeFenced:async(id,data,f)=>{
   attempts++;fs.writeFileSync(release,'next');await wait(async()=>(await c.getBuffer('p')).includes('SECOND_APPROVAL'));
   return c.writeAtSnapshot(id,data,f,'a'.repeat(32)+':2');
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
    socket.once('connect',()=>socket.write(JSON.stringify({id:900,type,ptyId:'p',fence:fence(current),...(type==='write-fenced'?{data:'UNAUTHENTICATED_BAD\n',policyEpoch:2}:{})})+'\n'));
   });
   if(response)assert.deepEqual(JSON.parse(response),{id:-1,ok:false,code:'PTY_HOST_AUTH_REQUIRED',error:'Terminal host authentication required'},'only the fixed authentication refusal may precede proof');assert.equal(await c.checkSnapshot('p',fence(current)),true,'unauthenticated composer ACK cannot mutate the revision');assert.equal(fs.existsSync(inputs),false);
  }

  assert.equal(await c.writeAtSnapshot('p','GOOD\n',fence(current),'a'.repeat(32)+':2'),true);
  await wait(()=>fs.existsSync(inputs)&&fs.readFileSync(inputs,'utf8')==='GOOD\n');
  await wait(async()=>(await c.getBuffer('p')).includes('REPLY:GOOD'));
  assert.equal(fs.readFileSync(inputs,'utf8'),'GOOD\n');
  const ack=await c.request({id:0,type:'snapshot',ptyId:'p'});assert.equal(await c.markComposerAtSnapshot('p',fence(ack)),true);
  const seen=await c.request({id:0,type:'snapshot',ptyId:'p'});assert.equal(seen.composerSeen,true);assert.notEqual(seen.revision,ack.revision);
  await c.shutdown();
 }finally{c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);fs.rmSync(wrapper,{force:true});fs.rmSync(root,{recursive:true,force:true});}
});

test('a policy reload invalidates an evaluated automatic write while it waits in the real host input queue',async()=>{
 const home=root;fs.mkdirSync(home,{recursive:true});fs.mkdirSync(process.env.HOME,{recursive:true});
 const wrapper=path.resolve(`dist-electron/pty-host-policy-${process.pid}.js`);
 const script=path.join(home,'reader.cjs'),gate=path.join(home,'read-input'),log=path.join(home,'received.log');fs.mkdirSync(home,{recursive:true});
 fs.writeFileSync(wrapper,"require('./pty-host');\n");
 fs.writeFileSync(script,`const fs=require('fs'),gate=process.argv[2],log=process.argv[3];let bytes=0,bad=false,tail='',settle=null;console.log('QUEUE_READY');const timer=setInterval(()=>{if(!fs.existsSync(gate))return;clearInterval(timer);process.stdin.on('data',chunk=>{const text=tail+chunk.toString();bytes+=chunk.length;if(text.includes('BAD_AUTOMATIC'))bad=true;if(text.includes('FILL_END')&&!settle)settle=setTimeout(()=>fs.writeFileSync(log,JSON.stringify({bytes,bad})),100);tail=text.slice(-64);});process.stdin.resume();},5);`);
 const quote=s=>"'"+s.split("'").join("'"+String.fromCharCode(92)+"''")+"'";
 const c=new PtyHostClient(wrapper),wait=async predicate=>{const end=Date.now()+12000;while(!await predicate()){if(Date.now()>end)throw Error('queued policy fence timed out');await new Promise(resolve=>setTimeout(resolve,5));}};
 const bounded=promise=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('queued policy acknowledgement timed out')),12000);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
 let resolveFirst,resolveSecond;const firstSent=new Promise(resolve=>resolveFirst=resolve),secondSent=new Promise(resolve=>resolveSecond=resolve),send=c.sendRequest.bind(c);
 c.sendRequest=(socket,request)=>{const result=send(socket,request);if(request.type==='write-fenced'&&request.data.startsWith('FILL\n'))resolveFirst();if(request.type==='write-fenced'&&request.data==='BAD_AUTOMATIC\n')resolveSecond();return result;};
 const {GuardedRuleInput}=await import('../dist-electron/screen-user-rule-input.js'),{UserRuleRuntime}=await import('../dist-electron/screen-user-rule-runtime.js'),{RULE_AGENTS}=await import('../dist-electron/screen-rule-data.js');
 const runtime=new UserRuleRuntime(),sets=Object.fromEntries(RULE_AGENTS.map(agent=>[agent,[]])),manifest={digest:'a'.repeat(64),sets,files:[]},instance='c'.repeat(32),token=epoch=>`${instance}:${epoch}`;await runtime.replace(manifest);
 let config={epoch:10,available:true,manifest},filling,automatic;const input=new GuardedRuleInput({configuration:()=>config,evaluate:request=>runtime.evaluate(request)},{snapshot:id=>c.appliedSnapshotForRules(id),check:(id,fence)=>c.checkSnapshot(id,fence),writeLegacy:()=>{throw Error('unfenced fallback');},writeFenced:(id,data,fence,epoch)=>c.writeAtSnapshot(id,data,fence,token(epoch))});
 try{
  c.attachWebContents({isDestroyed:()=>false,send:()=>{}});
  await c.spawn({ptyId:'queued',agent:'custom',command:`stty raw -echo; exec ${quote(process.execPath)} ${quote(script)} ${quote(gate)} ${quote(log)}`,cwd:home,cols:80,rows:24});
  await wait(async()=>(await c.getBuffer('queued')).includes('QUEUE_READY'));
  const snapshot=await c.appliedSnapshotForRules('queued'),fence={generation:snapshot.generation,revision:snapshot.revision};
  assert.ok(fence.revision);assert.equal(await c.setUserRulePolicyEpoch(token(10)),true);
  const filler='FILL\n'+'A'.repeat(256_000)+'FILL_END';filling=c.writeAtSnapshot('queued',filler,fence,token(10));await bounded(firstSent);
  automatic=input.write('direct','queued','BAD_AUTOMATIC\n',{phase:'paste'});await bounded(secondSent);
  const newer={...manifest,digest:'b'.repeat(64)};assert.equal(await runtime.replace(newer),true);config={epoch:11,available:true,manifest:newer};
  assert.equal(await c.setUserRulePolicyEpoch(token(11)),true,'the host observes the reload while the checked input is still queued');
  fs.writeFileSync(gate,'read');await filling;
  await assert.rejects(automatic,error=>error.code==='PTY_HOST_RULES_CHANGED'&&error.message.includes('not sent'));
  await wait(()=>fs.existsSync(log));
  const received=JSON.parse(fs.readFileSync(log,'utf8'));assert.ok(received.bytes>=filler.length);assert.equal(received.bad,false,'the old-policy automatic write never reached the child');
 }finally{
  fs.writeFileSync(gate,'read');await Promise.allSettled([filling,automatic].filter(Boolean));input.dispose();await runtime.dispose();await c.shutdown().catch(()=>{});c.dispose();c.dropSocket();await cleanupNativeOwner(process.env.AYA_HOME);fs.rmSync(wrapper,{force:true});fs.rmSync(home,{recursive:true,force:true});
 }
});
