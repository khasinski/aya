import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {Terminal}=require('@xterm/xterm');
const {createRendererVt,prepareRendererVt,captureRendererVt,restoreRendererVt,SUPPORTED_BROWSER_ENGINE}=require('../dist-test/terminal-vt-checkpoint.js');
const {parseRendererCheckpoint}=require('../dist-electron/renderer-vt-checkpoint.js');
const {stripScrollbackErase,normalizeTerminalLinkUnderline}=require('../dist-test/terminal-rendering.js');
const {extractAyaOsc}=require('../dist-electron/osc-extractor.js');
const write=(term,s)=>new Promise(resolve=>term.write(s,resolve));
const terminal=()=>createRendererVt({cols:80,rows:24,scrollback:10000,cursorBlink:true,scrollOnEraseInDisplay:true,allowProposedApi:true,linkHandler:{activate(){}}});
const visible=term=>Array.from({length:term.rows},(_,y)=>term.buffer.active.getLine(term.buffer.active.viewportY+y)?.translateToString());
test('browser private binding is pinned to the installed xterm implementation',()=>{
 assert.equal(createHash('sha256').update(fs.readFileSync(require.resolve('@xterm/xterm'))).digest('hex'),SUPPORTED_BROWSER_ENGINE);
});
test('pre-existing terminals cannot establish a trusted provider baseline after public mutation',async()=>{
 const a=new Terminal({allowProposedApi:true});
 try {
  a.unicode.register({version:'6',wcwidth:()=>2,charProperties:()=>4});a.unicode.activeVersion='6';
  assert.throws(()=>prepareRendererVt(a),/owned construction/);
  await assert.rejects(captureRendererVt(a),/tracked from construction/);
 }finally{a.dispose();}
 const owned=terminal();
 try {
  owned.unicode.register({version:'6',wcwidth:()=>2,charProperties:()=>4});owned.unicode.activeVersion='6';
  await assert.rejects(captureRendererVt(owned),/replacement/);
 }finally{owned.dispose();}
});
test('restored mouse tracking notifies browser listener consumers',async()=>{
 const a=terminal(),b=terminal(),events=[];
 try {
  await write(a,'\x1b[?1003h\x1b[?1006h');
  a._core.coreMouseService.triggerMouseEvent({col:2,row:3,x:20,y:30,button:3,action:32,ctrl:false,alt:false,shift:false});
  b._core.coreMouseService.onProtocolChange(e=>events.push(e));
  restoreRendererVt(b,parseRendererCheckpoint(Buffer.from(JSON.stringify(await captureRendererVt(a)))));
  assert.equal(b.modes.mouseTrackingMode,'any');assert.ok(events.length>0);assert.ok(events.at(-1)>0);
  assert.deepEqual(b._core.coreMouseService._lastEvent,a._core.coreMouseService._lastEvent);
 }finally{a.dispose();b.dispose();}
});
test('actual transformed renderer history, viewport, both buffers, colours and future behavior round-trip',async()=>{
 const a=terminal(),b=terminal();
 try{
  for(let n=0;n<300;n++)await write(a,normalizeTerminalLinkUnderline(stripScrollbackErase(`\x1b[38;2;12;34;56mhistory ${n} 界é\r\n`)));
  await write(a,normalizeTerminalLinkUnderline(stripScrollbackErase('\x1b[3J\x1b[4:3mhttps://fixture.invalid\x1b[0m')));
  assert.ok(a.buffer.normal.length>300,'renderer transform preserves existing scrollback');
  await write(a,'\x1b7\x1b]8;id=link;https://fixture.invalid\x1b\\linked\x1b]8;;\x1b\\\x1b]4;1;#123456\x07\x1b[?1049hALT\x1b[?2004h\x1b[?1004h\x1b[?1049l');
  a.scrollToLine(a.buffer.normal.baseY-30);
  const captured=await captureRendererVt(a),validated=parseRendererCheckpoint(Buffer.from(JSON.stringify(captured)));
  assert.equal(captured.cutLines,0);assert.equal(captured.viewportClamped,false);
  restoreRendererVt(b,validated);assert.deepEqual(visible(b),visible(a));assert.equal(b.buffer.active.viewportY,a.buffer.active.viewportY);
  for(const s of ['\x1b8\x1b[6n','\x1b[?1049h\x1b[38;2;1;2;3mNEXT界\x1b[?1049l','\r\nAFTER']){await write(a,s);await write(b,s);}
  const ac=await captureRendererVt(a),bc=await captureRendererVt(b);assert.deepEqual(bc.state,ac.state);
 }finally{a.dispose();b.dispose();}
});
test('oldest history is cut to fit while the retained viewport stays on the same content',async()=>{
 const a=terminal(),b=terminal();
 try{
  await write(a,Array.from({length:1000},(_,n)=>`row-${String(n).padStart(4,'0')} `+'x'.repeat(60)+'\r\n').join(''));
  a.scrollToLine(a.buffer.normal.baseY-2);
  const cp=await captureRendererVt(a,128*1024,1000);assert.ok(cp.cutLines>0);assert.equal(cp.viewportClamped,false);assert.ok(Buffer.byteLength(JSON.stringify(cp))<=128*1024);
  restoreRendererVt(b,parseRendererCheckpoint(Buffer.from(JSON.stringify(cp)),128*1024));
  assert.deepEqual(visible(b),visible(a));assert.equal(a.buffer.normal.baseY-a.buffer.normal.viewportY,b.buffer.normal.baseY-b.buffer.normal.viewportY);
  assert.equal(b.buffer.normal.length,a.buffer.normal.length-cp.cutLines);
  a.scrollToTop();const clamped=await captureRendererVt(a,128*1024,1000);assert.equal(clamped.viewportClamped,true);
  const c=terminal();
  try {
   restoreRendererVt(c,parseRendererCheckpoint(Buffer.from(JSON.stringify(clamped)),128*1024));
   assert.equal(c.buffer.normal.viewportY,0,'clamped viewport starts at the oldest retained line');
   const expected=Array.from({length:a.rows},(_,n)=>a.buffer.normal.getLine(clamped.cutLines+n)?.translateToString());
   assert.deepEqual(visible(c),expected);
   assert.ok(visible(c)[0].includes(`row-${String(clamped.cutLines).padStart(4,'0')}`));
  } finally {c.dispose();}
 }finally{a.dispose();b.dispose();}
});
test('partial or stuck renderer capture refuses display only, within its deadline',async()=>{
 const a=terminal();let complete;
 try{
  await write(a,'\x1b[');await assert.rejects(captureRendererVt(a),/ground state/);await write(a,'0m');
  const blocked=new Promise(resolve=>{complete=resolve;});const h=a.parser.registerCsiHandler({final:'m'},()=>blocked);a.write('\x1b[31m');
  await assert.rejects(captureRendererVt(a,128*1024,20),/deadline/);complete(true);h.dispose();await write(a,'');
 }finally{complete?.(true);a.dispose();}
});
test('renderer envelope and private VT schema are checked before restoration',async()=>{
 const a=terminal();
 try{
  const cp=await captureRendererVt(a);
  for(const mutate of [c=>{c.browserEngine='bad';},c=>{c.state.normal.state.x=-1;},c=>{c.state.options.logger={};},c=>{c.unknown=true;},c=>{c.cutLines=-1;}]){
   const bad=structuredClone(cp);mutate(bad);assert.throws(()=>parseRendererCheckpoint(Buffer.from(JSON.stringify(bad))));
  }
 }finally{a.dispose();}
});
test('compact rows cannot amplify retained cells before the allocation preflight',async(t)=>{
 const a=terminal();
 try {
  const cp=await captureRendererVt(a);
  cp.state.normal.lines=Array.from({length:3001},()=>({length:1000,isWrapped:false,runs:{text:'',flags:[],attrs:[[1000,0,0]]},combined:{},extended:{}}));
  cp.state.alternate.lines=[];
  const shared=require('../shared/renderer-cell-runs.cjs');let decoded=0;
  t.mock.method(shared,'decodeCellRuns',()=>{decoded++;throw Error('Decoded before allocation preflight');});
  assert.throws(()=>parseRendererCheckpoint(Buffer.from(JSON.stringify(cp))),/retained-cell allocation limit/);
  assert.equal(decoded,0);
 }finally{a.dispose();}
});
function cellDigest(term){
 const hash=createHash('sha256');
 for(const b of [term._core._bufferService.buffers.normal,term._core._bufferService.buffers.alt]){
  hash.update(String(b.lines.length));
  for(let n=0;n<b.lines.length;n++){
   const line=b.lines.get(n);hash.update(Buffer.from(line._data.buffer,line._data.byteOffset,line.length*12));
   hash.update(JSON.stringify([line.isWrapped,line._combined,line._extendedAttrs]));
  }
 }
 return hash.digest('hex');
}
for(const file of fs.readdirSync('tests/fixtures/own-screens').filter(n=>n.endsWith('.raw'))){
 test(`renderer row encoding preserves exact recorded ${file} cell planes and continuations`,async()=>{
  const meta=JSON.parse(fs.readFileSync('tests/fixtures/own-screens/'+file.replace('.raw','.meta.json')));
  const options={cols:meta.cols,rows:meta.rows,scrollback:10000,cursorBlink:true,scrollOnEraseInDisplay:true,allowProposedApi:true};
  const a=createRendererVt(options),b=createRendererVt(options);
  try{
   const cleaned=extractAyaOsc(fs.readFileSync('tests/fixtures/own-screens/'+file).toString('utf8'),'').cleaned;
   await write(a,normalizeTerminalLinkUnderline(stripScrollbackErase(cleaned)));
   // A truncated recording may stop in CSI; take its next supported ground
   // boundary, as the display capture contract requires.
   await write(a,'\x18');
   const cp=await captureRendererVt(a,4*1024*1024,1000);assert.equal(cp.cutLines,0);
   restoreRendererVt(b,parseRendererCheckpoint(Buffer.from(JSON.stringify(cp)),4*1024*1024));
   assert.equal(cellDigest(b),cellDigest(a),'exact content/attribute/combined/extended cell planes');
   const replies=[[],[]];a.onData(s=>replies[0].push(s));b.onData(s=>replies[1].push(s));
   for(const text of ['\x1b[38;2;12;34;56m界é','\x1b[?1049hFUTURE\x1b[?1049l','\x1b[6n']){await write(a,text);await write(b,text);}
   assert.equal(cellDigest(b),cellDigest(a));assert.deepEqual(replies[0],replies[1]);
   assert.deepEqual((await captureRendererVt(b,4*1024*1024,1000)).state,(await captureRendererVt(a,4*1024*1024,1000)).state);
  }finally{a.dispose();b.dispose();}
 });
}
