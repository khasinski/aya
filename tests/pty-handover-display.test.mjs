import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/handover-displays-'));process.env.AYA_HOME=root;
const require=createRequire(import.meta.url),{HandoverDisplays}=require('../dist-electron/pty-handover-display.js');
const store=require('../dist-electron/pty-checkpoint-store.js');
const payload=require('../dist-electron/pty-checkpoint-payload.js');
const {createRendererVt,captureRendererVt}=require('../dist-test/terminal-vt-checkpoint.js');
const displayRoot=path.join(root,'pty-handover-display');
const base=()=>({deadline:Date.now()+10000,eligible:[{id:'p',generation:'g',outputEnd:77}],ineligible:[],consented:[],coreRawBytes:0,coreEncodedBytes:0,displayRawBytes:0,displayEncodedBytes:0,display:null});
function ipc(){const handlers=new Map(),listeners=new Map();return{handlers,listeners,handle:(n,f)=>handlers.set(n,f),on:(n,f)=>listeners.set(n,f)};}
test('actual renderer DTO passes sender-bound capture and remains available until matching display ACK',async()=>{
 const term=createRendererVt({cols:80,rows:24,scrollback:10000,allowProposedApi:true});let receipt;
 try{
  await new Promise(r=>term.write('ACTUAL RENDERER\r\n',r));const dto=await captureRendererVt(term),json=JSON.stringify(dto),channel=ipc(),logs=[];
  const window={id:7,isDestroyed:()=>false,send:(_name,req)=>{
   channel.listeners.get('pty-checkpoint:captured')({sender:{id:99}},req.requestId,'wrong sender');
   channel.listeners.get('pty-checkpoint:captured')({sender:{id:7}},req.requestId,json);
  }};
  const displays=new HandoverDisplays(async()=>window,(...args)=>logs.push(args));displays.register(channel);
  const state=base();receipt=await displays.capture(state);state.display=receipt;state.displayRawBytes=Buffer.byteLength(json);
  for await(const part of store.readCheckpoint(displayRoot,receipt))state.displayEncodedBytes+=part.data.length;
  await displays.inspect(state);const get=channel.handlers.get('pty-checkpoint:display'),ack=channel.handlers.get('pty-checkpoint:display-ack');
  const restored=get({},'p');assert.equal(restored.json,json);assert.equal(restored.offset,77);assert.equal(restored.notice,null);
  await ack({},'p','old generation');assert.ok(get({},'p'));await ack({},'p','g');assert.equal(get({},'p'),null);
  await displays.acknowledgeEscrow(receipt);assert.deepEqual(fs.readdirSync(displayRoot),[]);
 }finally{term.dispose();}
});
test('missing renderer state becomes a visible replay notice with a zero replay boundary',async()=>{
 const channel=ipc(),logs=[],displays=new HandoverDisplays(async()=>null,(...args)=>logs.push(args));displays.register(channel);
 await displays.inspect(base());const restored=channel.handlers.get('pty-checkpoint:display')({},'p');assert.equal(restored.json,null);assert.equal(restored.offset,0);assert.match(restored.notice,/History from replay/);assert.equal(logs[0][0],'handover-history-from-replay');
});
test('explicit replacement discards one pane display while preserving every other pane',async()=>{
 const channel=ipc(),displays=new HandoverDisplays(async()=>null,()=>{});displays.register(channel);
 const state=base();state.eligible.push({id:'kept',generation:'g2',outputEnd:90});await displays.inspect(state);
 const get=channel.handlers.get('pty-checkpoint:display');assert.ok(get({},'p'));assert.ok(get({},'kept'));
 displays.forget('p');assert.equal(get({},'p'),null);assert.equal(get({},'kept').generation,'g2');
});
test('aggregate raw headers refuse before any display decompression',async()=>{
 const read=store.readCheckpoint,decode=payload.decodeCheckpointPayload;let inflations=0;
 store.readCheckpoint=async function*(){for(let i=0;i<3;i++){const data=payload.encodeCheckpointPayload(Buffer.from('small'));data.writeUInt32BE(64*1024*1024,8);yield{id:'p'+i,generation:'g',data};}};
 payload.decodeCheckpointPayload=(...args)=>{inflations++;return decode(...args);};
 const state={...base(),eligible:[0,1,2].map(i=>({id:'p'+i,generation:'g',outputEnd:0})),display:{}};
 try{await assert.rejects(new HandoverDisplays(async()=>null,()=>{}).inspect(state),/aggregate-byte limit/);assert.equal(inflations,0);}finally{store.readCheckpoint=read;payload.decodeCheckpointPayload=decode;}
});

test('a live renderer that never replies has a bounded replay fallback',async()=>{
 const channel=ipc(),logs=[];
 const win={id:77,isDestroyed:()=>false,send:()=>{}};
 const displays=new HandoverDisplays(async()=>win,(...args)=>logs.push(args));displays.register(channel);
 const state=base(),start=Date.now();const receipt=await displays.capture(state);
 assert.ok(Date.now()-start<2000);state.display=receipt;state.displayRawBytes=0;state.displayEncodedBytes=0;
 await displays.inspect(state);const result=channel.handlers.get('pty-checkpoint:display')({},'p');
 assert.equal(result.json,null);assert.match(result.notice,/History from replay/);
 await displays.acknowledgeEscrow(receipt);
});

test('display ACK retains state until the host accepts the matching applied replay token',async()=>{
 const channel=ipc(),seen=[];let accepted=false;
 const displays=new HandoverDisplays(async()=>null,()=>{},async(...args)=>{seen.push(args);return accepted;});displays.register(channel);
 await displays.inspect(base());const get=channel.handlers.get('pty-checkpoint:display'),ack=channel.handlers.get('pty-checkpoint:display-ack');
 await ack({},'p','g','discarded-view');assert.ok(get({},'p'));
 accepted=true;await ack({},'p','g','replacement-view');assert.equal(get({},'p'),null);
 assert.deepEqual(seen,[['p','g','discarded-view'],['p','g','replacement-view']]);
});
