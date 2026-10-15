import test from 'node:test';
import assert from 'node:assert/strict';
const {PtyCrashRecovery,CRASH_RECOVERY_POLICY}=await import('../dist-electron/pty-crash-recovery.js');
const policy={delays:[1,2,3],attemptTimeoutMs:30,stableMs:100};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('one recovery flight shares its result and bounded retries follow confirmed cleanup only',async()=>{
 let calls=0;const states=[];
 const recovery=new PtyCrashRecovery({policy,attempt:async()=>{await sleep(2);return ++calls===2?'recovered':'retry';},state:s=>states.push(s)});
 const first=recovery.recover();assert.equal(recovery.recover(),first);
 assert.equal(await first,true);assert.equal(calls,2);assert.deepEqual(states,['recovering','recovered']);
 recovery.dispose();
});
test('successful short-lived hosts consume the same restart budget',async()=>{
 let calls=0;const states=[];
 const recovery=new PtyCrashRecovery({policy,attempt:async()=>{calls++;return 'recovered';},state:s=>states.push(s)});
 for(let i=0;i<3;i++)assert.equal(await recovery.recover(),true);
 assert.equal(await recovery.recover(),false);assert.equal(await recovery.recover(),false);
 assert.equal(calls,3);assert.equal(states.at(-1),'exhausted');recovery.dispose();
});
test('only a stable host interval resets the retry budget',async()=>{
 let now=0,calls=0;const recovery=new PtyCrashRecovery({policy,now:()=>now,attempt:async()=>{calls++;return 'recovered';},state:()=>{}});
 assert.equal(await recovery.recover(),true);now=100;
 for(let i=0;i<3;i++)assert.equal(await recovery.recover(),true);
 assert.equal(await recovery.recover(),false);assert.equal(calls,4);recovery.dispose();
});
test('uncertain or timed-out cleanup exhausts without starting another host',async()=>{
 for(const kind of ['blocked','throw','timeout']){
  let calls=0,aborted=false;const states=[];
  const recovery=new PtyCrashRecovery({policy,attempt:async signal=>{calls++;signal.addEventListener('abort',()=>{aborted=true;});if(kind==='throw')throw Error('cannot prove exit');if(kind==='timeout')return new Promise(()=>{});return 'blocked';},state:s=>states.push(s)});
  assert.equal(await recovery.recover(),false);assert.equal(await recovery.recover(),false);assert.equal(calls,1);assert.equal(states.at(-1),'exhausted');
  if(kind==='timeout')assert.equal(aborted,true);recovery.dispose();
 }
});
test('app quit cancels backoff and an in-progress attempt without a replacement loop',async()=>{
 let calls=0;const states=[];
 const waiting=new PtyCrashRecovery({policy:{...policy,delays:[100]},attempt:async()=>{calls++;return 'recovered';},state:s=>states.push(s)});
 const pending=waiting.recover();waiting.dispose();assert.equal(await pending,false);assert.equal(calls,0);assert.ok(!states.includes('exhausted'));
 let started;const began=new Promise(resolve=>{started=resolve;});let signal;
 const running=new PtyCrashRecovery({policy,attempt:async s=>{signal=s;started();return new Promise(()=>{});},state:s=>states.push(s)});
 const active=running.recover();await began;running.dispose();assert.equal(await active,false);assert.equal(signal.aborted,true);assert.equal(await running.recover(),false);
});


test('timeout wins over attempts resolving retry or recovered from their abort listener',async()=>{
 for(const outcome of ['retry','recovered']){
  let calls=0;const states=[];
  const recovery=new PtyCrashRecovery({policy,attempt:signal=>{calls++;return new Promise(resolve=>signal.addEventListener('abort',()=>resolve(outcome),{once:true}));},state:s=>states.push(s)});
  assert.equal(await recovery.recover(),false);assert.equal(calls,1);assert.equal(await recovery.recover(),false);
  assert.deepEqual(states,['recovering','exhausted']);recovery.dispose();
 }
});
test('synchronous disposal inside attempt settles without waiting for its deadline',async()=>{
 let recovery;const states=[];
 recovery=new PtyCrashRecovery({policy:{...policy,attemptTimeoutMs:1000},attempt:()=>{recovery.dispose();return new Promise(()=>{});},state:s=>states.push(s)});
 const timeout=Symbol('timeout');let timer;
 try{const result=await Promise.race([recovery.recover(),new Promise(resolve=>{timer=setTimeout(()=>resolve(timeout),100);})]);assert.equal(result,false);}
 finally{clearTimeout(timer);recovery.dispose();}
 assert.deepEqual(states,['recovering']);
});
test('default recovery budget and stable interval are pinned',()=>{
 assert.deepEqual(CRASH_RECOVERY_POLICY,{delays:[100,500,1500],attemptTimeoutMs:10000,stableMs:120000});
});
