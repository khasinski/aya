// The process-group listing behind owner recovery and retirement: async form, fail-closed answers, and the leader
// identity bracket that keeps a reused group out of a recovery inventory.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import childProcess from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const owner=require('../dist-electron/pty-owner-client.js');
const realExecFile=childProcess.execFile,realExecFileSync=childProcess.execFileSync;

async function groupLeader(t){
 const child=spawn('/bin/sh',['-c','sleep 30 & sleep 30 & wait'],{detached:true,stdio:'ignore'});
 t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{/* gone */}});
 await new Promise(resolve=>setTimeout(resolve,150));
 return child.pid;
}
function fakeAsyncPs(t,answer){
 const calls=[];
 childProcess.execFile=(command,args,options,callback)=>{calls.push({command,args,options});setTimeout(()=>{const [error,stdout]=answer();callback(error,stdout,'');},5);return {pid:0};};
 t.after(()=>{childProcess.execFile=realExecFile;});
 return calls;
}

test('ownerGroupMemberPidsAsync lists what the sync form lists, without blocking the event loop',async t=>{
 const leader=await groupLeader(t);let ticks=0;const timer=setInterval(()=>ticks++,1);t.after(()=>clearInterval(timer));
 const members=await owner.ownerGroupMemberPidsAsync(leader);
 assert.deepEqual(members,owner.ownerGroupMemberPids(leader));assert.ok(members.includes(leader));assert.equal(members.length,3);
 assert.ok(ticks>0,"timers ran while ps listed the table");
});
test('a failed, empty, garbled, timed-out or overflowing table rejects; it is never an empty group',async t=>{
 const cases={
  error:()=>[Object.assign(Error('injected'),{code:'EAGAIN'}),''],
  empty:()=>[null,''],
  garbled:()=>[null,'PID PGID\nnot a table\n'],
  timeout:()=>[Object.assign(Error('timed out'),{killed:true,signal:'SIGTERM'}),'  12 12\n'],
  overflow:()=>[Object.assign(Error('stdout maxBuffer length exceeded'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}),'  12 12\n'],
 };
 for(const [name,answer] of Object.entries(cases)){
  const calls=fakeAsyncPs(t,answer);
  await assert.rejects(owner.ownerGroupMemberPidsAsync(12),undefined,name);
  assert.equal(calls[0].command,'/bin/ps');assert.deepEqual(calls[0].args,['-axo','pid=,pgid=']);assert.equal(calls[0].options.timeout,5000);assert.equal(calls[0].options.maxBuffer,4*1024*1024);
 }
 childProcess.execFileSync=()=>'';t.after(()=>{childProcess.execFileSync=realExecFileSync;});
 assert.throws(()=>owner.ownerGroupMemberPids(12),/process table could not be read/);
});
test('a real table with no member of the group is an empty group, not a failure',async t=>{
 fakeAsyncPs(t,()=>[null,'    1     1\n  500   500\n']);
 assert.deepEqual(await owner.ownerGroupMemberPidsAsync(4242),[]);
});

const bridge=(identities)=>({recoveryIdentity:pid=>{const value=identities[pid];if(value instanceof Error)throw value;return value??null;}});
test('the async snapshot brackets the listing with the leader identity, and a leader replaced while ps ran fails closed',async()=>{
 const identities={100:'1:1',101:'1:2',102:'1:3'};let ticks=0;const timer=setInterval(()=>ticks++,1);
 try{
  const list=async group=>{await new Promise(resolve=>setTimeout(resolve,10));return [group,101,102];};
  assert.deepEqual(await owner.snapshotOwnerRecoveryMembersAsync(100,'1:1',{bridge:bridge(identities),list}),
   [{pid:100,startIdentity:'1:1'},{pid:101,startIdentity:'1:2'},{pid:102,startIdentity:'1:3'}]);
  assert.ok(ticks>0,'timers ran while the listing was outstanding');
  const replaced=async group=>{identities[100]='9:9';return [group,101];};
  await assert.rejects(owner.snapshotOwnerRecoveryMembersAsync(100,'1:1',{bridge:bridge(identities),list:replaced}),/exited during recovery inventory/);
  identities[100]='1:1';
  const gone=async group=>{delete identities[100];return [group];};
  await assert.rejects(owner.snapshotOwnerRecoveryMembersAsync(100,'1:1',{bridge:bridge(identities),list:gone}),/exited during recovery inventory/);
 }finally{clearInterval(timer);}
});
test('the async snapshot refuses a changed leader up front, an unbounded or leaderless list, and a failed listing',async()=>{
 const identities={100:'1:1'};let listed=0;
 const list=pids=>async()=>{listed++;return pids;};
 await assert.rejects(owner.snapshotOwnerRecoveryMembersAsync(100,'0:0',{bridge:bridge(identities),list:list([100])}),/no longer matches/);
 assert.equal(listed,0,'no listing for a leader that already changed');
 await assert.rejects(owner.snapshotOwnerRecoveryMembersAsync(100,'1:1',{bridge:bridge(identities),list:list([101])}),/bounded recovery inventory/);
 await assert.rejects(owner.snapshotOwnerRecoveryMembersAsync(100,'1:1',{bridge:bridge(identities),list:list([100,...Array.from({length:32},(_,i)=>200+i)])}),/bounded recovery inventory/);
 await assert.rejects(owner.snapshotOwnerRecoveryMembersAsync(100,'1:1',{bridge:bridge(identities),list:async()=>{throw Error('ps failed');}}),/ps failed/);
 const members=await owner.snapshotOwnerRecoveryMembersAsync(100,'1:1',{bridge:bridge({100:'1:1',101:Object.assign(Error('unverifiable'))}),list:list([100,101])});
 assert.deepEqual(members,[{pid:100,startIdentity:'1:1'},{pid:101,startIdentity:null}],'an unverifiable member stays, without identity');
});
test('the async snapshot of a real group matches the sync snapshot',async t=>{
 const leader=await groupLeader(t),identity=owner.ownerProcessStartIdentity(leader);assert.ok(identity);
 assert.deepEqual(await owner.snapshotOwnerRecoveryMembersAsync(leader,identity),owner.snapshotOwnerRecoveryMembers(leader,identity));
});
