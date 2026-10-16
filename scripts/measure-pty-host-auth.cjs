// Offline authenticated continuity/recovery: 25 actual PTYs, no renderer/DOM.
// Reconnection uses a second main client in this process; the separate real
// app relaunch is proved by GUI tests, not by this timing trial. The JS entry samples
// resourceUsage and native getrusage every200ms; ps samples RSS separately.
const fs=require('node:fs'),path=require('node:path'),{execFile,execFileSync}=require('node:child_process'),{performance}=require('node:perf_hooks');
process.chdir(path.resolve(__dirname,'..'));fs.mkdirSync('test-results',{recursive:true});
const root=fs.mkdtempSync(path.resolve('test-results/auth-measure-'));process.env.HOME=path.join(root,'home');process.env.AYA_HOME=path.join(root,'aya');
fs.mkdirSync(process.env.HOME,{recursive:true});fs.mkdirSync(process.env.AYA_HOME,{recursive:true});
const {PtyHostClient}=require('../dist-electron/pty-host-client'),{ownerProcessStartIdentity}=require('../dist-electron/pty-owner-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function wait(f){const end=Date.now()+20000;while(!await f()){if(Date.now()>end)throw Error('Measurement readiness timeout');await sleep(5);}}
const entry=path.resolve(`dist-electron/pty-host-auth-measure-${process.pid}.js`);
fs.writeFileSync(entry,`const fs=require('fs'),path=require('path');let sampling=false;setInterval(async()=>{if(sampling)return;sampling=true;try{const owner=require('./pty-owner-runtime').currentOwnerRuntime();if(!owner?.client)return;const stats=await owner.client.stats();const data={at:Date.now(),host:process.resourceUsage(),owner:{userUs:Number(stats.userUs),systemUs:Number(stats.systemUs)}};const file=path.join(process.env.AYA_HOME,'usage-'+process.pid+'.json');fs.writeFileSync(file+'.tmp',JSON.stringify(data));fs.renameSync(file+'.tmp',file);}catch{}finally{sampling=false;}},200).unref();require('./pty-host');\n`);
const nodeExecutable=process.env.AYA_MEASURE_NODE??(process.versions.electron?execFileSync('/usr/bin/which',['node'],{encoding:'utf8'}).trim():process.execPath);
const agent=path.join(process.env.HOME,'agent.cjs');
fs.writeFileSync(agent,`process.stdin.setRawMode(true);let input='',active=false,tick=0;const draw=()=>process.stdout.write('\\x1b[2J\\x1b[HREADY:'+process.pid+'\\r\\n');process.on('SIGWINCH',draw);process.stdin.on('data',b=>{input+=b;let end;while((end=input.indexOf('\\n'))>=0){const line=input.slice(0,end);input=input.slice(end+1);if(line==='ACTIVE')active=true;else if(line==='IDLE')active=false;process.stdout.write('R:'+process.pid+':'+line+'\\r\\n');}});setInterval(()=>{if(active)process.stdout.write('TICK:'+process.pid+':'+(++tick)+' '+'.'.repeat(512)+'\\r\\n');},100);draw();`);
let client=new PtyHostClient(entry);const text=new Map(),fences=new Set(),notices=new Map(),logs=[],samples=[];
function install(target){target.enableCrashRecovery({log:(event,fields)=>logs.push({event,...fields})});target.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>{
 if(e.type==='data'){text.set(e.ptyId,(text.get(e.ptyId)||'')+e.chunk);if(e.replayToken)fences.add(e.ptyId);}
 if(e.type==='recovered')notices.set(e.ptyId,e);
}});}
install(client);
let oldPid,newPid,ownerPid,timer,sampling=false,overlap=false,confirmedGone=false,successorSpawnedAt,recoveredAt;const peaks={main:0,old:0,new:0,owner:0,combined:0};
function sample(){if(sampling)return;sampling=true;const ids=[oldPid,newPid,ownerPid].filter(Boolean);if(!ids.length){sampling=false;return;}
 const requestedAt=Date.now();execFile('/bin/ps',['-o','pid=,rss=','-p',ids.join(',')],{encoding:'utf8'},(_err,out)=>{sampling=false;if(typeof out!=='string'||!out.trim())return;const rows=out.trim().split('\n').map(s=>s.trim().split(/\s+/).map(Number)),rss=new Map(rows);const main=process.memoryUsage().rss;peaks.main=Math.max(peaks.main,main);for(const [key,pid]of [['old',oldPid],['new',newPid],['owner',ownerPid]])peaks[key]=Math.max(peaks[key],(rss.get(pid)||0)*1024);peaks.combined=Math.max(peaks.combined,main+rows.reduce((n,r)=>n+r[1]*1024,0));if(oldPid&&newPid&&rss.has(oldPid)&&rss.has(newPid))overlap=true;samples.push({requestedAt,at:Date.now(),requestedPids:ids,mainRssBytes:main,oldPid,newPid,ownerPid,rssKiB:Object.fromEntries(rows)});});
}
function usage(pid){return JSON.parse(fs.readFileSync(path.join(process.env.AYA_HOME,'usage-'+pid+'.json'),'utf8'));}
async function cpu(pid){await wait(()=>fs.existsSync(path.join(process.env.AYA_HOME,'usage-'+pid+'.json')));const a=usage(pid),mainStart=performance.now(),mainCpu=process.cpuUsage();await sleep(2200);const mainWallMs=performance.now()-mainStart,mainDelta=process.cpuUsage(mainCpu),mainUs=mainDelta.user+mainDelta.system;const b=usage(pid),wall=b.at-a.at,hostUs=b.host.userCPUTime+b.host.systemCPUTime-a.host.userCPUTime-a.host.systemCPUTime,ownerUs=b.owner.userUs+b.owner.systemUs-a.owner.userUs-a.owner.systemUs;return{wallMs:wall,mainWallMs,mainUs,mainPercent:mainUs/(mainWallMs*10),hostUs,ownerUs,hostPercent:hostUs/(wall*10),ownerPercent:ownerUs/(wall*10)};}
async function roundtrips(label){const values=[];for(let i=0;i<25;i++){const id='p'+i,marker=label+'-'+i,start=performance.now();await client.write(id,marker+'\n');await wait(()=>(text.get(id)||'').includes(':'+marker));values.push(performance.now()-start);}return values;}
(async()=>{
 const requests=[];for(let i=0;i<25;i++){const req={ptyId:'p'+i,agent:'custom',command:`exec '${nodeExecutable}' '${agent}'`,cwd:process.env.HOME,cols:120,rows:40};requests.push(req);await client.spawn(req);}
 await wait(()=>text.size===25);const before=await client.hostStatus();oldPid=before.pid;ownerPid=before.owner.pid;const pids=await Promise.all(requests.map(r=>client.getPid(r.ptyId)));
 timer=setInterval(sample,100);sample();
 const continuityStarted=performance.now(),continuityCpu=process.cpuUsage();client.dispose();client.dropSocket();client=new PtyHostClient(entry);install(client);
 const reused=await client.hostStatus(),authContinuityMs=performance.now()-continuityStarted,authContinuityCpu=process.cpuUsage(continuityCpu);
 if(!client.ownsOwnerKey||reused.pid!==oldPid||reused.owner.pid!==ownerPid)throw Error('Authenticated continuity did not retain host/owner');
 for(let i=0;i<25;i++)if(await client.getPid('p'+i)!==pids[i])throw Error('Continuity changed child PID');
 const idleBefore=await cpu(oldPid),latencyBefore=await roundtrips('BEFORE');
 for(const r of requests)await client.write(r.ptyId,'ACTIVE\n');const activeBefore=await cpu(oldPid);
 const startHost=client.startHost.bind(client);client.startHost=(...args)=>{let gone=false;try{process.kill(oldPid,0);}catch(error){if(error.code==='ESRCH')gone=true;else throw error;}if(!gone||ownerProcessStartIdentity(oldPid)!==null)throw Error('Old JS host is not proved gone');confirmedGone=true;const child=startHost(...args);newPid=child.pid;successorSpawnedAt=Date.now();sample();return child;};
 const started=performance.now();process.kill(oldPid,'SIGKILL');await wait(()=>logs.some(e=>e.state==='recovered')&&fences.size===25);const readyMs=performance.now()-started;recoveredAt=Date.now();
 const after=await client.hostStatus();newPid=after.pid;sample();if(after.owner.pid!==ownerPid||newPid===oldPid)throw Error('Identity changed incorrectly');
 for(let i=0;i<25;i++){if(await client.getPid('p'+i)!==pids[i])throw Error('Child PID changed');const e=notices.get('p'+i);await client.acknowledgeHandoverDisplay('p'+i,e.generation,e.replayToken);}
 const ioStart=performance.now(),latencyAfter=await roundtrips('AFTER'),allIoMs=performance.now()-ioStart;
 const activeAfter=await cpu(newPid);for(const r of requests)await client.write(r.ptyId,'IDLE\n');const idleAfter=await cpu(newPid);sample();await sleep(150);
 if(!samples.length||!peaks.new||!peaks.owner)throw Error('No usable main/host/owner RSS sample set');
 const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*p)];
 const result={platform:process.platform,arch:process.arch,node:process.versions.node,electron:process.versions.electron??null,panes:25,hostIdentity:before.identity,ownerHash:before.owner.hash,authContinuityMs,authContinuityCpuUs:authContinuityCpu.user+authContinuityCpu.system,continuityClientInSameProcess:true,childPids:pids,oldPid,newPid,ownerPid,successorSpawnedAt,recoveredAt,allChildPidsKept:true,oldGoneBeforeSpawn:confirmedGone,sampledOverlap:overlap,recoveredAndReplayMs:readyMs,all25IoMs:allIoMs,latencyMs:{before:{p50:percentile(latencyBefore,.5),p95:percentile(latencyBefore,.95)},after:{p50:percentile(latencyAfter,.5),p95:percentile(latencyAfter,.95)}},cpu:{idleBefore,activeBefore,activeAfter,idleAfter},peakSampledRssBytes:peaks,rssSamples:samples.length,rawRssSamples:samples,scope:'One trial; authenticated socket and owner continuity enabled; second main client in the same process (ordinary app relaunch independently GUI-tested);  25 real native-owner PTYs, 120x40, active512B/100ms per pane; no DOM; 5ms polling for observed round-trip latency; 200ms instrumented CPU samples and100ms asynchronous RSS of benchmark main, old/successor JS host and owner (excludes the 25 child programs). Crash loses consumed screen/history by policy; no no-loss claim for consumed output.'};
 fs.writeFileSync('test-results/socket-auth-measurement.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));await client.shutdown();
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{clearInterval(timer);client.dispose();client.dropSocket();const {cleanupNativeOwner}=await import('../tests/helpers/pty-host.mjs');await cleanupNativeOwner(process.env.AYA_HOME);fs.rmSync(entry,{force:true});fs.rmSync(root,{recursive:true,force:true});});
