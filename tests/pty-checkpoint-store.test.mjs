import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {mock} from 'node:test';
const require=createRequire(import.meta.url);
const {writeCheckpoint,readCheckpoint,acknowledgeCheckpoint,discardCheckpoint}=require('../dist-electron/pty-checkpoint-store.js');
const {MAX_CHECKPOINT_PANES}=require('../dist-electron/vt-checkpoint-schema.js');
const hash=data=>createHash('sha256').update(data).digest('hex');
async function fixture(fn){
 await fs.mkdir('test-results',{recursive:true});const parent=await fs.mkdtemp(path.resolve('test-results/checkpoint-'));
 try{await fn(path.join(parent,'escrow'),parent);}finally{await fs.rm(parent,{recursive:true,force:true});}
}
const part=(id='p')=>({id,generation:'generation',data:Buffer.from(JSON.stringify({screen:'retained screen',tail:'\x1b['}))});
const collect=async(root,receipt,now)=>{const result=[];for await(const p of readCheckpoint(root,receipt,now))result.push(p);return result;};
test(`escrow streams ${MAX_CHECKPOINT_PANES} separate panes through private files and unlinks only after ACK`,()=>fixture(async(root)=>{
 let produced=0;
 async function* source(){for(let n=0;n<MAX_CHECKPOINT_PANES;n++){produced++;yield part(`pane-${n}`);}}
 const receipt=await writeCheckpoint(root,source());assert.equal(produced,MAX_CHECKPOINT_PANES);
 const directory=path.join(root,receipt.nonce),names=await fs.readdir(directory);assert.equal(names.length,MAX_CHECKPOINT_PANES+1);
 assert.equal((await fs.stat(root)).mode&0o777,0o700);assert.equal((await fs.stat(directory)).mode&0o777,0o700);
 for(const name of names)assert.equal((await fs.stat(path.join(directory,name))).mode&0o777,0o600);
 const restored=await collect(root,receipt);assert.deepEqual(restored,Array.from({length:MAX_CHECKPOINT_PANES},(_,n)=>part(`pane-${n}`)));
 assert.equal((await fs.readdir(directory)).length,MAX_CHECKPOINT_PANES+1);
 await acknowledgeCheckpoint(root,receipt);await assert.rejects(fs.stat(directory),{code:'ENOENT'});
 await assert.rejects(collect(root,receipt),{code:'ENOENT'});
}));
test(`escrow refuses pane ${MAX_CHECKPOINT_PANES+1} and cleans its partial transaction`,()=>fixture(async(root)=>{
 async function* source(){for(let n=0;n<=MAX_CHECKPOINT_PANES;n++)yield part(`pane-${n}`);}
 await assert.rejects(writeCheckpoint(root,source()),/pane part/);
 assert.deepEqual(await fs.readdir(root),[]);
}));
for(const [name,corrupt] of [
 ['truncated pane',async(dir)=>fs.truncate(path.join(dir,'0.json'),1)],
 ['changed pane',async(dir)=>fs.writeFile(path.join(dir,'0.json'),Buffer.alloc(part().data.length,120))],
 ['readable pane',async(dir)=>fs.chmod(path.join(dir,'0.json'),0o644)],
 ['readable directory',async(dir)=>fs.chmod(dir,0o755)],
 ['manifest checksum',async(dir)=>fs.writeFile(path.join(dir,'manifest.json'),'{}')],
 ['symlink pane',async(dir)=>{await fs.rename(path.join(dir,'0.json'),path.join(dir,'saved'));await fs.symlink('saved',path.join(dir,'0.json'));}],
 ['hardlink pane',async(dir)=>fs.link(path.join(dir,'0.json'),path.join(dir,'extra'))],
])test(`escrow refuses ${name} without acknowledging state`,()=>fixture(async(root)=>{
 const receipt=await writeCheckpoint(root,[part()]),dir=path.join(root,receipt.nonce);await corrupt(dir);
 await assert.rejects(collect(root,receipt));assert.ok(await fs.lstat(path.join(dir,'manifest.json')));
}));
test('expired escrow refuses; nonce traversal and bad receipts never address a file',()=>fixture(async(root)=>{
 const receipt=await writeCheckpoint(root,[part()],1000);
 await assert.rejects(collect(root,receipt,121001),/expiry/);
 for(const bad of [{...receipt,nonce:'../other'},{...receipt,bytes:1e12},{...receipt,sha256:'bad'},{...receipt,extra:true}])await assert.rejects(collect(root,bad,1001),/receipt/);
 await assert.rejects(collect(root,receipt,999),/expiry/);
 assert.equal((await collect(root,receipt,1001)).length,1);
}));
test('writer removes partial escrow on duplicate ID, oversized pane, excess panes and producer error',()=>fixture(async(root)=>{
 for(const source of [[part(),part()],Array.from({length:MAX_CHECKPOINT_PANES+1},(_,n)=>part(String(n))),[{...part(),data:Buffer.alloc(0)}]]){
  await assert.rejects(writeCheckpoint(root,source));assert.deepEqual(await fs.readdir(root),[]);
 }
 async function* broken(){yield part();throw Error('producer failed');}
 await assert.rejects(writeCheckpoint(root,broken()),/producer failed/);assert.deepEqual(await fs.readdir(root),[]);
}));
test('reader validates aggregate lengths and closed manifest before allocating pane storage',()=>fixture(async(root)=>{
 const receipt=await writeCheckpoint(root,[part()],1000),file=path.join(root,receipt.nonce,'manifest.json');
 const original=JSON.parse(await fs.readFile(file,'utf8'));
 for(const mutate of [
  m=>{m.parts=Array.from({length:3},(_,n)=>({...m.parts[0],id:String(n),bytes:64*1024*1024}));},
  m=>{m.parts[0].bytes=64*1024*1024+1;},m=>{m.parts[0].filename='../../elsewhere';},
  m=>{m.parts.push({...m.parts[0]});},m=>{m.nonce='a'.repeat(64);},m=>{m.extra=true;},
 ]){const manifest=structuredClone(original);mutate(manifest);const data=Buffer.from(JSON.stringify(manifest));await fs.writeFile(file,data);
  await assert.rejects(collect(root,{...receipt,bytes:data.length,sha256:hash(data)},1001),/Checkpoint escrow refused/);
 }
}));
test('unsafe existing root is refused instead of silently changing permissions',()=>fixture(async(root,parent)=>{
 await fs.mkdir(root,{mode:0o755});await fs.chmod(root,0o755);
 await assert.rejects(writeCheckpoint(root,[part()]),/directory permissions/);
 await fs.rmdir(root);await fs.mkdir(path.join(parent,'actual'),{mode:0o700});await fs.symlink('actual',root);
 await assert.rejects(writeCheckpoint(root,[part()]),/directory permissions/);
}));
for(const name of ['0.json','manifest.json'])test(`FIFO ${name} is refused promptly without consuming escrow`,()=>fixture(async(root)=>{
 const receipt=await writeCheckpoint(root,[part()]),dir=path.join(root,receipt.nonce),file=path.join(dir,name);
 await fs.unlink(file);execFileSync('/usr/bin/mkfifo',[file]);
 // Run in a disposable process: a regressed blocking open must not strand a
 // libuv worker and keep the entire test runner alive after a JS timeout.
 const script=`const {readCheckpoint}=require('./dist-electron/pty-checkpoint-store.js');(async()=>{try{for await(const p of readCheckpoint(process.argv[1],JSON.parse(process.argv[2]))){}process.exitCode=2;}catch(e){if(!/file type/.test(e.message)){console.error(e.message);process.exitCode=3;}}})();`;
 execFileSync(process.execPath,['-e',script,root,JSON.stringify(receipt)],{timeout:2000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
 assert.ok(await fs.lstat(file));assert.ok(await fs.lstat(path.join(dir,'manifest.json')));
}));
test('aggregate manifest limit refuses before opening or yielding any pane',()=>fixture(async(root)=>{
 const receipt=await writeCheckpoint(root,[part()],1000),dir=path.join(root,receipt.nonce),file=path.join(dir,'manifest.json');
 const manifest=JSON.parse(await fs.readFile(file,'utf8'));
 manifest.parts=Array.from({length:3},(_,n)=>({...manifest.parts[0],id:String(n),bytes:64*1024*1024}));
 const data=Buffer.from(JSON.stringify(manifest));await fs.writeFile(file,data);await fs.unlink(path.join(dir,'0.json'));
 // Without the aggregate guard this fails with ENOENT at the first part,
 // which must not satisfy this exact aggregate-refusal assertion.
 let yielded=0;
 await assert.rejects(async()=>{for await(const p of readCheckpoint(root,{...receipt,bytes:data.length,sha256:hash(data)},1001)){void p;yielded++;}},/aggregate bytes/);
 assert.equal(yielded,0);
}));
test('writer admits exactly 128 MiB and rejects a third 64 MiB part before writing it',()=>fixture(async(root)=>{
 const promises=require('node:fs/promises'),original=promises.open;let logicalWritten=0,partsOpened=0;
 // A tiny Buffer with an advertised logical length and a fake part-file sink
 // exercise the production aggregate accounting without 192 MiB of disk I/O.
 // Hashing still reads the actual one-byte backing store; no reader uses it.
 const logical=Buffer.alloc(1);Object.defineProperty(logical,'length',{value:64*1024*1024});
 const spy=mock.method(promises,'open',async(file,...args)=>{
  if(/\/\d+\.json$/.test(file)){partsOpened++;return {write:async(_data,_offset,length)=>{logicalWritten+=length;return {bytesWritten:length};},sync:async()=>{},close:async()=>{}};}
  return original(file,...args);
 });
 try{
  const parts=Array.from({length:3},(_,n)=>({id:String(n),generation:'g',data:logical}));
  await writeCheckpoint(root,parts.slice(0,2));assert.equal(logicalWritten,128*1024*1024);assert.equal(partsOpened,2);
  logicalWritten=0;partsOpened=0;
  await assert.rejects(writeCheckpoint(root,parts),/aggregate bytes/);
  assert.equal(logicalWritten,128*1024*1024);assert.equal(partsOpened,2);
 }finally{spy.mock.restore();}
}));
test('explicit abort cleans an expired checked receipt but preserves unknown or tampered state',()=>fixture(async(root)=>{
 const receipt=await writeCheckpoint(root,[part()],1000),dir=path.join(root,receipt.nonce);
 await assert.rejects(acknowledgeCheckpoint(root,receipt,121001),/expiry/);
 await discardCheckpoint(root,receipt,121001);await assert.rejects(fs.stat(dir),{code:'ENOENT'});
 const bad=await writeCheckpoint(root,[part()],1000),badDir=path.join(root,bad.nonce);
 await fs.writeFile(path.join(badDir,'0.json'),'tampered');
 await assert.rejects(discardCheckpoint(root,bad,121001));assert.ok(await fs.stat(path.join(badDir,'manifest.json')));
}));
