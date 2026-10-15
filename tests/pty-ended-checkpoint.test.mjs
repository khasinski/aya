import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
fs.mkdirSync('test-results',{recursive:true});const home=fs.mkdtempSync(path.resolve('test-results/ended-checkpoint-'));process.env.AYA_HOME=home;
const require=createRequire(import.meta.url),schema=require('../dist-electron/pty-core-checkpoint'),core=require('../dist-electron/pty-core'),bootstrap=require('../dist-electron/pty-handover-bootstrap');
const store=require('../dist-electron/pty-checkpoint-store'),{encodeCheckpointPayload}=require('../dist-electron/pty-checkpoint-payload');
const {PTY_HANDOVER_CORE_DIRECTORY}=require('../dist-electron/pty-host-paths');
const {OwnerPty}=require('../dist-electron/pty-owner-adapter'),{shutdownOwnerRuntime}=require('../dist-electron/pty-owner-runtime');
const {openVtPane,checkpointVtPane,closeVtPane}=require('../dist-electron/vt-mirror');
const {ownerProcessStartIdentity}=require('../dist-electron/pty-owner-client');
const ended=()=>({format:1,kind:'ended',id:'ended',generation:'retained-generation',exitCode:23,output:{chunks:['HISTORYLAST_SUFFIX'],total:18,version:1,end:18}});
test.after(async()=>{await shutdownOwnerRuntime();fs.rmSync(home,{recursive:true,force:true});});
test('ended schema is closed, bounded and cannot smuggle cells or an adapter past validation',async(t)=>{
 const {VtCheckpointTerminal}=require('../dist-electron/vt-checkpoint');let imports=0,attaches=0;
 t.mock.method(VtCheckpointTerminal,'import',async()=>{imports++;throw Error('unexpected VT allocation');});
 t.mock.method(OwnerPty,'attach',async()=>{attaches++;throw Error('unexpected native attach');});
 assert.deepEqual(await schema.validateCoreHandoverPart(ended()),ended());
 for(const mutate of [p=>{p.kind='live';},p=>{p.format=2;},p=>{p.id='';},p=>{p.generation='';},p=>{p.exitCode=256;},p=>{p.output.total++;},p=>{p.output.end=-1;},p=>{p.output.total=1000001;},p=>{p.adapter={};},p=>{p.vt={cells:3000001};}]){
  const dto=ended();mutate(dto);await assert.rejects(core.restorePtyCorePane(dto,{isDestroyed:()=>false,sendPtyEvent:()=>{}}),/Invalid PTY core checkpoint/);
 }
 assert.equal(imports,0);assert.equal(attaches,0);
});
test('ended replay restores without a master and retires only after its applied token ACK',async(t)=>{
 let attaches=0;t.mock.method(OwnerPty,'attach',async()=>{attaches++;throw Error('unexpected native attach');});
 const events=[],sink={isDestroyed:()=>false,sendPtyEvent:e=>events.push(e)},dto=ended();
 await core.restorePtyCorePane(dto,sink);assert.equal(core.getPtyPid(dto.id),null);assert.equal(core.getBufferedOutput(dto.id),'HISTORYLAST_SUFFIX');
 const req={ptyId:dto.id,command:'never spawn',cwd:home,cols:80,rows:24,attachOnly:true,replayAfter:{generation:dto.generation,offset:7,token:'current'}};
 await core.spawnPty(req,sink,{prepare:()=>{throw Error('must never spawn');}});
 assert.equal(events.find(e=>e.type==='data').chunk,'LAST_SUFFIX');assert.deepEqual(events.filter(e=>e.type==='exit').map(e=>e.exitCode),[23]);
 assert.equal(core.acknowledgePtyRestoration(dto.id,dto.generation,'stale'),false);
 // A valid live record with this same id still must not attach over the exit.
 openVtPane(dto.id,80,24,()=>{},'custom',true);const vt=await checkpointVtPane(dto.id);closeVtPane(dto.id);
 const live={format:1,id:dto.id,adapter:{pane:{id:dto.id,generation:1,pid:process.pid,cols:80,rows:24,exited:false,exitCode:null,signal:0,event:0,acknowledged:false,startIdentity:ownerProcessStartIdentity(process.pid)},process:'fixture',readBytes:0,decoderCarry:''},request:{ptyId:dto.id,command:'fixture',cwd:home,cols:80,rows:24,agent:'custom'},launch:{command:'fixture',cwd:home},spawnedAt:0,output:{chunks:[],total:0,version:0,end:0},oscCarry:'',vt};
 await assert.rejects(core.restorePtyCorePane(live,sink),/restore target is not empty/);assert.equal(attaches,0);
 assert.equal(core.acknowledgePtyRestoration(dto.id,dto.generation,'current'),true);
});
test('duplicate live and ended ids in escrow reject before any part is yielded',async()=>{
 const receipt=await store.writeCheckpoint(PTY_HANDOVER_CORE_DIRECTORY,[{id:'live',generation:'g',data:encodeCheckpointPayload(Buffer.from(JSON.stringify({format:1,id:'live'})))},{id:'ended',generation:'retained-generation',data:encodeCheckpointPayload(Buffer.from(JSON.stringify(ended())))}]);
 const file=path.join(PTY_HANDOVER_CORE_DIRECTORY,receipt.nonce,'manifest.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));
 manifest.parts[1].id='live';const bytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(file,bytes);receipt.bytes=bytes.length;receipt.sha256=createHash('sha256').update(bytes).digest('hex');
 let yields=0;await assert.rejects(async()=>{for await(const part of bootstrap.readCoreHandover(receipt)){void part;yields++;}},/manifest part/);assert.equal(yields,0);
});
test('ended records share the25-record and aggregate raw budgets before yielding or allocating VT',async()=>{
 const atLimit=await store.writeCheckpoint(path.join(home,'at-limit'),Array.from({length:25},(_,i)=>({id:String(i),generation:'g',data:encodeCheckpointPayload(Buffer.from(JSON.stringify({...ended(),id:String(i)})))})));let count=0;for await(const part of store.readCheckpoint(path.join(home,'at-limit'),atLimit)){void part;count++;}assert.equal(count,25);await store.acknowledgeCheckpoint(path.join(home,'at-limit'),atLimit);
 await assert.rejects(store.writeCheckpoint(path.join(home,'too-many'),Array.from({length:26},(_,i)=>({id:String(i),generation:'g',data:encodeCheckpointPayload(Buffer.from(JSON.stringify({...ended(),id:String(i)})))}))),/pane part/);
 const read=store.readCheckpoint;let yields=0;
 store.readCheckpoint=async function*(){for(let i=0;i<3;i++){const data=encodeCheckpointPayload(Buffer.from(JSON.stringify({...ended(),id:String(i)})));data.writeUInt32BE(64*1024*1024,8);yield{id:String(i),generation:'retained-generation',data};}};
 try{await assert.rejects(async()=>{for await(const part of bootstrap.readCoreHandover({})){void part;yields++;}},/aggregate decoded-byte limit/);assert.equal(yields,0);}finally{store.readCheckpoint=read;}
});
