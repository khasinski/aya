import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {loadBundledScreenRules,RULE_AGENTS}=require('../dist-electron/screen-rule-data.js');
const {parseUserRuleFile,readUserScreenRules,readUserRuleFile,MAX_USER_DIRECTORY_ENTRIES}=require('../dist-electron/screen-user-rule-data.js');
const builtin=loadBundledScreenRules();
const rule=(id='local-prompt',extra={})=>({id,kind:'prompt',region:'tail',pattern:'LOCAL_APPROVAL',flags:'i',...extra});
const envelope=(agent,rules=[rule()],extra={})=>({schemaVersion:1,ruleSetVersion:'local-1',agent,rules,...extra});
const bytes=value=>Buffer.from(JSON.stringify(value));
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'aya-user-rules-'));fs.chmodSync(root,0o700);return{root,write:(agent,rules=[rule()],extra={})=>fs.writeFileSync(path.join(root,`${agent}.json`),bytes(envelope(agent,rules,extra)),{mode:0o600}),close:()=>fs.rmSync(root,{recursive:true,force:true})};}
test('absent/empty directories do not create anything or require a worker',()=>{
 const f=fixture();try{assert.equal(readUserScreenRules(path.join(f.root,'absent'),builtin),null);assert.equal(fs.existsSync(path.join(f.root,'absent')),false);assert.equal(readUserScreenRules(f.root,builtin),null);}finally{f.close();}
});
test('data stays uncompiled on main, with deterministic additive source/version/order and digest',()=>{
 const f=fixture(),Original=globalThis.RegExp;try{
  f.write('generic',[rule('user-generic')]);f.write('claude',[rule('user-claude',{pattern:'(a|aa){1,100}b$'})]);
  globalThis.RegExp=function(){throw Error('main must not compile user patterns');};
  const first=readUserScreenRules(f.root,builtin),again=readUserScreenRules(f.root,builtin);
  assert.equal(first.digest,again.digest);assert.deepEqual(first.sets.claude.map(r=>[r.id,r.source,r.version]),[['user-claude','user/claude.json','local-1'],['user-generic','user/generic.json','local-1']]);
  assert.equal(typeof first.sets.claude[0].pattern,'string');assert.equal(Object.isFrozen(first.sets.claude[0]),true);
  f.write('claude',[rule('user-claude',{pattern:'DIFFERENT'})]);assert.notEqual(readUserScreenRules(f.root,builtin).digest,first.digest);
 }finally{globalThis.RegExp=Original;f.close();}
});
test('closed schema, duplicate decoded keys, strict UTF8 and bounded fields apply before any compile',()=>{
 const valid=envelope('claude');assert.equal(parseUserRuleFile(bytes(valid),'claude').rules.length,1);
 for(const invalid of [{...valid,extra:true},{...valid,agent:'codex'},{...valid,schemaVersion:2},{...valid,ruleSetVersion:'bad\nversion'},{...valid,rules:[rule('x',{extra:1})]},{...valid,rules:[rule('x',{kind:'code'})]},{...valid,rules:[rule('x',{region:'allFiles'})]},{...valid,rules:[rule('x',{flags:'g'})]},{...valid,rules:[rule('x',{flags:'ii'})]},{...valid,rules:[rule('x',{pattern:'x'.repeat(2049)})]},{...valid,rules:[rule('x',{pattern:''})]},{...valid,rules:[rule('x'),rule('x')]}])assert.throws(()=>parseUserRuleFile(bytes(invalid),'claude'));
 assert.throws(()=>parseUserRuleFile(Buffer.from('{"schemaVersion":1,"schemaVers\\u0069on":1}'),'claude'),/duplicate key/);
 assert.throws(()=>parseUserRuleFile(bytes(envelope('claude',[rule('broken',{pattern:42})])),'claude'),/rule 1 pattern is not text/);
 assert.throws(()=>parseUserRuleFile(Buffer.from([0xff]),'claude'));
 assert.throws(()=>parseUserRuleFile(Buffer.alloc(65537,32),'claude'),/file size/);
 assert.equal(parseUserRuleFile(bytes(envelope('claude',[rule('x',{pattern:'(',flags:'imu'})])),'claude').rules[0].pattern,'(','syntax validation belongs to worker');
});
test('no built-in replacement or duplicate user ID is admitted',()=>{
 const f=fixture();try{
  f.write('claude',[rule(builtin.sets.codex[0].id)]);assert.throws(()=>readUserScreenRules(f.root,builtin),/collides/);
  f.write('claude',[rule('same')]);f.write('codex',[rule('same')]);assert.throws(()=>readUserScreenRules(f.root,builtin),/collides/);
 }finally{f.close();}
});
test('authored aggregate admits exactly256 and refuses257 independently of per-set caps',()=>{
 const f=fixture();try{
  const base=new Set(RULE_AGENTS.flatMap(a=>builtin.sets[a].map(r=>r.id))).size,remaining=256-base;
  const counts=[100,100,remaining-200];assert.ok(counts[2]>=0&&counts[2]<100);
  for(const [i,agent] of ['claude','codex','opencode'].entries())f.write(agent,Array.from({length:counts[i]},(_,n)=>rule(`${agent}-${n}`)));
  assert.ok(readUserScreenRules(f.root,builtin));f.write('opencode',Array.from({length:counts[2]+1},(_,n)=>rule(`opencode-${n}`)));
  assert.throws(()=>readUserScreenRules(f.root,builtin),/aggregate authored rule count/);
 }finally{f.close();}
});
test('effective cap includes generic and reviewed built-in rules',()=>{
 const f=fixture();try{
  const maxBuiltin=Math.max(...RULE_AGENTS.map(a=>builtin.sets[a].length));
  f.write('generic',Array.from({length:128-maxBuiltin},(_,n)=>rule(`generic-${n}`)));assert.ok(readUserScreenRules(f.root,builtin));
  f.write('generic',Array.from({length:129-maxBuiltin},(_,n)=>rule(`generic-${n}`)));assert.throws(()=>readUserScreenRules(f.root,builtin),/effective rule count/);
 }finally{f.close();}
});
test('private metadata, symlinks, hardlinks, FIFO and unsafe directory are refused',()=>{
 const f=fixture(),file=path.join(f.root,'claude.json');try{
  f.write('claude');fs.chmodSync(file,0o644);assert.throws(()=>readUserScreenRules(f.root,builtin),/private to your account/);fs.chmodSync(file,0o600);
  fs.linkSync(file,path.join(f.root,'copy'));assert.throws(()=>readUserScreenRules(f.root,builtin),/private to your account/);fs.unlinkSync(path.join(f.root,'copy'));
  fs.renameSync(file,path.join(f.root,'real'));fs.symlinkSync('real',file);assert.throws(()=>readUserScreenRules(f.root,builtin));fs.unlinkSync(file);
  execFileSync('/usr/bin/mkfifo',[file]);assert.throws(()=>readUserScreenRules(f.root,builtin),/private to your account/);fs.unlinkSync(file);
  fs.chmodSync(f.root,0o755);assert.throws(()=>readUserScreenRules(f.root,builtin),/folder must be private/);fs.chmodSync(f.root,0o700);
  fs.symlinkSync(f.root,path.join(f.root,'linked'));assert.throws(()=>readUserScreenRules(path.join(f.root,'linked'),builtin),/folder must be private/);
 }finally{f.close();}
});
test('unknownJSON and a bounded directory scan fail closed; editor temporary files do not add rules',()=>{
 const f=fixture();try{
  fs.writeFileSync(path.join(f.root,'claude.json.tmp'),'ignored');assert.equal(readUserScreenRules(f.root,builtin),null);
  fs.writeFileSync(path.join(f.root,'unknown.json'),'{}');assert.throws(()=>readUserScreenRules(f.root,builtin),/unknown JSON filename/);fs.unlinkSync(path.join(f.root,'unknown.json'));
  for(let n=0;n<MAX_USER_DIRECTORY_ENTRIES;n++)fs.writeFileSync(path.join(f.root,`temp-${n}`),'');assert.throws(()=>readUserScreenRules(f.root,builtin),/directory entry count/);
 }finally{f.close();}
});
test('bounded descriptor reading refuses oversize before read, and growth at65537 before parse',()=>{
 const f=fixture();try{
  f.write('claude');const stat=fs.statSync(path.join(f.root,'claude.json'));let read=0,closed=0,allocated=0;
  const io={openSync:()=>99,closeSync:()=>closed++,fstatSync:()=>({...stat,size:65537,isFile:()=>true}),lstatSync:()=>stat,readSync:()=>{read++;throw Error('must not read');}};
  assert.throws(()=>readUserRuleFile('unused',io),/file size/);assert.equal(read,0);assert.equal(closed,1);
  io.fstatSync=()=>({...stat,size:1,isFile:()=>true});io.readSync=(_fd,buffer,offset,length)=>{allocated=Math.max(allocated,buffer.length);read+=length;return length;};
  assert.throws(()=>readUserRuleFile('unused',io),/file size/);assert.equal(read,65537);assert.equal(allocated,65537);assert.equal(closed,2);
 }finally{f.close();}
});
test('changed descriptor metadata or named inode refuses a seemingly valid file',()=>{
 const f=fixture();try{
  f.write('claude');const file=path.join(f.root,'claude.json'),stat=fs.statSync(file),raw=fs.readFileSync(file);let probes=0;
  const io={...fs,openSync:()=>99,closeSync:()=>{},fstatSync:()=>{probes++;return probes===1?stat:{...stat,mtimeMs:stat.mtimeMs+1};},readSync:(_fd,buffer)=>{raw.copy(buffer);return probes++===1?raw.length:0;},lstatSync:()=>stat};
  assert.throws(()=>readUserRuleFile(file,io),/changed while reading/);
  probes=0;io.fstatSync=()=>stat;let reads=0;io.readSync=(_fd,buffer)=>{raw.copy(buffer);return reads++===0?raw.length:0;};io.lstatSync=()=>({...stat,ino:stat.ino+1});
  assert.throws(()=>readUserRuleFile(file,io),/changed while reading/);
 }finally{f.close();}
});
test('exact64KiB valid data is accepted; wrong UID and file replacement refuse before use',()=>{
 const f=fixture();try{
  const file=path.join(f.root,'claude.json'),valid=bytes(envelope('claude'));
  fs.writeFileSync(file,Buffer.concat([valid,Buffer.alloc(65536-valid.length,32)]),{mode:0o600});assert.equal(readUserRuleFile(file).length,65536);assert.ok(readUserScreenRules(f.root,builtin));
  const stat=fs.statSync(file);let reads=0;
  const io={...fs,openSync:()=>99,closeSync:()=>{},fstatSync:()=>({...stat,uid:stat.uid+1,isFile:()=>true}),readSync:()=>{reads++;throw Error('must not read');}};
  assert.throws(()=>readUserRuleFile(file,io),/private to your account/);assert.equal(reads,0);
 }finally{f.close();}
});
test('a directory replaced during discovery cannot publish a candidate',()=>{
 const f=fixture(),original=fs.lstatSync;let calls=0;
 try{
  f.write('claude');fs.lstatSync=(name,...args)=>{const stat=original(name,...args);if(name===f.root&&++calls>1)return {...stat,ino:stat.ino+1,isDirectory:()=>true};return stat;};
  assert.throws(()=>readUserScreenRules(f.root,builtin),/directory changed while reading/);
 }finally{fs.lstatSync=original;f.close();}
});
test('same-user ancestor ABA is outside the identity guarantee but never bypasses file privacy checks',()=>{
 for(const safe of [true,false]){
  const f=fixture(),active=path.join(f.root,'active'),replacement=path.join(f.root,'replacement'),parked=path.join(f.root,'parked'),directory=path.join(active,'screen-rules');
  const opendir=fs.opendirSync,lstat=fs.lstatSync;let swapped=false;
  const restore=()=>{if(swapped){fs.renameSync(active,replacement);fs.renameSync(parked,active);swapped=false;}};
  try{
   for(const parent of [active,replacement]){fs.mkdirSync(parent,{mode:0o700});fs.mkdirSync(path.join(parent,'screen-rules'),{mode:0o700});}
   fs.writeFileSync(path.join(directory,'claude.json'),bytes(envelope('claude',[rule('original')])),{mode:0o600});
   fs.writeFileSync(path.join(replacement,'screen-rules','claude.json'),bytes(envelope('claude',[rule('replacement')])),{mode:safe?0o600:0o644});
   fs.opendirSync=(name,...args)=>{if(name===directory&&!swapped){fs.renameSync(active,parked);fs.renameSync(replacement,active);swapped=true;}return opendir(name,...args);};
   fs.lstatSync=(name,...args)=>{const stat=lstat(name,...args);if(name===path.join(directory,'claude.json'))restore();return stat;};
   if(safe)assert.equal(readUserScreenRules(directory,builtin).sets.claude[0].id,'replacement','trusted same-user replacement has no extra rule authority');
   else assert.throws(()=>readUserScreenRules(directory,builtin),/private to your account/);
  }finally{restore();fs.opendirSync=opendir;fs.lstatSync=lstat;f.close();}
 }
});
