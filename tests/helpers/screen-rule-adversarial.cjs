// A separate process bounds synchronous RegExp execution even under a mutation.
const {performance}=require('node:perf_hooks');
const {loadBundledScreenRules}=require('../../dist-electron/screen-rule-data');
const {lintScreenPattern}=require('./screen-rule-lint.cjs');
const set=loadBundledScreenRules();
const rules=['claude','codex'].map(agent=>set.sets[agent].find(r=>r.id===(agent==='claude'?'composer-drawn':'codex-composer-drawn')));
for(const source of [String.raw`(?:\n[^\n]*){0,3}X$`,String.raw`^(?![^\n]*\?\s*$)[^\n]*X$`]){
 lintScreenPattern(source,'m');rules.push({id:'synthetic-'+rules.length,pattern:new RegExp(source,'m')});
}
const results=[];
for(const count of [12,1000]){
 const pad=' '.repeat(999)+'x';
 const cases={spacesNearMiss:Array(count).fill(pad).join('\n'),ruledNearMiss:Array(count).fill('─'.repeat(998)+'?x').join('\n'),codexNearMiss:'› question\n'+Array(count-1).fill(' '.repeat(998)+'?x').join('\n'),claudeNearMiss:'─'.repeat(1000)+'\n'+Array(count-1).fill(' '.repeat(998)+'?x').join('\n')};
 for(const [name,text]of Object.entries(cases))for(const r of rules){
  const start=performance.now();const matched=r.pattern.test(text),ms=performance.now()-start;
  if(ms>2000)throw Error('Adversarial match exceeded 2000ms: '+r.id+'/'+name+'/'+count+' rows: '+ms);
  results.push({rule:r.id,name,rows:count,cols:1000,bytes:Buffer.byteLength(text),matched,ms});
 }
}
console.log(JSON.stringify({worst:results.reduce((a,b)=>a.ms>b.ms?a:b),results}));
