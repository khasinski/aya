const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { OwnerPty } = require('../../dist-electron/pty-owner-adapter.js');
const { shutdownOwnerRuntime } = require('../../dist-electron/pty-owner-runtime.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async predicate => { const end = Date.now()+8000; while (!predicate()) { if (Date.now()>end) throw Error('large input timed out'); await sleep(5); } };
(async()=> {
 const home=process.env.AYA_HOME, bytes=Buffer.alloc(1024*1024);
 for(let i=0;i<bytes.length;i++) bytes[i]=65+i%26;
 const reader=path.join(home,'reader.cjs');
 fs.writeFileSync(reader,`const crypto=require('node:crypto'); let data=[]; let size=0; process.stdin.on('data',b=>{data.push(b); size+=b.length; if(size===1048576) { console.log('HASH:'+crypto.createHash('sha256').update(Buffer.concat(data)).digest('hex')); process.exit(23); }});`);
 const spec=(id,command,argv)=>({id,command,argv,cwd:home,cols:80,rows:24,env:{HOME:home,PATH:'/usr/bin:/bin',ELECTRON_RUN_AS_NODE:'1'}});
 let a,b;
 try {
  a=await OwnerPty.spawn(spec('blocked','/bin/sh',['sh','-c',`stty raw -echo; sleep 100 & sleeper=$!; echo SLEEP:$sleeper; wait $sleeper; exec '${process.execPath}' '${reader}'`]));
  let output=''; a.onData(s=>output+=s); await waitFor(()=>/SLEEP:(\d+)/.test(output));
  const sleeper=Number(/SLEEP:(\d+)/.exec(output)[1]);
  let done=false; const writing=a.writeAsync(bytes).then(()=>done=true);
  await sleep(100); assert.equal(done,false,'the unread PTY must exert backpressure');
  b=await OwnerPty.spawn(spec('responsive','/bin/sh',['sh','-c','read line; echo ANSWER:$line; exit 0']));
  let reply=''; b.onData(s=>reply+=s); await b.writeAsync('still-responsive\n');
  await waitFor(()=>reply.includes('ANSWER:still-responsive')); await b.closed;
  assert.equal(done,false,'the other pane must answer before blocked input finishes');
  process.kill(sleeper,'SIGTERM'); await writing;
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  await waitFor(()=>output.includes('HASH:'+hash)); await a.closed;
  console.log('large input ordered; second pane responsive');
 } finally { a?.kill('SIGKILL'); b?.kill('SIGKILL'); await shutdownOwnerRuntime(); }
})().catch(e=>{ console.error(e); process.exitCode=1; });
