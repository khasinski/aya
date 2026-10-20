// A surviving main client caches edges, but a new/reloaded renderer needs the current dialog again on replay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PtyHostClient } from "../dist-electron/pty-host-client.js";
import { openVtPane, writeVtPane, closeVtPane, vtSnapshot, markComposerSeenChecked } from "../dist-electron/vt-mirror.js";
import { snapshotStatus } from "../dist-electron/vt-state.js";
import { HOLD_ACCOUNT_SETTING } from "../dist-electron/pane-holds.js";
const sink = () => {
  const events = [];
  return { events, isDestroyed: () => false, send: (_channel, event) => events.push(event) };
};
test("a live quiet snapshot before replay does not invent a non-waiting edge for a new sink", async () => {
  const id = "quiet-replay";
  openVtPane(id, 80, 24, () => {});
  writeVtPane(id, "all done");
  const snapshot = await vtSnapshot(id); closeVtPane(id);
  const client = new PtyHostClient("/nonexistent/pty-host.js"), renderer = sink();
  client.attachWebContents(renderer);
  for (const replay of [false, true]) client.onData(JSON.stringify({ type: "snapshot", ptyId: id, snapshot, replay }) + "\n");
  assert.deepEqual(renderer.events, []);
});
test("user-rule renderer status is revision-fenced and hydrated to a newly attached sink", async () => {
  const id="user-rule-status";openVtPane(id,80,24,()=>{},"claude");writeVtPane(id,"local prompt");
  const first=await vtSnapshot(id);writeVtPane(id,"\r\nmore");const second=await vtSnapshot(id);closeVtPane(id);
  const client=new PtyHostClient("/nonexistent/pty-host.js"),events=sink();client.attachWebContents(events);
  let resolveFirst;const firstStatus=new Promise(resolve=>{resolveFirst=resolve;});
  client.setUserRuleStatusObserver((_pane,snapshot)=>snapshot.revision===first.revision?firstStatus:Promise.resolve({generation:snapshot.generation,revision:snapshot.revision,waiting:true,dialog:"User-defined dialog"}));
  const receive=snapshot=>client.onData(JSON.stringify({type:"snapshot",ptyId:id,snapshot})+"\n");
  receive(first);await new Promise(resolve=>setTimeout(resolve,60));receive(second);await new Promise(resolve=>setTimeout(resolve,60));
  assert.deepEqual(events.events,[{type:"vt-status",ptyId:id,waiting:true,dialog:"User-defined dialog"}]);
  resolveFirst({generation:first.generation,revision:first.revision,waiting:false});await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(events.events.length,1,"a delayed result for an older applied revision is discarded");
  const reloaded=sink();client.attachWebContents(reloaded);await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(reloaded.events,[{type:"vt-status",ptyId:id,waiting:true,dialog:"User-defined dialog"}]);
});
test("applied output invalidates a pending status before its debounced snapshot arrives", async()=>{
 const id="user-rule-output-before-snapshot";openVtPane(id,80,24,()=>{},"claude");writeVtPane(id,"local approval");const waiting=await vtSnapshot(id);
 const client=new PtyHostClient("/nonexistent/pty-host.js"),events=sink();client.attachWebContents(events);let resolveClear,clearStarted;
 const started=new Promise(resolve=>clearStarted=resolve);
 client.setUserRuleStatusObserver(async(_pane,snapshot)=>{
  if(snapshot.revision===waiting.revision)return{generation:snapshot.generation,revision:snapshot.revision,waiting:true,dialog:"User account prompt"};
  if(!resolveClear)return new Promise(resolve=>{resolveClear=resolve;clearStarted();});
  return{generation:snapshot.generation,revision:snapshot.revision,waiting:true,dialog:"User account prompt"};
 });
 const receive=snapshot=>client.onData(JSON.stringify({type:"snapshot",ptyId:id,snapshot})+"\n");
 try{
  receive(waiting);await new Promise(resolve=>setTimeout(resolve,60));
  assert.deepEqual(events.events.filter(event=>event.type==="vt-status"),[{type:"vt-status",ptyId:id,waiting:true,dialog:"User account prompt"}]);
  writeVtPane(id,"\r\nready");const clearCandidate=await vtSnapshot(id);receive(clearCandidate);await started;
  writeVtPane(id,"\r\nDo you want to proceed?");const newerPrompt=await vtSnapshot(id);
  client.onData(JSON.stringify({type:"event",event:{type:"data",ptyId:id,chunk:"\r\nDo you want to proceed?"}})+"\n");
  resolveClear({generation:clearCandidate.generation,revision:clearCandidate.revision,waiting:false});await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(events.events.filter(event=>event.type==="vt-status"),[{type:"vt-status",ptyId:id,waiting:true,dialog:"User account prompt"}],"stale clear is dropped as soon as host-applied output arrives");
  receive(newerPrompt);await new Promise(resolve=>setTimeout(resolve,60));
  assert.deepEqual(events.events.filter(event=>event.type==="vt-status"),[{type:"vt-status",ptyId:id,waiting:true,dialog:"User account prompt"}]);
 }finally{client.dispose();closeVtPane(id);}
});
test("removing the user layer clears its waiting edge before builtin-only status resumes", async () => {
  const id="user-rule-status-clear";openVtPane(id,80,24,()=>{},"claude");writeVtPane(id,"local prompt");const snapshot=await vtSnapshot(id);closeVtPane(id);
  const client=new PtyHostClient("/nonexistent/pty-host.js"),events=sink();client.attachWebContents(events);
  client.setUserRuleStatusObserver(async(_pane,screen)=>({generation:screen.generation,revision:screen.revision,waiting:true}));
  client.onData(JSON.stringify({type:"snapshot",ptyId:id,snapshot})+"\n");await new Promise(resolve=>setTimeout(resolve,60));
  assert.deepEqual(events.events,[{type:"vt-status",ptyId:id,waiting:true}]);
  client.setUserRuleStatusObserver(null);
  assert.deepEqual(events.events,[{type:"vt-status",ptyId:id,waiting:true},{type:"vt-status",ptyId:id,waiting:false}]);
});
test("user-rule failure after a waiting result does not broadcast a false clear edge", async () => {
  const id="user-rule-status-unavailable";openVtPane(id,80,24,()=>{});writeVtPane(id,"ready");const first=await vtSnapshot(id);writeVtPane(id,"\nnext");const second=await vtSnapshot(id);closeVtPane(id);
  const client=new PtyHostClient("/nonexistent/pty-host.js"),events=sink();client.attachWebContents(events);let available=true;
  client.setUserRuleStatusObserver(async(_pane,snapshot)=>available?{generation:snapshot.generation,revision:snapshot.revision,waiting:true,sourceRevision:snapshot.revision,appliedSnapshot:snapshot}:null);
  const receive=snapshot=>client.onData(JSON.stringify({type:"snapshot",ptyId:id,snapshot})+"\n");
  receive(first);await new Promise(resolve=>setTimeout(resolve,60));assert.deepEqual(events.events,[{type:"vt-status",ptyId:id,waiting:true}]);
  available=false;receive(second);await new Promise(resolve=>setTimeout(resolve,60));
  assert.deepEqual(events.events,[{type:"vt-status",ptyId:id,waiting:true}],"the renderer keeps unresolved waiting state until fresh available evidence arrives");
});
test("a new sink can ACK the composer and publish its fresh revision to existing renderers", async () => {
  const id="user-rule-attach-composer-ack";openVtPane(id,80,24,()=>{},"claude");writeVtPane(id,"local prompt");const before=await vtSnapshot(id);
  const client=new PtyHostClient("/nonexistent/pty-host.js"),existing=sink(),reloaded=sink();client.attachWebContents(existing);let calls=0;
  client.setUserRuleStatusObserver(async(_pane,screen)=>{
    calls++;
    if(calls===1)return{generation:screen.generation,revision:screen.revision,waiting:true,dialog:"User-defined dialog",sourceRevision:screen.revision,appliedSnapshot:screen};
    assert.equal(markComposerSeenChecked(id,{generation:screen.generation,revision:screen.revision}),true);
    const fresh=await vtSnapshot(id);return{generation:fresh.generation,revision:fresh.revision,waiting:false,sourceRevision:screen.revision,appliedSnapshot:fresh};
  });
  try{
    client.onData(JSON.stringify({type:"snapshot",ptyId:id,snapshot:before})+"\n");await new Promise(resolve=>setTimeout(resolve,60));
    assert.deepEqual(existing.events,[{type:"vt-status",ptyId:id,waiting:true,dialog:"User-defined dialog"}]);
    client.attachWebContents(reloaded);await new Promise(resolve=>setTimeout(resolve,0));
    assert.deepEqual(existing.events,[{type:"vt-status",ptyId:id,waiting:true,dialog:"User-defined dialog"},{type:"vt-status",ptyId:id,waiting:false}]);
    assert.equal(client.latestRuleSnapshots.get(id).revision,(await vtSnapshot(id)).revision,"the attach observer's checked post-ACK revision becomes current");
  }finally{client.dispose();closeVtPane(id);}
});
test("removing the user layer never generation-ACKs cached composer evidence after newer output", async () => {
  const id="user-rule-removal-stale-composer";openVtPane(id,80,24,()=>{},"claude");writeVtPane(id,"❯ ");const cached=await vtSnapshot(id);
  assert.equal(cached.composerSeen,false);assert.equal(snapshotStatus(cached).composerSeen,true);
  const client=new PtyHostClient("/nonexistent/pty-host.js");let acknowledgements=0;client.markComposer=async()=>{acknowledgements++;};
  try{
    client.setUserRuleStatusObserver(async(_pane,snapshot)=>({generation:snapshot.generation,revision:snapshot.revision,waiting:false,sourceRevision:snapshot.revision,appliedSnapshot:snapshot}));
    client.onData(JSON.stringify({type:"snapshot",ptyId:id,snapshot:cached})+"\n");await new Promise(resolve=>setTimeout(resolve,60));
    const current=await vtSnapshot(id);writeVtPane(id,"\r\nnew same-generation output");
    assert.equal((await vtSnapshot(id)).generation,cached.generation);assert.notEqual((await vtSnapshot(id)).revision,current.revision);
    client.setUserRuleStatusObserver(null);
    await new Promise(resolve=>setTimeout(resolve,0));
    assert.equal(acknowledgements,0,"disabling the observer does not ACK its stale cached snapshot by generation alone");
    assert.equal((await vtSnapshot(id)).composerSeen,false,"new output retains the builtin startup hold");
  }finally{client.dispose();closeVtPane(id);}
});
for (const [name, text, dialog] of [
  ["approval", "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No", undefined],
  ["account setting", " Allow this read outside the working directories?\r\n ❯ 1. Yes, and keep allowing any reads outside the working directories\r\n   2. No, and block reads outside the working directories from now on\r\n   3. No, and ask again next time", HOLD_ACCOUNT_SETTING],
]) {
  test(`replay restores a quiet ${name} to a new sink on the same main client`, async () => {
    const id = name;
    openVtPane(id, 160, 24, () => {}, "claude");
    writeVtPane(id, text);
    const snapshot = await vtSnapshot(id);
    closeVtPane(id);
    const client = new PtyHostClient("/nonexistent/pty-host.js"), first = sink(), reloaded = sink();
    client.attachWebContents(first);
    const receive = (replay = false) => client.onData(JSON.stringify({
      type: "snapshot", ptyId: id, snapshot, ...(replay ? { replay: true } : {}),
    }) + "\n");
    receive();
    receive();
    assert.equal(first.events.length, 1, "live snapshots still deduplicate unchanged edges");
    client.detachWebContents(first);
    client.attachWebContents(reloaded);
    receive(true);
    assert.deepEqual(reloaded.events, [{ type: "vt-status", ptyId: id, waiting: true, ...(dialog ? { dialog } : {}) }]);
  });
}
