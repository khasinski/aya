import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {parseHandoverBootstrap,readCoreHandover}=require('../dist-electron/pty-handover-bootstrap.js');
const store=require('../dist-electron/pty-checkpoint-store.js');
const {encodeCheckpointPayload}=require('../dist-electron/pty-checkpoint-payload.js');
test('bootstrap descriptor is a bounded closed envelope without credentials',()=>{
 for(const value of [null,[],{}, {format:2,core:{}},{format:1,core:{},credential:'secret'}])assert.throws(()=>parseHandoverBootstrap(Buffer.from(JSON.stringify(value))),/Invalid/);
 assert.throws(()=>parseHandoverBootstrap(Buffer.alloc(65537)),/length/);
});
test('core bootstrap checks all declared raw sizes before decoding its first part',async()=>{
 const read=store.readCheckpoint;let visited=0;
 store.readCheckpoint=async function*(){for(let i=0;i<3;i++){visited++;const data=encodeCheckpointPayload(Buffer.from('small'));data.writeUInt32BE(64*1024*1024,8);yield{id:String(i),generation:'g',data};}};
 try{const yielded=[];await assert.rejects(async()=>{for await(const pane of readCoreHandover({}))yielded.push(pane);},/aggregate decoded-byte limit/);assert.equal(visited,3);assert.equal(yielded.length,0);}finally{store.readCheckpoint=read;}
});
for(const mode of ['timeout','oversized'])test(`bootstrap pipe rejects ${mode} without waiting for the writer to close`,{timeout:6000},async()=>{
 const source="require('./dist-electron/pty-handover-bootstrap.js').readHandoverBootstrap(3).then(()=>process.exit(2),e=>{process.stdout.write(e.message);process.exit(0);})";
 const child=spawn(process.execPath,['-e',source],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe','pipe']});
 let output='';child.stdout.on('data',b=>{output+=b;});child.stdio[3].on('error',()=>{});
 try{
  if(mode==='oversized')child.stdio[3].write(Buffer.alloc(65537));
  const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('bootstrap did not refuse promptly')),4500);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
  assert.equal(code,0);assert.match(output,mode==='timeout'?/timed out/:/length limit/);
 }finally{child.stdio[3].destroy();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});
