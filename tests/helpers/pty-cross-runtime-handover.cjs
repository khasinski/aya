const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PtyHostClient}=require('../../dist-electron/pty-host-client');
const {PlannedUpdate}=require('../../dist-electron/pty-planned-update');
const {PTY_HANDOVER_TICKET_PATH}=require('../../dist-electron/pty-host-paths');
const home=process.env.HOME,role=process.argv[2],client=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));
const wait=async f=>{const end=Date.now()+8000;while(!await f()){if(Date.now()>end)throw Error('Cross-runtime readiness timeout');await new Promise(r=>setTimeout(r,2));}};
let state,output='',exits=[];
client.attachWebContents({isDestroyed:()=>false,send:(_c,e)=>{if(e.type==='data')output+=e.chunk;if(e.type==='exit')exits.push(e);}});
const update=new PlannedUpdate({host:client,displays:{capture:async s=>{state=s;return null;},inspect:async s=>{state=s;},acknowledgeEscrow:async()=>{},clear:()=>{}},expected:()=>client.expectedHostIdentity('runtime-update'),livePaneIds:async()=>['cross'],confirmStop:async()=>{throw Error('A compatible runtime replacement must not ask to stop');},log:()=>{}});
(async()=>{
 if(role==='old'){
  const req={ptyId:'cross',agent:'custom',command:"stty -echo; printf 'HISTORY\\033[3'; while [ ! -f \"$HOME/release\" ]; do sleep .01; done; printf '1mTAIL\\033[0m\\n'; while IFS= read -r line; do case \"$line\" in quit) exit 23 ;; *) printf 'R:%s\\n' \"$line\" ;; esac; done",cwd:home,cols:80,rows:24};
  await client.spawn(req);await wait(()=>output.includes('\x1b[3'));
  const pid=await client.getPid('cross'),status=await client.hostStatus();
  assert.equal(await update.prepare(),true);assert.ok(fs.existsSync(PTY_HANDOVER_TICKET_PATH));
  fs.writeFileSync(path.join(home,'expected.json'),JSON.stringify({req,pid,ownerPid:status.owner.pid,hostPid:status.pid,identity:status.identity,origin:state.eligible[0]}),{mode:0o600});
  client.hostAsked=true;client.dispose();client.dropSocket();process.send({role,node:process.versions.node,electron:process.versions.electron??null},()=>process.exit(0));
 }else{
  const old=JSON.parse(fs.readFileSync(path.join(home,'expected.json'),'utf8'));
  assert.equal(await update.resume(), 'restored');assert.equal(fs.existsSync(PTY_HANDOVER_TICKET_PATH),false);
  const status=await client.hostStatus();assert.notEqual(status.pid,old.hostPid);assert.equal(status.owner.pid,old.ownerPid);assert.equal(await client.getPid('cross'),old.pid);
  assert.notDeepEqual(status.identity.runtime,old.identity.runtime);
  await client.spawn({...old.req,attachIfReused:true,replayAfter:{generation:old.origin.generation,offset:old.origin.outputEnd,token:'cross-runtime'}});
  assert.equal(await client.acknowledgeHandoverDisplay('cross',old.origin.generation,'cross-runtime'),true);
  fs.writeFileSync(path.join(home,'release'),'go');await wait(()=>output.includes('TAIL'));
  await client.write('cross','after-runtime\n');await wait(()=>output.includes('R:after-runtime'));
  const snapshot=await client.request({id:0,type:'snapshot',ptyId:'cross'});assert.ok(snapshot.rows.join('\n').includes('HISTORYTAIL'));
  await client.write('cross','quit\n');await wait(()=>exits.length===1);assert.equal(exits[0].exitCode,23);
  await client.shutdown();client.dispose();process.send({role,node:process.versions.node,electron:process.versions.electron??null},()=>process.exit(0));
 }
})().catch(async e=>{console.error(e);if(client.isConnected())await client.shutdown().catch(()=>{});client.dispose();process.exit(1);});
