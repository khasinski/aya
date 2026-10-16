import { test } from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import xterm from '@xterm/headless';
const {Terminal}=xterm;
import {snapshotOf} from '../dist-electron/vt-mirror.js';
import * as current from '../dist-electron/vt-state.js';
import * as rules from '../dist-electron/agent-screen-rules.js';
import reference from './helpers/vt-state-baseline.cjs';
import oldRules from './helpers/agent-screen-rules-baseline.cjs';
const agents=[undefined,'claude','codex','opencode','grok','antigravity','hermes'];
const root=fileURLToPath(new URL('./fixtures/',import.meta.url));
function check(snapshot,label){
 for(const agent of agents)for(const composerSeen of [false,true]){
  const s={...snapshot,agent,composerSeen};
  for(const fn of ['snapshotBusy','snapshotHold','snapshotStatus'])assert.deepEqual(current[fn](s),reference[fn](s),label+'/'+agent+'/'+composerSeen+'/'+fn);
  for(const fn of ['evaluateScreen','screenIsBusy','screenOffersAccountSetting','screenShowsUsageLimit','asksToRunAya'])assert.deepEqual(rules[fn](s.rows,agent),oldRules[fn](s.rows,agent),label+'/'+agent+'/'+fn);
 }
}
function files(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]);}

test('frozen main verdicts match bundled rules for every recorded raw chunk and applied continuation',async t=>{
 let sessions=0,chunks=0;
 for(const file of files(root).filter(f=>f.endsWith('.raw'))){
  const raw=readFileSync(file);let meta;try{meta=JSON.parse(readFileSync(file.replace(/\.raw$/,'.meta.json')));}catch{meta={cols:200,rows:60};}
  const chunkFile=file.replace(/\.raw$/,'.chunks.jsonl');let parts;
  try{parts=readFileSync(chunkFile,'utf8').trim().split('\n').map(x=>JSON.parse(x).len);}catch{parts=[raw.length];}
  const term=new Terminal({cols:meta.cols,rows:meta.rows,scrollback:0,allowProposedApi:true});
  const pane={terminal:term,agent:undefined,shell:false,composerSeen:false,openedAt:Date.now()-10000,lastOutputAt:Date.now()-5000,lastWaiting:false,onChange:()=>{},timer:null};
  try{
   let offset=0;
   for(const length of parts){await new Promise(done=>term.write(raw.subarray(offset,offset+length),done));offset+=length;check(snapshotOf(pane),file+'/'+offset);chunks++;}
   if(offset<raw.length){await new Promise(done=>term.write(raw.subarray(offset),done));check(snapshotOf(pane),file+'/remaining');chunks++;}
   for(const continuation of ['\x1b[','31mCONTINUATION\x1b[0m','\x1b[?1049hALT\r\nDo you want to proceed?','\x1b[?1049l']){await new Promise(done=>term.write(continuation,done));check(snapshotOf(pane),file+'/continued');chunks++;}
   check({...snapshotOf(pane),recoveryUnknown:true},file+'/recovery-unknown');
   check({...snapshotOf(pane),shell:true},file+'/shell');
  }finally{term.dispose();}
  sessions++;
 }
 assert.ok(sessions>=15);assert.ok(chunks>100);t.diagnostic(`Compared ${sessions} recorded sessions, ${chunks} applied chunks/continuations across all built-in agents and generic fallback.`);
});

test('every saved plain screen and empty snapshot retains main busy/hold/dialog decisions',()=>{
 for(const file of files(root).filter(f=>f.endsWith('.screen.txt')||f.endsWith('.txt'))){
  const rows=readFileSync(file,'utf8').trimEnd().split('\n');
  const s={generation:'equivalence',agent:undefined,shell:false,composerSeen:true,openedAt:Date.now()-10000,lastOutputAt:Date.now()-5000,cols:200,rows,cells:rows.map(r=>[...r].map((c,x)=>[x,c,0,0]))};
  check(s,file);
 }
 check({generation:'empty',shell:false,composerSeen:false,openedAt:Date.now(),lastOutputAt:null,cols:80,rows:[],cells:[]},'empty');
});
