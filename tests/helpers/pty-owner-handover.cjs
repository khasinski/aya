// A real replaceable reader process; credentials arrive through FD3 only.
const fs=require('node:fs');
const {OwnerPty}=require('../../dist-electron/pty-owner-adapter.js');
const {getOwnerRuntime,shutdownOwnerRuntime}=require('../../dist-electron/pty-owner-runtime.js');
const {ownerArtifactPaths}=require('../../dist-electron/pty-owner-client.js');
const bridge=require(ownerArtifactPaths().bridge);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate){const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error('handover fixture readiness timeout');await sleep(2);}}
const mode=process.argv[2];
(async()=>{
 if(mode.startsWith('old')||mode==='abort'){
  const leave=mode==='old-exit'?'; while [ ! -f "$HOME/exit" ]; do sleep 0.01; done; exit 23':'';
  const script=`stty -echo; printf 'READY:%s\\n' "$$"; while IFS= read -r line; do case "$line" in utf8) printf '\\360\\237'; while [ ! -f "$HOME/release" ]; do sleep 0.01; done; printf '\\230\\200TAIL:%s\\n' "$$" ${leave} ;; size) stty size ;; quit) exit 23 ;; *) printf 'R:%s:%s\\n' "$$" "$line" ;; esac; done`;
  const p=await OwnerPty.spawn({id:'same',cols:80,rows:24,cwd:process.env.AYA_HOME,command:'/bin/sh',argv:['sh','-c',script],env:{PATH:'/usr/bin:/bin',LANG:'C',HOME:process.env.AYA_HOME,TERM:'xterm-256color'}});
  let output='';p.onData(s=>{output+=s;});await waitFor(()=>output.includes(`READY:${p.pid}`));
  await p.writeAsync('first\n');await waitFor(()=>output.includes(`R:${p.pid}:first`));
  await p.writeAsync('utf8\n');await waitFor(()=>p.decoder.lastNeed===2);
  if(mode==='old-exit'){fs.writeFileSync(process.env.AYA_HOME+'/release','go');await waitFor(()=>output.includes(`😀TAIL:${p.pid}`));}
  const checkpoint=await p.freezeForHandover();
  if(checkpoint.decoderCarry!==(mode==='old-exit'?'':'8J8='))throw Error('missing known UTF8 carry');
  const boundary=checkpoint.readBytes;
  if(mode!=='old-exit'){fs.writeFileSync(process.env.AYA_HOME+'/release','go');await waitFor(()=>bridge.readReady(p.pane.fd)>0);}
  if(p.readBytes!==boundary||(mode!=='old-exit'&&output.includes('TAIL:')))throw Error('old reader consumed bytes after its boundary');
  const owner=await getOwnerRuntime();
  if(mode==='abort'){
   p.resumeAfterHandoverAbort();await waitFor(()=>output.includes(`😀TAIL:${p.pid}`));
   const exit=new Promise(resolve=>p.onExit(resolve));await p.writeAsync('after\nquit\n');await exit;await p.closed;
   process.send({output,childPid:p.pid,ownerPid:owner.record.pid,aborted:true},async()=>{await shutdownOwnerRuntime();process.exit(0);});return;
  }
  process.send({checkpoint,output,ownerPid:owner.record.pid,childPid:p.pid,pending:true},async()=>{
   p.detachForHandover();await owner.detachForHandover();process.exit(0);
  });
 }else{
  const checkpoint=JSON.parse(fs.readFileSync(4,'utf8'));fs.closeSync(4);
  const p=await OwnerPty.attach(checkpoint);let output='';p.onData(s=>{output+=s;});
  const exited=new Promise(resolve=>p.onExit(resolve));
  if(mode!=='new-exit')await waitFor(()=>output.includes(`😀TAIL:${p.pid}`));
  if(mode!=='new-exit'){p.resize(101,39);await p.writeAsync('size\nafter\n');await waitFor(()=>output.includes(`R:${p.pid}:after`)&&output.includes('39 101'));await p.writeAsync('quit\n');}
  const exit=await exited;await p.closed;
  process.send({output,exit,childPid:p.pid,ownerPid:(await getOwnerRuntime()).record.pid},async()=>{await shutdownOwnerRuntime();process.exit(0);});
 }
})().catch(error=>{console.error(error);process.exit(1);});
