import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {VtCheckpointTerminal}=require('../dist-electron/vt-checkpoint.js');
const {capture}=require('../dist-electron/vt-checkpoint-binding.js');
const mirror=require('../dist-electron/vt-mirror.js');
const {snapshotHold,snapshotBusy}=require('../dist-electron/vt-state.js');
const write=(t,s)=>new Promise(resolve=>t.write(s,resolve));
for(const file of fs.readdirSync('tests/fixtures/own-screens').filter(f=>f.endsWith('.raw'))){
 test(`production codec preserves recorded ${file} and split continuation`,async()=>{
  const meta=JSON.parse(fs.readFileSync(`tests/fixtures/own-screens/${file.replace('.raw','.meta.json')}`));
  const p=new VtCheckpointTerminal({cols:meta.cols,rows:meta.rows,scrollback:64,allowProposedApi:true});let q;
  try{await write(p,fs.readFileSync(`tests/fixtures/own-screens/${file}`));await write(p,'\x18\x1b[38;2;');
   q=await VtCheckpointTerminal.import(await p.checkpoint({generation:'g',osc9001Carry:'\x1b]9001;'}));
   for(const s of ['12;34;56mX','\x1b[?1049hALT\x1b[?1049l','\x1b[6n']){await write(p,s);await write(q,s);}
   assert.deepEqual(JSON.parse(capture(q.terminal)),JSON.parse(capture(p.terminal)));
  }finally{p.dispose();q?.dispose();}
 });
}
test('actual parse order preserves immediate resize before queued writes',async()=>{
 const a=new VtCheckpointTerminal({cols:100,rows:30,scrollback:64,allowProposedApi:true});let b;
 try{
  await write(a,'\x1b[');
  a.write('2J'+('long line '.repeat(20)+'\r\n').repeat(60));
  a.resize(40,20);
  a.write('\x1b[38;2;');
  b=await VtCheckpointTerminal.import(await a.checkpoint({}));
  await write(a,'1;2;3mX');await write(b,'1;2;3mX');
  assert.deepEqual(JSON.parse(capture(b.terminal)),JSON.parse(capture(a.terminal)));
 }finally{a.dispose();b?.dispose();}
});
test('real mirror restores generation, composer acknowledgement, timestamps and account dialog',async()=>{
 const id='checkpoint-opaque';mirror.openVtPane(id,80,24,()=>{},'claude');
 try{
  mirror.writeVtPane(id,'Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No');
  const before=await mirror.vtSnapshot(id);mirror.markComposerSeen(id,before.generation);
  const p=mirror.panes.get(id);p.lastWaiting=true;p.lastDialog='Claude account offer';
  const cp=await mirror.checkpointVtPane(id);const state=await mirror.vtSnapshot(id);
  mirror.closeVtPane(id);await mirror.restoreVtPane(id,cp,()=>{});
  assert.deepEqual(await mirror.vtSnapshot(id),state);
  assert.equal(mirror.vtPaneWaiting(id),true);assert.equal(mirror.vtPaneDialog(id),'Claude account offer');
  assert.equal(snapshotHold(state).hold,snapshotHold(await mirror.vtSnapshot(id)).hold);
  assert.equal(snapshotBusy(state),snapshotBusy(await mirror.vtSnapshot(id)));
  mirror.markComposerSeen(id,'old-other-generation');assert.equal((await mirror.vtSnapshot(id)).composerSeen,true);
 }finally{mirror.closeVtPane(id);}
});
test('unsupported retained handler operation refuses until supported ground compaction',async()=>{
 const a=new VtCheckpointTerminal({cols:80,rows:24,scrollback:0,allowProposedApi:true});let b;
 try{
  await write(a,'\x1b[');const h=a.terminal.parser.registerCsiHandler({final:'m'},()=>true);
  await write(a,'31mX\x1b[');h.dispose();await assert.rejects(a.checkpoint({}),/unsupported ownership/);
  await write(a,'0m');b=await VtCheckpointTerminal.import(await a.checkpoint({}));
  assert.equal(b.terminal.buffer.normal.getLine(0).getCell(0).getFgColor(),-1);
 }finally{a.dispose();b?.dispose();}
});
test('mirror refuses malformed opaque metadata before installing a pane',async()=>{
 const a=new VtCheckpointTerminal({cols:80,rows:24,scrollback:0,allowProposedApi:true});
 try{const cp=await a.checkpoint({generation:'g',shell:false,lastWaiting:false,composerSeen:false,openedAt:0,lastOutputAt:null});
  for(const metadata of [{...cp.metadata,generation:''},{...cp.metadata,lastOutputAt:NaN},{...cp.metadata,extra:true},{...cp.metadata,agent:'unknown'}]){
   await assert.rejects(mirror.restoreVtPane('bad',{...cp,metadata},()=>{}),/Invalid VT pane metadata/);assert.equal(mirror.panes.has('bad'),false);
  }
 }finally{a.dispose();}
});
for(const [name,prefix,suffix] of [
 ['CSI','\x1b[38;2;','12;34;56mC'],['OSC','\x1b]2;partial',' title\x07'],['DCS','\x1bP$q','m\x1b\\'],
 ['UTF16','\ud83d','\ude00'],['UTF8',Buffer.from([0xf0,0x9f]),Buffer.from([0x98,0x80])],
])test(`production schema/binding accepts full modes, palette, hyperlinks and split ${name}`,async()=>{
 const a=new VtCheckpointTerminal({cols:100,rows:30,scrollback:64,allowProposedApi:true});let b;
 try{
  await write(a,'normal\r\n'.repeat(90)+'\x1b[3;20r\x1b[?6h\x1b[?7l\x1b[4h\x1b[?2004h\x1b[?1004h\x1b[?1002h\x1b[?1006h\x1b[5 q\x1b(0abc\x1b(B\x1bH\x1b7\x1b[38;2;1;2;3m\x1b[48;2;9;8;7m\x1b[4:3m\x1b]8;id=demo;https://fixture.invalid/path\x1b\\link界é\x1b]8;;\x1b\\\x1b]2;original title\x07\x1b]4;1;#123456\x07\x1b[?1049hALT\x1b7\x1b)0\x0e\x1b[?1h\x1b=\x1b[?45h\x1b[?25l');
  await write(a,prefix);b=await VtCheckpointTerminal.import(await a.checkpoint({generation:'g',osc9001Carry:'\x1b]9001;'}));
  for(const s of [suffix,'\x1b8\tQqxj\x1b[6n','\x1b[?1049l\x1b8\r\nAFTER\x1b[6n','\x1b[?1049h']){await write(a,s);await write(b,s);}
  assert.deepEqual(JSON.parse(capture(b.terminal)),JSON.parse(capture(a.terminal)));
 }finally{a.dispose();b?.dispose();}
});
test('a custom asynchronous handler cannot leave checkpoint drain waiting forever',async()=>{
 const a=new VtCheckpointTerminal({cols:80,rows:24,scrollback:0,allowProposedApi:true});let complete;
 const blocked=new Promise(resolve=>{complete=resolve;});
 try{
  const h=a.terminal.parser.registerCsiHandler({final:'m'},()=>blocked);a.write('\x1b[31m');
  await assert.rejects(a.drain(20),/timed out/);complete(true);h.dispose();
  await a.drain();
 }finally{complete(true);a.dispose();}
});
test('tail cap includes JSON array and comma framing for many tiny operations',async()=>{
 const a=new VtCheckpointTerminal({cols:80,rows:24,scrollback:0,allowProposedApi:true});
 try{
  await write(a,'\x1b[');
  let before=0;
  for(let n=0;n<16000;n++){
   a.resize(80+n%2,24);
   if(a.overflow){assert.ok(before<=256*1024);assert.deepEqual(a.tail,[]);break;}
   before=a.tailBytes;
  }
  assert.equal(a.overflow,true);await assert.rejects(a.checkpoint({}),/temporarily ineligible/);
  await write(a,'0m');assert.deepEqual((await a.checkpoint({})).tail,[]);
 }finally{a.dispose();}
});
