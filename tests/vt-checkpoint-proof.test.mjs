// B3's initial VT representation proof. No process/owner handoff is exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import checkpoint from '../scripts/spikes/vt-checkpoint.cjs';
const {CompactVt,capture,write,ground,bufferState,MAX_TAIL}=checkpoint;
const root=path.resolve('tests/fixtures/own-screens');
const screen=term=>({normal:bufferState(term._core._bufferService.buffers.normal),alternate:bufferState(term._core._bufferService.buffers.alt),active:term.buffer.active.type});
function recording(name){
 const raw=fs.readFileSync(path.join(root,name+'.raw')),meta=JSON.parse(fs.readFileSync(path.join(root,name+'.meta.json'))),file=path.join(root,name+'.chunks.jsonl');
 const decoder=new StringDecoder('utf8'),chunks=[];let at=0;
 if(fs.existsSync(file))for(const line of fs.readFileSync(file,'utf8').split('\n').filter(Boolean)){const c=JSON.parse(line);if(c.len!==undefined){chunks.push(decoder.write(raw.subarray(at,at+c.len)));at+=c.len;}}
 if(at<raw.length)chunks.push(decoder.write(raw.subarray(at)));const end=decoder.end();if(end)chunks.push(end);
 return {meta,chunks};
}
for(const file of fs.readdirSync(root).filter(name=>name.endsWith('.raw'))){
 const name=file.slice(0,-4);
 test(`compact VT checkpoint round-trips recorded ${name} and future parser responses`,async()=>{
  const {meta,chunks}=recording(name),opaque={generation:'generation-A',composerSeen:true,osc9001Carry:'\x1b]9001;partial',openedAt:1,lastOutputAt:2};
  const original=new CompactVt({cols:meta.cols,rows:meta.rows,scrollback:0},opaque);let restored;
  try{
   const split=Math.max(1,Math.floor(chunks.length/2));
   for(const chunk of chunks.slice(0,split))await original.write(chunk);
   restored=await CompactVt.import(original.checkpoint());assert.deepEqual(screen(restored.term),screen(original.term));assert.deepEqual(restored.metadata,opaque);
   for(const chunk of chunks.slice(split)){await original.write(chunk);await write(restored.term,chunk);}
   const replies=[[],[]];original.term.onData(s=>replies[0].push(s));restored.term.onData(s=>replies[1].push(s));
   for(const suffix of ['\x18','\x1b[6n\x1b[?25$p','\x1b7\x1b[38;2;12;34;56m\x1b[4:3mZé界\x1b8','\x1b[?1049hALT\x1b[?1049l']){await original.write(suffix);await write(restored.term,suffix);}
   assert.equal(ground(original.term),true);assert.equal(ground(restored.term),true);
   assert.deepEqual(JSON.parse(capture(restored.term)),JSON.parse(capture(original.term)));assert.deepEqual(replies[1],replies[0]);
  }finally{original.term.dispose();restored?.term.dispose();}
 });
}
const setup='normal\r\n'.repeat(90)+'\x1b[3;20r\x1b[?6h\x1b[?7l\x1b[4h\x1b[?2004h\x1b[?1004h\x1b[?1002h\x1b[?1006h\x1b[5 q\x1b(0abc\x1b(B\x1bH\x1b7\x1b[38;2;1;2;3m\x1b[48;2;9;8;7m\x1b[4:3m\x1b]8;id=demo;https://fixture.invalid/path\x1b\\link界é\x1b]8;;\x1b\\\x1b]2;original title\x07\x1b[?1049hALT\x1b7\x1b)0\x0e\x1b[?1h\x1b=\x1b[?45h\x1b[?25l';
for(const [name,prefix,suffix] of [
 ['CSI','\x1b[38;2;','12;34;56mC'],['OSC title','\x1b]2;partial',' title\x07'],['DCS query','\x1bP$q','m\x1b\\'],
 ['string surrogate','\ud83d','\ude00'],['UTF8',Buffer.from([0xf0,0x9f]),Buffer.from([0x98,0x80])],
])test(`both buffers/history/modes and a split ${name} preserve future behavior`,async()=>{
 const a=new CompactVt({cols:100,rows:30,scrollback:64},{generation:'g',composerSeen:false});let b;
 try{
  await a.write(setup);await a.write(prefix);a.metadata.composerSeen=true;
  b=await CompactVt.import(a.checkpoint());assert.deepEqual(screen(b.term),screen(a.term));assert.equal(b.metadata.composerSeen,true);
  const replies=[[],[]];a.term.onData(s=>replies[0].push(s));b.term.onData(s=>replies[1].push(s));
  await a.write(suffix);await write(b.term,suffix);
  for(const next of ['\x1b8\tQqxj\x1b[6n','\x1b[?1049l\x1b8\r\nAFTER\x1b[6n','\x1b[?1049h\x1b[6n']){await a.write(next);await write(b.term,next);}
  assert.deepEqual(JSON.parse(capture(b.term)),JSON.parse(capture(a.term)));assert.deepEqual(replies[1],replies[0]);
 }finally{a.term.dispose();b?.term.dispose();}
});
test('tail overflow is temporary and eligibility returns at the next parser ground state',async()=>{
 const a=new CompactVt({cols:80,rows:24,scrollback:0});
 try{await a.write('\x1b]2;'+'x'.repeat(MAX_TAIL+1));assert.throws(()=>a.checkpoint(),/temporarily ineligible/);await a.write('\x07');const b=await CompactVt.import(a.checkpoint());assert.deepEqual(JSON.parse(capture(b.term)),JSON.parse(capture(a.term)));assert.equal(a.tailBytes,0);b.term.dispose();}finally{a.term.dispose();}
});
test('resize during a split sequence is replayed in the tail, not moved across it',async()=>{
 const a=new CompactVt({cols:100,rows:30,scrollback:64});let b;
 try{await a.write('wrap '.repeat(700));await a.write('\x1b[');a.resize(40,20);b=await CompactVt.import(a.checkpoint());await a.write('2Jafter');await write(b.term,'2Jafter');assert.deepEqual(JSON.parse(capture(b.term)),JSON.parse(capture(a.term)));}finally{a.term.dispose();b?.term.dispose();}
});
test('indexed/special palette overrides and resets survive import and further colour changes',async()=>{
 const a=new CompactVt({cols:80,rows:24,scrollback:0});let b;
 try{
  await a.write('\x1b]4;1;#123456;2;#234567\x07\x1b]10;#abcdef\x07\x1b]11;#102030\x07\x1b]104;2\x07');
  b=await CompactVt.import(a.checkpoint());assert.deepEqual(JSON.parse(capture(b.term)),JSON.parse(capture(a.term)));
  assert.deepEqual(JSON.parse(capture(b.term)).palette,{'1':[18,52,86],'256':[171,205,239],'257':[16,32,48]});
  for(const next of ['\x1b]104\x07','\x1b]12;#fedcba\x07']){await a.write(next);await write(b.term,next);}
  assert.deepEqual(JSON.parse(capture(b.term)),JSON.parse(capture(a.term)));
 }finally{a.term.dispose();b?.term.dispose();}
});
test('repeated redraws grow consumed input while compact state and parser tail stay bounded',async()=>{
 const a=new CompactVt({cols:120,rows:40,scrollback:0});
 try{
  const frame='\x1b[2J\x1b[H'+('dense agent output '.repeat(6)+'\r\n').repeat(39);
  const sizes=[];
  for(let n=0;n<500;n++){await a.write(frame+'\x1b[');assert.ok(a.tailBytes<8192);await a.write('0m');sizes.push(a.base.length);}
  assert.equal(a.tailBytes,0);assert.ok(a.totalInputBytes>2*1024*1024);assert.ok(Math.max(...sizes)-Math.min(...sizes)<256);
 }finally{a.term.dispose();}
});
test('a new unsupported external marker refuses this snapshot and disposing it restores eligibility',async()=>{
 const a=new CompactVt({cols:80,rows:24,scrollback:0});
 try{await a.write('screen');const marker=a.term.registerMarker(0);assert.throws(()=>a.checkpoint(),/External markers/);marker.dispose();const b=await CompactVt.import(a.checkpoint());assert.deepEqual(JSON.parse(capture(b.term)),JSON.parse(capture(a.term)));b.term.dispose();}finally{a.term.dispose();}
});
test('an extra parser handler refuses export until it is disposed',async()=>{
 const a=new CompactVt({cols:80,rows:24,scrollback:0});
 try{const registration=a.term.parser.registerCsiHandler({final:'m'},()=>false);assert.throws(()=>a.checkpoint(),/Custom parser/);registration.dispose();const b=await CompactVt.import(a.checkpoint());assert.deepEqual(JSON.parse(capture(b.term)),JSON.parse(capture(a.term)));b.term.dispose();}finally{a.term.dispose();}
});
test('public cells and input modes independently verify true colour, wide/combined glyphs and saved state',async()=>{
 const a=new CompactVt({cols:100,rows:30,scrollback:64});let b;
 try{
  await a.write('\x1b[38;2;12;34;56m\x1b[48;2;65;43;21m\x1b[1;2;3;4:3;5;7;8;9mN界é\x1b7\x1b[?1049hALT\x1b[?6h\x1b[?7l\x1b[4h\x1b[?2004h\x1b[?1004h\x1b[?1h\x1b=\x1b[?1002h\x1b[?1006h\x1b[?45h\x1b[?25l\x1b[5 q\x1b)0\x0e');
  b=await CompactVt.import(a.checkpoint());
  const first=b.term.buffer.normal.getLine(0).getCell(0);
  assert.equal(first.getChars(),'N');assert.equal(first.getFgColor(),0x0c2238);assert.equal(first.getBgColor(),0x412b15);assert.ok(first.isBold());assert.ok(first.isDim());assert.ok(first.isInverse());assert.ok(first.isItalic());
  assert.equal(b.term.buffer.normal.getLine(0).getCell(1).getWidth(),2);assert.equal(b.term.buffer.normal.getLine(0).getCell(3).getChars(),'é');
  assert.equal(b.term.buffer.active.type,'alternate');assert.equal(b.term.modes.insertMode,true);assert.equal(b.term.modes.originMode,true);assert.equal(b.term.modes.wraparoundMode,false);assert.equal(b.term.modes.bracketedPasteMode,true);assert.equal(b.term.modes.sendFocusMode,true);assert.equal(b.term.modes.applicationCursorKeysMode,true);assert.equal(b.term.modes.applicationKeypadMode,true);assert.equal(b.term.modes.mouseTrackingMode,'drag');assert.equal(b.term.modes.reverseWraparoundMode,true);
  assert.equal(b.term._core.coreService.isCursorHidden,true);assert.equal(b.term._core.coreService.decPrivateModes.cursorStyle,'bar');
  await write(b.term,'q');assert.ok(b.term.buffer.active.getLine(b.term.buffer.active.cursorY).translateToString().includes('─'));
 }finally{a.term.dispose();b?.term.dispose();}
});
