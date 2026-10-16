import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createScreenRuleProvider,HOLD_RULES_UNAVAILABLE} from '../dist-electron/screen-rule-provider.js';
import {screenRuleExcerpt,evaluateScreenEvidence,matchingScreenRule} from '../dist-electron/agent-screen-rules.js';

test('invalid bundle is sticky, clearly unavailable, and logs exactly one diagnostic',()=>{
 let loads=0;const logs=[];
 const p=createScreenRuleProvider(()=>{loads++;throw Error('unsafe data\x1b[2J');});p.setLogger((...a)=>logs.push(a));
 for(let i=0;i<5;i++)assert.deepEqual(p.get(),{available:false,reason:HOLD_RULES_UNAVAILABLE});
 assert.equal(loads,1);assert.deepEqual(logs,[["screen-rules-unavailable",{reason:HOLD_RULES_UNAVAILABLE}]]);
});

test('unavailable bundled rules cannot clear agent hold/status, busy remains false',()=>{
 const code=`const d=require('./dist-electron/screen-rule-data');d.loadBundledScreenRules=()=>{throw Error('bad bundle');};const p=require('./dist-electron/screen-rule-provider');const logs=[];p.builtinScreenRules.setLogger((...a)=>logs.push(a));const v=require('./dist-electron/vt-state');const s={generation:'g',agent:'claude',shell:false,composerSeen:true,openedAt:0,lastOutputAt:0,cols:80,rows:['Do you want to proceed?'],cells:[[]]};console.log(JSON.stringify({hold:v.snapshotHold(s),busy:v.snapshotBusy(s),status:v.snapshotStatus(s),rules:p.builtinScreenRules.get(),logs}));`;
 const r=JSON.parse(execFileSync(process.execPath,['-e',code],{encoding:'utf8',timeout:5000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}}));
 assert.equal(r.hold.hold,HOLD_RULES_UNAVAILABLE);assert.equal(r.busy,false);assert.equal(r.status.waiting,null);
 assert.deepEqual(r.rules,{available:false,reason:HOLD_RULES_UNAVAILABLE});assert.equal(r.logs.length,1);
});

test('winning rule explains the same precedence, exact match, source and version',()=>{
 const r=evaluateScreenEvidence(['Do you want to proceed?','? for shortcuts'],'claude');
 assert.equal(r.verdict,'clear');assert.equal(r.match.id,'composer-hint');assert.equal(r.match.region,'lastLine');
 assert.equal(r.match.source,'builtin/claude');assert.equal(r.match.version,'1');assert.match(r.match.digest,/^[a-f0-9]{64}$/);
 assert.equal(r.match.excerpt,'? for shortcuts');
 assert.equal(matchingScreenRule(['esc to interrupt'],'claude','busy').id,'claude-busy');
 assert.equal(evaluateScreenEvidence(['normal text'],'claude').match,null);
});

test('excerpt strips complete/incomplete ESC strings, C0/C1, bidi and every terminal control',()=>{
 for(const sequence of ['\x1b[31m','\x1b[?2004h','\x1b]52;c;SECRET\x07','\x1bPSECRET\x1b\\','\x9dSECRET\x9c','\x1b(B'])assert.equal(screenRuleExcerpt('LEFT'+sequence+'RIGHT'),'LEFTRIGHT');
 assert.equal(screenRuleExcerpt('VISIBLE\x1b]52;c;unfinished'),'VISIBLE');
 for(let c=0;c<256;c++)if(c<32||c>=127&&c<=159)assert.doesNotMatch(screenRuleExcerpt('LEFT'+String.fromCharCode(c)+'RIGHT'),/[\p{Cc}\p{Bidi_Control}]/u);
 assert.equal(screenRuleExcerpt('LEFT\u202e\u202c\u2066\u2069RIGHT'),'LEFTRIGHT');
 assert.equal([...screenRuleExcerpt('界'.repeat(200))].length,160);
});

test('a rule-only data edit changes the rule identity while the real PTY core identity stays stable', async()=>{
 const {hostModuleFiles,hostBuildHash}=await import('../dist-electron/pty-host-staleness.js');
 const {parseScreenRules}=await import('../dist-electron/screen-rule-data.js');
 const fs=await import('node:fs'),path=await import('node:path'),os=await import('node:os');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aya-rule-hash-'));
 const built=new URL('../dist-electron/',import.meta.url).pathname;
 try{
  for(const name of hostModuleFiles(built,'pty-host.js')){const target=path.join(dir,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(built,name),target);}
  for(const [name,data] of Object.entries({'aya-pty-owner':'owner','pty-owner-bridge.node':'bridge','node_modules/node-pty/package.json':'{"main":"lib/index.js"}','node_modules/node-pty/lib/index.js':'runtime','node_modules/node-pty/build/Release/pty.node':'native','node_modules/@xterm/headless/package.json':'{"main":"lib-headless/xterm-headless.js"}','node_modules/@xterm/headless/lib-headless/xterm-headless.js':'mirror'})){const target=path.join(dir,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data);}
  const bytes=fs.readFileSync(new URL('../electron/screen-rules/builtin.json',import.meta.url));
  const a=parseScreenRules(bytes),before=hostBuildHash(dir,'pty-host.js');
  const changed=JSON.parse(bytes);changed.ruleSetVersion='2';changed.sets.generic.rules[0].pattern='new prompt';
  fs.mkdirSync(path.join(dir,'screen-rules'));const raw=Buffer.from(JSON.stringify(changed));fs.writeFileSync(path.join(dir,'screen-rules/builtin.json'),raw);
  const b=parseScreenRules(raw);assert.notEqual(a.digest,b.digest);assert.equal(b.version,'2');assert.equal(hostBuildHash(dir,'pty-host.js'),before);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
