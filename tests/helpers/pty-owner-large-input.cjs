const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawnPty, writePty, resizePty, killPty, getPtyPid } = require('../../dist-electron/pty-core.js');
const { getOwnerRuntime, shutdownOwnerRuntime } = require('../../dist-electron/pty-owner-runtime.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async predicate => { const end = Date.now()+8000; while (!predicate()) { if (Date.now()>end) throw Error('large input timed out'); await sleep(5); } };
(async()=> {
 const home=process.env.AYA_HOME, bytes=Buffer.alloc(1024*1024), marker='\nAYA_INPUT_END\n';
 for(let i=0;i<bytes.length;i++) bytes[i]=65+i%26;
 const reader=path.join(home,'reader.cjs');
 fs.writeFileSync(reader,`const crypto=require('node:crypto');let data=[],timer;process.stdin.on('data',b=>{data.push(b);clearTimeout(timer);const all=Buffer.concat(data),at=all.indexOf(${JSON.stringify(marker)});if(at>=0)timer=setTimeout(()=>{const final=Buffer.concat(data);console.log('RESULT:'+JSON.stringify({count:at,trailing:final.length-at-${Buffer.byteLength(marker)},hash:crypto.createHash('sha256').update(final.subarray(0,at)).digest('hex')}));process.exit(23);},200);});`);
 const outputs=new Map(), exits=new Set();
 const sink={isDestroyed:()=>false,sendPtyEvent:e=>{if(e.type==='data')outputs.set(e.ptyId,(outputs.get(e.ptyId)||'')+e.chunk);if(e.type==='exit')exits.add(e.ptyId);}};
 const create=async(id,script)=>spawnPty({ptyId:id,command:script,cwd:home,cols:80,rows:24},sink,{prepare:async()=>({argv:['/bin/sh','-c',script],env:{HOME:home,PATH:'/usr/bin:/bin',ELECTRON_RUN_AS_NODE:'1'},command:script,launch:{command:script,cwd:home},ownSessionId:null,spawnedAt:Date.now()})});
 try {
  await create('blocked',`stty raw -echo; sleep 100 & sleeper=$!; echo SLEEP:$sleeper; wait $sleeper; exec '${process.execPath}' '${reader}'`);
  await waitFor(()=>/SLEEP:(\d+)/.test(outputs.get('blocked')||''));
  const sleeper=Number(/SLEEP:(\d+)/.exec(outputs.get('blocked'))[1]);
  const owner=await getOwnerRuntime();assert.equal(owner.record.panes.find(p=>p.id==='blocked').pid,getPtyPid('blocked'),'real core uses the native owner');
  let done=false;const writing=writePty('blocked',bytes.toString()).then(delivered=>{assert.equal(delivered,true);done=true;});
  await sleep(100);assert.equal(done,false,'the unread PTY must exert backpressure');
  resizePty('blocked',101,39);
  // LIST is independent of blocked PTY input. It reflects the owner's applied ioctl.
  const end=Date.now()+3000;while(!(await owner.client.list()).some(p=>p.id==='blocked'&&p.cols===101&&p.rows===39)){if(Date.now()>end)throw Error('resize waited behind blocked input');await sleep(5);}
  assert.equal(done,false,'resize must complete before input drains');
  await create('responsive','read line; echo ANSWER:$line; exit 0');await writePty('responsive','still-responsive\n');
  await waitFor(()=>(outputs.get('responsive')||'').includes('ANSWER:still-responsive'));await waitFor(()=>exits.has('responsive'));
  assert.equal(done,false,'the other pane must answer before blocked input finishes');
  process.kill(sleeper,'SIGTERM');await writing;await writePty('blocked',marker);
  await waitFor(()=>(outputs.get('blocked')||'').includes('RESULT:'));await waitFor(()=>exits.has('blocked'));
  const result=JSON.parse(/RESULT:(\{[^\r\n]+\})/.exec(outputs.get('blocked'))[1]);
  assert.deepEqual(result,{count:bytes.length,trailing:0,hash:crypto.createHash('sha256').update(bytes).digest('hex')});
  console.log('core input ordered with exact count/no trailing bytes; resize and second pane responsive');
 } finally { await killPty('blocked');await killPty('responsive');await shutdownOwnerRuntime(); }
})().catch(e=>{ console.error(e); process.exitCode=1; });
