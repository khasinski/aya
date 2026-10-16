import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseScreenRules, loadScreenRulesFile, loadBundledScreenRules, MAX_RULE_FILE_BYTES, RULE_AGENTS } from '../dist-electron/screen-rule-data.js';
import { validateScreenPattern } from '../dist-electron/screen-rule-pattern.js';
const source = readFileSync(new URL('../electron/screen-rules/builtin.json', import.meta.url));
const baseline = JSON.parse(readFileSync(new URL('./fixtures/agent-screen-rules-baseline.json', import.meta.url)));
const bundle = () => JSON.parse(source);
const parse = object => parseScreenRules(Buffer.from(JSON.stringify(object)));
const rule = (pattern, flags = '') => ({id:'test',kind:'prompt',region:'tail',pattern,flags});

test('all built-in expressions pass the checker unchanged and match frozen main tables exactly', () => {
  const set = parseScreenRules(source);
  for (const agent of RULE_AGENTS) {
    const expected = agent === 'generic' ? baseline.generic : [...baseline.agents[agent], ...(baseline.busy[agent] ?? []), ...(baseline.usage[agent] ? [baseline.usage[agent]] : []), ...(baseline.account[agent] ? [baseline.account[agent]] : [])];
    assert.deepEqual(set.sets[agent].map(r=>({id:r.id,kind:r.kind,region:r.region,pattern:r.pattern.source,flags:r.pattern.flags})), expected, agent);
  }
  assert.equal(set.digest,createHash('sha256').update(source).digest('hex'));
  assert.ok(Object.isFrozen(set) && Object.isFrozen(set.sets) && Object.isFrozen(set.sets.claude));
  assert.equal(set.sets.claude[0].source,'builtin/generic');
});

test('the JSON-aware Electron build includes the validated bundled data', () => {
  const compiled = loadBundledScreenRules();
  assert.deepEqual(compiled.sets,parseScreenRules(source).sets);
});

test('raw byte/depth/duplicate/UTF8 budgets refuse before interpreting a bundle', () => {
  assert.throws(()=>parseScreenRules(Buffer.alloc(MAX_RULE_FILE_BYTES+1,32)),/file size/);
  assert.throws(()=>parseScreenRules(Buffer.from('{"schemaVersion":1,"schemaVersion":1}')),/duplicate key/);
  assert.throws(()=>parseScreenRules(Buffer.from('{"id":1,"\\u0069d":2}')),/duplicate key/);
  assert.throws(()=>parseScreenRules(Buffer.from('['.repeat(9)+'0'+']'.repeat(9))),/depth/);
  assert.throws(()=>parseScreenRules(Buffer.from([0xff])),/encoded data/);
  assert.throws(()=>parseScreenRules(Buffer.from('{')),/JSON/);
});

for (const [name,change] of [
  ['extra root',b=>b.extra=1],['schema',b=>b.schemaVersion=2],['version',b=>b.ruleSetVersion='x\x1b'],
  ['extra agent',b=>b.sets.hermes=b.sets.generic],['missing agent',b=>delete b.sets.codex],
  ['inheritance',b=>b.sets.claude.extends='codex'],['cycle',b=>b.sets.generic.extends='generic'],
  ['extra field',b=>b.sets.generic.rules[0].code='alert(1)'],
  ['kind',b=>b.sets.generic.rules[0].kind='execute'],['region',b=>b.sets.generic.rules[0].region='file'],
  ['id control',b=>b.sets.generic.rules[0].id='x\n'],['id length',b=>b.sets.generic.rules[0].id='x'.repeat(81)],
  ['duplicate id',b=>b.sets.generic.rules.push(b.sets.generic.rules[0])],
  ['non-string',b=>b.sets.generic.rules[0].pattern=12],['long pattern',b=>b.sets.generic.rules[0].pattern='x'.repeat(2049)],
  ['stateful flags',b=>b.sets.generic.rules[0].flags='g'],['duplicate flags',b=>b.sets.generic.rules[0].flags='ii'],
  ['rule count',b=>b.sets.generic.rules=Array.from({length:129},(_,i)=>({...rule('x'),id:'r'+i}))],
  ['expanded count',b=>{b.sets.generic.rules=Array.from({length:128},(_,i)=>({...rule('x'),id:'r'+i}));}],
]) test(`closed bundle rejects ${name}`,()=>{const b=bundle();change(b);assert.throws(()=>parse(b));});

for(const pattern of ['(?=a*a*X)','(?=(a+)(a+)X)','(?=(a+)+$)','(?=(a|aa)+$)','(a+)+$','(a+){1,100}','(a*)*','(a|aa)+$','(a|\\w)+$','(a?)+$','(a{1,100}){1,100}','(a)\\1','(?<=a)b'])
  test(`static checker rejects ${pattern}`,()=>assert.throws(()=>validateScreenPattern(pattern,'')));
for(const pattern of ['(?:a|b)+','\\(a\\+\\)\\+','[()+*]+','(?:\\n[^\\n]*){0,3}$','a{1,12}','(?:a+)?'])
  test(`static checker permits ${pattern}`,()=>assert.doesNotThrow(()=>validateScreenPattern(pattern,'')));

test('invalid later rule prevents every RegExp construction',()=>{
  const b=bundle();b.sets.antigravity.rules.at(-1).region='bad';
  const Original=globalThis.RegExp;let calls=0;
  globalThis.RegExp=new Proxy(Original,{construct(target,args){calls++;return Reflect.construct(target,args);}});
  try{assert.throws(()=>parse(b));assert.equal(calls,0);}finally{globalThis.RegExp=Original;}
});

test('composer lookaheads and synthetic near misses stay bounded at maximum region dimensions', async t=>{
  const {execFileSync}=await import('node:child_process');
  const file=new URL('./helpers/screen-rule-adversarial.cjs',import.meta.url);
  const {fileURLToPath}=await import('node:url');
  const result=JSON.parse(execFileSync(process.execPath,[fileURLToPath(file)],{encoding:'utf8',timeout:20000,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}}));
  assert.equal(result.results.length,32);
  assert.ok(result.results.every(r=>r.ms<=2000));
  assert.ok(result.results.some(r=>r.rows===1000&&r.cols===1000));
  t.diagnostic('Maximum-region adversarial worst: '+JSON.stringify(result.worst));
  for(const id of ['composer-drawn','codex-composer-drawn']) t.diagnostic(id+' worst: '+JSON.stringify(result.results.filter(r=>r.rule===id).reduce((a,b)=>a.ms>b.ms?a:b)));
});


for (const [pattern, flags] of [
  ['^(a|aa){1,100}b$', ''], ['^(?:[^A]+a){1,100}X$', ''],
  ['^(?:\\w+ſ){1,100}X$', 'iu'], ['^(s|ſ)+$', 'iu'], ['(a|A)+$', 'i'], ['(?=\\w*A*X)', ''],
]) test(`reviewed ambiguous/case-folded pattern refused: ${pattern}/${flags}`,()=>assert.throws(()=>validateScreenPattern(pattern,flags)));


function authoredCount(n) {
  const b=bundle();let remaining=n;
  for(const [index,agent] of RULE_AGENTS.entries()) {
    const count=index===0?1:Math.min(60,remaining);
    b.sets[agent].rules=Array.from({length:count},(_,i)=>({...rule('x'),id:agent+'-'+i}));remaining-=count;
  }
  assert.equal(remaining,0);return b;
}
test('256 authored rules are accepted, 257 within all per-set limits hit the aggregate count',()=>{
  assert.equal(Object.values(parse(authoredCount(256)).sets).reduce((n,r)=>n+r.length,0),261);
  assert.throws(()=>parse(authoredCount(257)),/rule id\/count/);
});
test('file stat cap rejects before read/allocation and a growing file reads at most 64KiB+1',()=>{
  let closed=0,reads=0,bytes=0;
  const io={openSync:()=>123,closeSync:()=>closed++,fstatSync:()=>({isFile:()=>true,size:MAX_RULE_FILE_BYTES+1}),readSync(){reads++;throw Error('must not read');}};
  assert.throws(()=>loadScreenRulesFile('fake',io),/file type\/size/);assert.equal(reads,0);assert.equal(closed,1);
  io.fstatSync=()=>({isFile:()=>true,size:0});
  io.readSync=(_fd,buffer,offset,length)=>{reads++;assert.equal(buffer.length,MAX_RULE_FILE_BYTES+1);buffer.fill(32,offset,offset+length);bytes+=length;return length;};
  assert.throws(()=>loadScreenRulesFile('fake-growing',io),/file size/);
  assert.equal(bytes,MAX_RULE_FILE_BYTES+1);assert.equal(reads,1);assert.equal(closed,2);
});
