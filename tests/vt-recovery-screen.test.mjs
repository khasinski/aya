import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{Terminal}=require('@xterm/headless');
const {RecoveryScreen}=await import('../dist-electron/vt-recovery-screen.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const write=(t,s)=>new Promise(resolve=>t.write(s,resolve));
function fixture(rows=4){const term=new Terminal({cols:120,rows,allowProposedApi:true});const states=[];const tracker=new RecoveryScreen(term,(known,timeout)=>states.push({known,timeout}),10,100);return {term,states,close:()=>{tracker.dispose();term.dispose();}};}
for(const cli of ['claude','codex'])test(`recorded ${cli} rows become known after an Ink-style per-row redraw and settle`,async()=>{
 const lines=fs.readFileSync(new URL(`./fixtures/busy-${cli}.screen.txt`,import.meta.url),'utf8').trimEnd().split('\n');
 const f=fixture(lines.length);
 try{await write(f.term,lines.map((line,i)=>`\x1b[${i+1};1H\x1b[2K${line}`).join(''));assert.deepEqual(f.states,[]);await sleep(25);assert.deepEqual(f.states,[{known:true,timeout:false}]);}
 finally{f.close();}
});
test('fragments and control-looking OSC/DCS payloads do not prove full screen',async()=>{
 const f=fixture();try{await write(f.term,'partial\x1b]2;fake [2J\x07\x1bPfake [2J\x1b\\');await sleep(25);assert.deepEqual(f.states,[]);await sleep(100);assert.deepEqual(f.states,[{known:false,timeout:true}]);await write(f.term,'\x1b[2Jlater redraw');await sleep(25);assert.deepEqual(f.states.at(-1),{known:true,timeout:false});}finally{f.close();}
});
for(const reset of ['\x1bc','\x1b[2J'])test(`parser-dispatched full reset ${JSON.stringify(reset)} needs quiet applied output`,async()=>{
 const f=fixture();try{await write(f.term,reset);for(let n=0;n<4;n++){await sleep(5);await write(f.term,'x');assert.deepEqual(f.states,[]);}await sleep(25);assert.deepEqual(f.states,[{known:true,timeout:false}]);}finally{f.close();}
});
test('resize and alternate-buffer activation invalidate prior row coverage',async()=>{
 for(const action of [t=>t.resize(119,4),t=>write(t,'\x1b[?1049h')]){
  const f=fixture();try{await write(f.term,'\x1b[1;1Hfirst\x1b[2;1Hsecond');await action(f.term);await write(f.term,'\x1b[3;1Hthird\x1b[4;1Hfourth');await sleep(25);assert.deepEqual(f.states,[]);await write(f.term,'\x1b[1;1Hfirst\x1b[2;1Hsecond');await sleep(25);assert.deepEqual(f.states,[{known:true,timeout:false}]);}finally{f.close();}
 }
});
test('scrolling a fragment cannot cover rows that were only shifted',async()=>{
 const f=fixture();try{await write(f.term,'\x1b[4;1Hbottom\nnext');await sleep(25);assert.deepEqual(f.states,[]);}finally{f.close();}
});


test('empty applied-snapshot drains cannot postpone settling a completed redraw',async()=>{
 const f=fixture();try{await write(f.term,'\x1b[2Jcomplete');for(let i=0;i<15;i++){await write(f.term,'');await sleep(2);}assert.deepEqual(f.states,[{known:true,timeout:false}]);}finally{f.close();}
});
