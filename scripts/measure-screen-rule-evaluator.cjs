// Offline main-policy comparison only: no app, PTY, renderer or network.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {performance}=require('node:perf_hooks'),{Terminal}=require('@xterm/headless');
process.chdir(path.resolve(__dirname,'..'));
const current=require('../dist-electron/vt-state'),baseline=require('../tests/helpers/vt-state-baseline.cjs');
const {snapshotOf}=require('../dist-electron/vt-mirror'),{loadBundledScreenRules}=require('../dist-electron/screen-rule-data');
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)];
const stats=values=>({samples:values.length,meanUs:values.reduce((a,b)=>a+b,0)/values.length,p50Us:percentile(values,.5),p95Us:percentile(values,.95),maxUs:Math.max(...values)});
const evaluate=(e,s)=>[e.snapshotBusy(s),e.snapshotHold(s),e.snapshotStatus(s)];
(async()=>{
 const loadStart=performance.now(),loaded=loadBundledScreenRules(),firstLoadMs=performance.now()-loadStart;
 const snapshots=[];
 for(const file of walk('tests/fixtures').filter(f=>f.endsWith('.raw'))){
  let meta;try{meta=JSON.parse(fs.readFileSync(file.replace(/\.raw$/,'.meta.json')));}catch{meta={cols:200,rows:60};}
  const term=new Terminal({cols:meta.cols,rows:meta.rows,scrollback:0,allowProposedApi:true});
  try{
   await new Promise(done=>term.write(fs.readFileSync(file),done));
   const kind=path.basename(file).split('-')[0],agent=kind==='agy'?'antigravity':['claude','codex','opencode','grok'].includes(kind)?kind:undefined;
   const s=snapshotOf({terminal:term,agent,shell:false,composerSeen:true,openedAt:0,lastOutputAt:0});
   assert.deepEqual(evaluate(current,s),evaluate(baseline,s),file);
   snapshots.push({file,s});
  }finally{term.dispose();}
 }
 for(let i=0;i<25;i++)for(const {s} of snapshots){evaluate(current,s);evaluate(baseline,s);}
 const old=[],next=[];
 for(let i=0;i<200;i++)for(const {s} of snapshots){
  const pair=i%2?[[current,next],[baseline,old]]:[[baseline,old],[current,next]];
  for(const [e,values]of pair){const start=performance.now();evaluate(e,s);values.push((performance.now()-start)*1000);}
 }
 const result={platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron??null,baseline:'main8890bea3 frozen evaluator and TS rules',ruleVersion:loaded.version,ruleDigest:loaded.digest,bundledBytes:fs.statSync('dist-electron/screen-rules/builtin.json').size,authoredBytes:fs.statSync('electron/screen-rules/builtin.json').size,firstLoadMs,recordedSessions:snapshots.length,fixtures:snapshots.map(({file,s})=>({file,agent:s.agent??'generic',rows:s.rows.length,cols:s.cols,regionCharacters:s.rows.join('\n').length})),baselinePolicy:stats(old),dataPolicy:stats(next),rawUs:{baseline:old,data:next},scope:'One local trial; final applied snapshots of all saved raw sessions; busy+hold+status triplet, steady-state composerSeen=true; 25 warmup rounds then200 interleaved rounds, alternating old/new order; monotonic measurement clock overhead included. First bounded file load measured separately. Main policy only: no app startup, socket latency, actual PTYs, DOM or paint; not a comparison of process recovery performance.'};
 fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/screen-rule-evaluator-measurement.json',JSON.stringify(result,null,2)+'\n');
 const {rawUs,...summary}=result;console.log(JSON.stringify(summary,null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
