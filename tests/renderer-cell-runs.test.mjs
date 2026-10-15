import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {encodeCellRuns,decodeCellRuns}=require('../shared/renderer-cell-runs.cjs');
test('row text/attribute runs preserve every content flag and uint32 attribute word',()=>{
 for(let seed=0;seed<100;seed++){
  const length=1+seed*7,words=new Uint32Array(length*3);
  for(let n=0;n<length;n++){
   const point=n%13===0?0:n%7===0?0x1f600:n%11===0?0x754c:33+(seed+n)%90;
   words[n*3]=point|((n%6)<<21);words[n*3+1]=(0xff000000+seed+n)>>>0;words[n*3+2]=n%5===0?0xabcdef:0;
  }
  const encoded=encodeCellRuns(words,length);assert.ok(encoded);assert.deepEqual(decodeCellRuns(encoded,length),words);
 }
 const blanks=new Uint32Array(120*3);for(let n=0;n<120;n++)blanks[n*3]=1<<22;
 const compact=encodeCellRuns(blanks,120);assert.equal(compact.text,'');assert.deepEqual(compact.flags,[]);assert.deepEqual(decodeCellRuns(compact,120),blanks);
});
test('unsupported lone surrogate cell content uses the lossless raw row fallback',()=>{
 const words=new Uint32Array([0xd800|(1<<22),0,0,0xdc00|(1<<22),0,0]);assert.equal(encodeCellRuns(words,2),null);
});
test('invalid ranges, overlaps, flags, text and uint32 runs refuse before row reconstruction',()=>{
 const good={text:'abc',flags:[],attrs:[[5,0,0]]};
 for(const mutate of [v=>{v.extra=1;},v=>{v.text='toolong';},v=>{v.text='\ud800';},v=>{v.attrs=[];},v=>{v.attrs[0][0]=4;},v=>{v.attrs=[[2,0,0],[2,0,0]];},v=>{v.attrs[0][1]=-1;},v=>{v.attrs[0][2]=2**32;},v=>{v.flags=[[0,3,0],[2,4,1]];},v=>{v.flags=[[0,6,0]];},v=>{v.flags=[[0,3,2]];}]){
  const bad=structuredClone(good);mutate(bad);assert.throws(()=>decodeCellRuns(bad,5),/Invalid renderer cell runs/);
 }
});
