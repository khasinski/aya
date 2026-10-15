import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import proof from '../scripts/spikes/vt-checkpoint.cjs';
const require=createRequire(import.meta.url);
const {validateVtSnapshot,parseVtSnapshot,validateVtTail,validateCheckpointJson,MAX_VT_SNAPSHOT_BYTES,MAX_VT_TAIL_BYTES}=require('../dist-electron/vt-checkpoint-schema.js');
const blank=new proof.CompactVt({cols:80,rows:24,scrollback:0});
const base=blank.checkpoint().base,defaults=structuredClone(base.options),engine=base.engine;blank.term.dispose();
const valid=d=>validateVtSnapshot(d,engine,defaults);
test('closed schema accepts actual recorded VT snapshots and tails',async()=>{
 for(const file of fs.readdirSync('tests/fixtures/own-screens').filter(f=>f.endsWith('.raw'))){
  const meta=JSON.parse(fs.readFileSync(`tests/fixtures/own-screens/${file.replace('.raw','.meta.json')}`));
  const p=new proof.CompactVt({cols:meta.cols,rows:meta.rows,scrollback:64});
  try{await p.write(fs.readFileSync(`tests/fixtures/own-screens/${file}`));await p.write('\x18');
   const cp=p.checkpoint();valid(cp.base);validateVtTail(cp.tail);
   assert.deepEqual(parseVtSnapshot(Buffer.from(JSON.stringify(cp.base)),engine,defaults),cp.base);
  }finally{p.term.dispose();}
 }
});
for(const [name,mutate] of [
 ['unknown top field',d=>{d.unknown=true;}],['unknown nested field',d=>{d.core.extra=true;}],
 ['engine mismatch',d=>{d.engine='a'.repeat(64);}],['non-ground',d=>{d.parser.currentState=1;}],
 ['huge cols',d=>{d.cols=1000000000;}],['fractional geometry',d=>{d.rows=24.5;}],
 ['NaN coordinate',d=>{d.normal.state.x=NaN;}],['negative scroll',d=>{d.normal.state.ybase=-1;}],
 ['inverted region',d=>{d.normal.state.scrollTop=23;d.normal.state.scrollBottom=0;}],
 ['empty normal',d=>{d.normal.lines=[];}],['short active alternate',d=>{d.active='alternate';}],
 ['constructor option injection',d=>{d.options.logger={};}],['unsupported option',d=>{d.options.convertEol=true;}],
 ['bogus mode',d=>{d.core.decPrivateModes.origin=1;}],['unknown mouse protocol',d=>{d.mouse._activeProtocol='custom';}],
 ['callback mouse state',d=>{d.mouse._lastEvent={};}],['unknown charset state',d=>{d.charset.glevel=4;}],
 ['bad parameter storage',d=>{d.parser.params.params='';}],['negative param count',d=>{d.parser.params.length=-1;}],
 ['invalid decoder',d=>{d.utf8Interim='!!!!';}],['Unicode override',d=>{d.unicode='15';}],
 ['invalid parameter offsets',d=>{const b=Buffer.from(d.parser.params.indices,'base64');b.writeUInt16LE(0x2021);d.parser.params.indices=b.toString('base64');}],
 ['missing extended cell',d=>{const b=Buffer.from(d.normal.lines[0].data,'base64');b.writeUInt32LE(0x10000000,8);d.normal.lines[0].data=b.toString('base64');}],
 ['invalid palette',d=>{d.palette={'259':[0,0,0]};}],['invalid colour',d=>{d.palette={'1':[256,0,0]};}],
 ['truncated cells',d=>{d.normal.lines[0].data=d.normal.lines[0].data.slice(4);}],
 ['noncanonical base64',d=>{d.normal.lines[0].data='!'.repeat(d.normal.lines[0].data.length);}],
 ['out-of-range combined index',d=>{d.normal.lines[0].combined={'80':'x'};}],
 ['missing combined cell',d=>{const b=Buffer.from(d.normal.lines[0].data,'base64');b.writeUInt32LE(0x600000);d.normal.lines[0].data=b.toString('base64');}],
 ['invalid code point',d=>{const b=Buffer.from(d.normal.lines[0].data,'base64');b.writeUInt32LE(0x5fffff);d.normal.lines[0].data=b.toString('base64');}],
 ['duplicate link IDs',d=>{d.links={nextId:2,entries:[{id:1,data:{uri:'a'},lines:[]},{id:1,data:{uri:'b'},lines:[]}]};}],
 ['out-of-buffer marker',d=>{d.links={nextId:2,entries:[{id:1,data:{uri:'a'},lines:[{buffer:'normal',line:24}]}]};}],
 ['prototype key',d=>{d.metadata=JSON.parse('{"__proto__":{"polluted":true}}');}],
 ['constructor key',d=>{d.metadata={constructor:{}};}],['function',d=>{d.metadata={f:()=>{}};}],
])test(`VT schema refuses ${name}`,()=>{const d=structuredClone(base);mutate(d);assert.throws(()=>valid(d),/Invalid VT checkpoint/);});
test('snapshot byte bound is checked before parsing',()=>{
 assert.throws(()=>parseVtSnapshot(Buffer.alloc(MAX_VT_SNAPSHOT_BYTES+1),engine,defaults),/snapshot size/);
});
test('generic envelope rejects deep trees, aliases, cycles and unsafe values',()=>{
 let deep={};for(let n=0;n<26;n++)deep={deep};
 const cycle={};cycle.cycle=cycle;
 const shared={};
 for(const bad of [deep,cycle,{a:shared,b:shared},{a:Infinity},{a:undefined},new Date(),{a:1n}])assert.throws(()=>validateCheckpointJson(bad),/Invalid VT checkpoint/);
});
test('tail refuses oversized, mixed, malformed and unbounded operations',()=>{
 validateVtTail([{text:'\x1b['},{resize:[80,24]},{bytes:'MG1Y'}]);
 for(const bad of [[{text:'a',resize:[80,24]}],[{text:'a'.repeat(MAX_VT_TAIL_BYTES)}],[{bytes:'===='}],[{resize:[0,24]}],[{resize:[80,24,1]}],[{unknown:1}]])assert.throws(()=>validateVtTail(bad),/Invalid VT checkpoint/);
});
