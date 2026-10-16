import {test} from 'node:test';
import assert from 'node:assert/strict';
import {explainPaneSnapshot,formatPaneState} from '../dist-electron/pane-state.js';
import {PtyHostClient} from '../dist-electron/pty-host-client.js';
const snapshot=(rows,agent='claude',extra={})=>({generation:'g',agent,shell:false,composerSeen:true,openedAt:0,lastOutputAt:0,cols:120,rows,cells:rows.map(r=>[...r].map((c,x)=>[x,c,0,0])),...extra});

test('state explains busy, generic approval, suppression, usage/account and policy-only holds',()=>{
 const busy=explainPaneSnapshot(snapshot(['esc to interrupt']));assert.equal(busy.state,'busy');assert.equal(busy.evidence.find(e=>e.for==='busy').match.id,'claude-busy');
 const waiting=explainPaneSnapshot(snapshot(['Do you want to proceed?']));assert.equal(waiting.state,'waiting');assert.equal(waiting.evidence.find(e=>e.for==='hold').match.source,'builtin/generic');
 const idle=explainPaneSnapshot(snapshot(['Do you want to proceed?','? for shortcuts']));assert.equal(idle.state,'idle');assert.equal(idle.evidence[0].match.id,'composer-hint');
 const account=explainPaneSnapshot(snapshot(['Do you want to proceed?','keep allowing any reads outside the working directories']));assert.equal(account.evidence.find(e=>e.for==='hold').match.id,'claude-account-setting');
 const usage=explainPaneSnapshot(snapshot(['Do you want to proceed?','Your workspace is out of credits'],'codex'));assert.equal(usage.evidence.find(e=>e.for==='hold').match.id,'codex-usage-limit');
 const draft=explainPaneSnapshot(snapshot(['❯ typed']));assert.equal(draft.state,'held');assert.equal(draft.evidence.find(e=>e.for==='hold').policy,'draft');
 const choice=explainPaneSnapshot(snapshot(['❯ 1. choose']));assert.equal(choice.state,'waiting');assert.equal(choice.evidence.find(e=>e.for==='waiting').policy,'numbered-choice');
 const unknown=explainPaneSnapshot(snapshot(['Do you want to proceed?'],'claude',{recoveryUnknown:true}));assert.equal(unknown.state,'unknown');assert.equal(unknown.busy,false);assert.equal(unknown.evidence[0].policy,'recovery-screen-unknown');
 const starting=explainPaneSnapshot(snapshot(['Starting...'],'claude',{composerSeen:false}));assert.equal(starting.evidence.find(e=>e.for==='hold').policy,'starting');
 assert.equal(explainPaneSnapshot(snapshot(['text'],'custom',{shell:true})).state,'shell');
});

test('paneState reads one fresh applied snapshot and never sends composer metadata or mutates it',async()=>{
 const client=new PtyHostClient('/unused'),calls=[],s=snapshot(['❯ '],'claude',{composerSeen:false});
 client.socket={destroyed:false,destroy(){this.destroyed=true;}};client.sendRequest=async (_socket,request)=>{calls.push(request);return s;};
 try{const before=structuredClone(s);await client.paneState('p');assert.deepEqual(s,before);assert.deepEqual(calls,[{id:0,type:'snapshot',ptyId:'p'}]);}finally{client.dispose();}
});

test('missing, disconnected and malformed state is never silently idle',async()=>{
 const client=new PtyHostClient('/unused');
 client.socket={destroyed:false,destroy(){this.destroyed=true;}};
 try{for(const [value,state] of [[null,'stopped'],['starting','starting'],['disconnected','unknown'],[{},'unknown']]){client.sendRequest=async()=>value;assert.equal((await client.paneState('p')).state,state);}
 client.sendRequest=async()=>{throw Error('host unavailable');};assert.equal((await client.paneState('p')).state,'unknown');}finally{client.dispose();}
});

test('explain prints the actual match and metadata, basic state omits excerpts',()=>{
 const r=explainPaneSnapshot(snapshot(['Do you want to proceed?']));
 assert.match(formatPaneState('worker',r,true),/waiting rule: do-you-want \(prompt; waiting\)\nsource: builtin\/generic; rules: 1 \([a-f0-9]{64}\)\nregion: tail\nexcerpt: Do you want to/);
 assert.doesNotMatch(formatPaneState('worker',r,false),/excerpt|source/);
});


test('blocked crash state is unknown without trying to reconnect or start a host',async()=>{
 const client=new PtyHostClient('/unused');client.crashBlocked=true;client.request=()=>{throw Error('must not request');};
 try{const r=await client.paneState('p');assert.equal(r.state,'unknown');assert.match(r.hold,/disconnected or recovering/);}finally{client.dispose();}
});

test('state protocol rejects a non-boolean explain option',async()=>{
 const {parseControlRequest}=await import('../dist-electron/control-protocol.js');
 assert.throws(()=>parseControlRequest({type:'pane-state',target:'p',explain:'yes'}),/must be boolean/);
 assert.throws(()=>parseControlRequest({type:'pane-state'}),/requires target/);
 assert.equal(parseControlRequest({type:'pane-state',target:'p'}).explain,false);
});


test('empty seen-composer snapshot is unknown without changing its hold/busy/status',()=>{
 const r=explainPaneSnapshot(snapshot([],'claude',{composerSeen:true}));
 assert.equal(r.state,'unknown');assert.equal(r.reason,'no screen evidence yet');assert.equal(r.hold,null);assert.equal(r.busy,false);assert.equal(r.waiting,null);
 const text=formatPaneState('agent',r,true);assert.match(text,/no screen evidence yet/);assert.doesNotMatch(text,/No rule matched/);
 assert.match(formatPaneState('agent',explainPaneSnapshot(snapshot(['ordinary output'])),true),/No rule matched/);
});
test('suppressor explanation states its clear result',()=>{
 const text=formatPaneState('agent',explainPaneSnapshot(snapshot(['Do you want to proceed?','? for shortcuts'])),true);
 assert.match(text,/waiting: no/);assert.match(text,/composer-hint \(suppressor; clear\)/);
});


test('blank retained rows are not invented idle evidence either',()=>{
 const r=explainPaneSnapshot(snapshot(['','  '],'claude',{composerSeen:true}));
 assert.equal(r.state,'unknown');assert.equal(r.reason,'no screen evidence yet');assert.equal(r.hold,null);assert.equal(r.busy,false);assert.equal(r.waiting,false);
});
