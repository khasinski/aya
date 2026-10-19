import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {startControlServerOn} from '../dist-electron/control.js';
import {explainPaneSnapshot} from '../dist-electron/pane-state.js';
import {envWithoutAya} from './helpers/env.mjs';
const root=mkdtempSync(join(tmpdir(),'aya-state-cli-')),home=join(root,'home'),socket=join(root,'aya.sock');mkdirSync(home);
const id='3f1c2a9e-0d4b-4e8a-9c51-7b2d6e0f1a11',other='8a7b6c5d-1e2f-4a3b-8c9d-0e1f2a3b4c22',calls=[];
const unsafe='d1d1d1d1-0000-4000-8000-000000000a01',unsafeName='worker: idle; busy: no; hold: none\nFORGED\t\x1b]0;title\x07\u202e';
const projects=[{slug:'one',directory:root,tabs:[{id,name:'worker',presetId:'claude'},{id:unsafe,name:unsafeName,presetId:'claude'}]},{slug:'two',directory:home,tabs:[{id:other,name:'worker',presetId:'claude'}]}];
const state=explainPaneSnapshot({generation:'g',agent:'claude',shell:false,composerSeen:true,openedAt:0,lastOutputAt:0,cols:80,rows:['esc to interrupt'],cells:[[]]});
const stop=startControlServerOn(socket,{getWindow:()=>null,openProject:()=>{},listProjects:async()=>projects,paneState:async pane=>{calls.push(pane);return state;}});
test.after(()=>{stop();rmSync(root,{recursive:true,force:true});});
function aya(args){return new Promise((done,fail)=>{const child=spawn('/bin/sh',[resolve('bin/aya'),'pane','state',...args],{env:{...envWithoutAya(),HOME:home,AYA_SOCKET:socket},cwd:root,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',fail);child.on('close',status=>done({status,out,err}));});}
test('real CLI state/explain resolves IDs/projects and forwards no writes',async()=>{
 for(const args of [[id,'--explain'],['--project','one','worker','--explain'],['worker','--explain','--project=one']]){const r=await aya(args);assert.equal(r.status,0,r.err);assert.match(r.out,/"worker": busy/);assert.match(r.out,/busy rule: claude-busy/);assert.match(r.out,/source: builtin\/claude/);assert.equal(calls.at(-1),id);}
 const basic=await aya([id]);assert.equal(basic.status,0);assert.doesNotMatch(basic.out,/excerpt/);
 const ambiguous=await aya(['worker']);assert.notEqual(ambiguous.status,0);assert.match(ambiguous.err,/ambiguous/);
 for(const args of [[id,'--wat'],[id,'--explain','--explain'],[],[id,other]]){const r=await aya(args);assert.notEqual(r.status,0);assert.match(r.err,/Usage/);}
 assert.equal(calls.length,4);
});


test('real CLI quotes a configured name with newlines, tab, ESC and bidi as one output field',async()=>{
 const r=await aya([unsafe,'--explain']);assert.equal(r.status,0,r.err);
 assert.match(r.out,/^"worker: idle; busy: no; hold: none\\nFORGED\\t/);
 assert.doesNotMatch(r.out,/\nFORGED|[\x1b\x07\u202e]/);
 assert.match(r.out,/\\u001b/);assert.match(r.out,/\\u202e/);
 assert.match(r.out,/": busy; busy: yes/);
});
