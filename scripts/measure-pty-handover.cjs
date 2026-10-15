// Offline B3 transport/owner measurement. One dense browser-state fixture is
// captured25 times; it is not25 simultaneous DOM terminals. Actual PTYs/hosts
// and the normal private escrow/coordinator paths are used throughout.
const fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process'),{randomBytes}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const repo=path.resolve(__dirname,'..');process.chdir(repo);
fs.mkdirSync('test-results',{recursive:true});
const root=fs.mkdtempSync(path.resolve('test-results/handover-measure-'));
process.env.HOME=path.join(root,'home');process.env.AYA_HOME=path.join(root,'aya');
fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true});
const {PtyHostClient}=require('../dist-electron/pty-host-client');
const {ownerProcessStartIdentity}=require('../dist-electron/pty-owner-client');
const {HandoverDisplays}=require('../dist-electron/pty-handover-display');
const {createRendererVt,captureRendererVt}=require('../dist-test/terminal-vt-checkpoint');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(f){const end=Date.now()+15000;while(!await f()){if(Date.now()>end)throw Error('Handover measurement readiness timeout');await sleep(2);}}
const quote=s=>"'"+s.replace(/'/g,"'\"'\"'")+"'";
const oldEntry=path.resolve(`dist-electron/pty-host-measure-old-${process.pid}.js`),newEntry=path.resolve(`dist-electron/pty-host-measure-new-${process.pid}.js`);
const source=fs.readFileSync('dist-electron/pty-host.js','utf8');
const trace=`process.once('exit',()=>{try{require('node:fs').writeFileSync(require('node:path').join(process.env.AYA_HOME,'rss-'+process.pid+'.json'),JSON.stringify(process.resourceUsage()))}catch{}});\n`;
fs.writeFileSync(oldEntry,trace+'// old measurement entry\n'+source);fs.writeFileSync(newEntry,trace+'// new measurement entry\n'+source);
const old=new PtyHostClient(oldEntry),next=new PtyHostClient(newEntry);
const oldOutput=new Map(),newOutput=new Map(),fenced=new Set(),requests=[];
old.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>{if(e.type==='data')oldOutput.set(e.ptyId,(oldOutput.get(e.ptyId)||'')+e.chunk);}});
next.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>{if(e.type==='data'){if(e.replayToken===`measure-${e.ptyId}`)fenced.add(e.ptyId);if(fenced.has(e.ptyId))newOutput.set(e.ptyId,(newOutput.get(e.ptyId)||'')+e.chunk);}}});
const samples=[],peaks={main:process.memoryUsage().rss,old:0,new:0,owner:0};let oldPid,newPid,ownerPid,overlap=false,oldGoneBeforeSpawn=false;
let sampling=false;
function sample(){
 peaks.main=Math.max(peaks.main,process.memoryUsage().rss);
 const ids=[oldPid,newPid,ownerPid].filter(Boolean);if(!ids.length||sampling)return;
 sampling=true;
 execFile('/bin/ps',['-o','pid=,rss=','-p',ids.join(',')],{encoding:'utf8'},(_error,stdout)=>{
  sampling=false;if(!stdout.trim())return;
  const rows=stdout.trim().split('\n').map(s=>s.trim().split(/\s+/).map(Number)),rss=new Map(rows);
  for(const [key,pid]of [['old',oldPid],['new',newPid],['owner',ownerPid]])peaks[key]=Math.max(peaks[key],(rss.get(pid)||0)*1024);
  peaks.combined=Math.max(peaks.combined||0,process.memoryUsage().rss+rows.reduce((n,r)=>n+r[1]*1024,0));
  if(oldPid&&newPid&&rss.has(oldPid)&&rss.has(newPid))overlap=true;
  samples.push({ms:performance.now(),...Object.fromEntries(rows)});
 });
}
let timer,term;
(async()=>{
 const agent=path.join(process.env.HOME,'agent.cjs');
 fs.writeFileSync(agent,`process.stdin.setRawMode(true);let row='';for(let y=0;y<80;y++)row+='\\x1b[38;2;'+(y*3%256)+';80;160m'+('row'+y+' '+'.'.repeat(240)).slice(0,240)+'\\x1b[0m\\r\\n';process.stdout.write(row+'READY:'+process.pid+'\\r\\n');let n=0,carry='';setInterval(()=>process.stdout.write('TICK:'+process.pid+':'+(++n)+'\\r\\n'),20);process.stdin.on('data',b=>{carry+=b;for(;;){const at=carry.indexOf('\\n');if(at<0)break;const line=carry.slice(0,at);carry=carry.slice(at+1);process.stdout.write('ECHO:'+process.pid+':'+line+'\\r\\n');}});`);
 for(let i=0;i<25;i++){
  const req={ptyId:`measure-${i}`,agent:'custom',command:`exec env ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(agent)}`,cwd:process.env.HOME,cols:240,rows:80};requests.push(req);
  await old.spawn(req);await wait(()=>oldOutput.get(req.ptyId)?.includes('READY:'));
 }
 const before=await old.hostStatus();oldPid=before.pid;ownerPid=before.owner.pid;
 const pids=await Promise.all(requests.map(r=>old.getPid(r.ptyId)));sample();
 async function latency(client,output,label){const times=[];for(let i=0;i<25;i++){
  const id=requests[i].ptyId,marker=`ECHO:${pids[i]}:${label}-${i}`,start=performance.now();
  await client.write(id,`${label}-${i}\n`);await wait(()=>output.get(id)?.includes(marker));times.push(performance.now()-start);
 }return times;}
 const beforeLatency=await latency(old,oldOutput,'before');
 timer=setInterval(sample,40);term=createRendererVt({cols:240,rows:80,scrollback:10000,allowProposedApi:true,scrollOnEraseInDisplay:true});
 let row='';for(let x=0;x<240;x++)row+=`\x1b[38;2;${x};${x*17%256};${x*37%256}m\x1b[48;2;${x*7%256};${x*11%256};${x*23%256}m${String.fromCharCode(33+x%90)}`;
 await new Promise(r=>term.write(row,r));const b=term._core._bufferService.buffers.normal,template=b.lines.get(0);
 b.lines.maxLength=10080;b.lines.length=0;for(let n=0;n<10080;n++)b.lines.push(template.clone());b.ybase=10000;b.ydisp=9950;b.y=79;b.x=0;
 const handlers=new Map(),listeners=new Map(),captureTimes=[],cuts=[];
 const win={id:1,isDestroyed:()=>false,send:(_name,req)=>{
  const start=performance.now();captureRendererVt(term,req.maxBytes,250).then(dto=>{captureTimes.push(performance.now()-start);cuts.push(dto.cutLines);listeners.get('pty-checkpoint:captured')({sender:{id:1}},req.requestId,JSON.stringify(dto));},()=>listeners.get('pty-checkpoint:captured')({sender:{id:1}},req.requestId,null));
 }};
 const displays=new HandoverDisplays(async()=>win,()=>{});displays.register({handle:(k,f)=>handlers.set(k,f),on:(k,f)=>listeners.set(k,f)});
 const start=performance.now(),state=await old.preparePlannedHandover(Date.now()+120000),freezeMs=performance.now()-start;
 if(state.eligible.length!==25||state.ineligible.length)throw Error('Not all25 processes eligible');
 const captureStart=performance.now(),display=await displays.capture(state),captureMs=performance.now()-captureStart;
 const ticket=await old.announcePlannedHandover(state,display,[],randomBytes(32).toString('hex'));old.hostAsked=true;
 const startHost=next.startHost.bind(next);next.startHost=(...args)=>{
  if(ownerProcessStartIdentity(oldPid)!==null)throw Error('Old JS host still lives at successor spawn');
  oldGoneBeforeSpawn=true;return startHost(...args);
 };
 const switchStart=performance.now(),restored=await next.adoptPlannedHandover(ticket,next.expectedHostIdentity('measurement'),s=>displays.inspect(s)),switchMs=performance.now()-switchStart;
 const status=await next.hostStatus();newPid=status.pid;sample();
 if(status.owner.pid!==ownerPid||newPid===oldPid)throw Error('Host/owner identity boundary failed');
 for(let i=0;i<25;i++)if(await next.getPid(requests[i].ptyId)!==pids[i])throw Error('Child PID changed');
 const pauseMs=performance.now()-start;
 for(const pane of restored.eligible){await next.spawn({...requests.find(r=>r.ptyId===pane.id),attachIfReused:true,replayAfter:{generation:pane.generation,offset:pane.outputEnd,token:`measure-${pane.id}`}});await next.acknowledgeHandoverDisplay(pane.id,pane.generation,`measure-${pane.id}`);}
 await displays.acknowledgeEscrow(display);
 clearInterval(timer);timer=null;
 const afterLatency=await latency(next,newOutput,'after');
 for(let i=0;i<25;i++){
  const text=(oldOutput.get(requests[i].ptyId)||'')+(newOutput.get(requests[i].ptyId)||''),ticks=[...text.matchAll(new RegExp(`TICK:${pids[i]}:(\\d+)`,'g'))].map(m=>+m[1]);
  if(ticks.length<2||ticks.some((n,j)=>n!==j+1))throw Error(`Output sequence lost/repeated for${i}: ${ticks}`);
 }
 sample();await next.shutdown();await wait(()=>fs.existsSync(path.join(process.env.AYA_HOME,`rss-${newPid}.json`)));clearInterval(timer);timer=null;
 const percentile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.min(a.length-1,Math.floor(a.length*p))];
 const result={platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron??null,panes:25,ownerPid,oldPid,newPid,allChildPidsRetained:true,orderedTicksWithoutGapsOrDuplicates:true,oldHostGoneBeforeSuccessorSpawn:oldGoneBeforeSpawn,sampledHostOverlap:overlap,memorySamples:samples.length,mainKernelMaxRssKiB:process.resourceUsage().maxRSS,freezeMs,captureMs,switchMs,pausedToSuccessorReadyMs:pauseMs,displayCaptures:cuts.length,historyLinesCutPerCapture:cuts,coreRawBytes:restored.coreRawBytes,coreEncodedBytes:restored.coreEncodedBytes,displayRawBytes:restored.displayRawBytes,displayEncodedBytes:restored.displayEncodedBytes,inputOutputRoundTripMs:{before:{p50:percentile(beforeLatency,.5),p95:percentile(beforeLatency,.95)},after:{p50:percentile(afterLatency,.5),p95:percentile(afterLatency,.95)}},peakSampledRssBytes:peaks,oldHostKernelMaxRssKiB:JSON.parse(fs.readFileSync(path.join(process.env.AYA_HOME,`rss-${oldPid}.json`))).maxRSS,newHostKernelMaxRssKiB:JSON.parse(fs.readFileSync(path.join(process.env.AYA_HOME,`rss-${newPid}.json`))).maxRSS,scope:'25 live owner PTYs; one synthetic dense10k-line browser fixture captured25times, no DOM; instrumented old/new JS entries;40ms asynchronous ps+main RSS samples plus per-host kernel high-water RSS; one trial; offline'};
 fs.writeFileSync(path.resolve('b3-handover-measurement.local.log'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
 clearInterval(timer);term?.dispose();if(next.isConnected())await next.shutdown().catch(()=>{});if(old.isConnected())await old.shutdown().catch(()=>{});old.dispose();next.dispose();old.dropSocket();next.dropSocket();
 const {cleanupNativeOwner}=await import('../tests/helpers/pty-host.mjs');await cleanupNativeOwner(process.env.AYA_HOME);
 fs.rmSync(oldEntry,{force:true});fs.rmSync(newEntry,{force:true});fs.rmSync(root,{recursive:true,force:true});
});
