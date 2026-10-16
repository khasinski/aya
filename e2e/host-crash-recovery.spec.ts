import {_electron} from '@playwright/test';
import {appEnv} from './helpers/seed';
import {askControl} from './helpers/control';
import {teamSeed,BARE_TEAM,teamLog} from './helpers/team';
import {agentBin} from './helpers/agent-bin';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {test,expect,hostPidsForHome,closeAndWait,ciElectronFlags} from './fixtures';
import {waitForShellReady,visiblePane} from './helpers/terminal';
test.use({seedOptions:{launchEnv:{AYA_E2E_PTY_SHUTDOWN:'0'}}});
type Record={pid:number;panes:Array<{id:string;pid:number;generation:number;cols:number;rows:number}>};
const record=(home:string):Record=>JSON.parse(readFileSync(join(home,'pty-owner/record.json'),'utf8'));
const identities=(home:string)=>record(home).panes.map(p=>({id:p.id,pid:p.pid,generation:p.generation})).sort((a,b)=>a.id.localeCompare(b.id));
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function crash(home:string){const hosts=hostPidsForHome(home);expect(hosts).toHaveLength(1);process.kill(hosts[0],'SIGKILL');await expect.poll(()=>alive(hosts[0])).toBe(false);return hosts[0];}
async function recovered(home:string,old:number){await expect.poll(()=>hostPidsForHome(home).filter(pid=>pid!==old).length).toBe(1);}

test('a real JS-host crash keeps shell PIDs, clears stale display and restores input/resize without respawn',async({window,seeded})=>{
 await waitForShellReady(window);await expect.poll(()=>record(seeded.ayaHome).panes.length).toBe(2);
 await window.evaluate(()=>window.aya.ptyWrite('tab-left',"printf 'OLD_CONSUMED_HISTORY\\n'\r"));
 await expect.poll(()=>window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('OLD_CONSUMED_HISTORY\r\n');
 const before=identities(seeded.ayaHome),owner=record(seeded.ayaHome).pid,old=await crash(seeded.ayaHome);await recovered(seeded.ayaHome,old);
 const pane=visiblePane(window,'shell 1'),terminal=pane.getByTestId('xterm-host');
 await expect(pane.getByTestId('terminal-history-notice')).toContainText('Previously consumed screen and history were lost');
 await expect.poll(()=>identities(seeded.ayaHome)).toEqual(before);expect(record(seeded.ayaHome).pid).toBe(owner);
 await expect(terminal).not.toContainText('OLD_CONSUMED_HISTORY');
 await terminal.click();await window.keyboard.type("printf 'NEW_IO_AFTER_CRASH\\n'");await window.keyboard.press('Enter');
 await expect(terminal).toContainText('NEW_IO_AFTER_CRASH');
 await expect.poll(()=>window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('NEW_IO_AFTER_CRASH\r\n');
 await window.evaluate(async()=>{await window.aya.ptyResize('tab-left',101,39);await window.aya.ptyWrite('tab-left',"stty size\r");});
 await expect.poll(()=>window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('39 101\r\n');
 expect(readFileSync(join(seeded.ayaHome,'pty-events.log'),'utf8').split('\n').filter(line=>{try{return JSON.parse(line).ev==='spawn';}catch{return false;}})).toHaveLength(2);
});

test('three short-lived recoveries exhaust the shared budget and Try again makes one safe attempt',async({app,window,seeded})=>{
 await waitForShellReady(window);const before=identities(seeded.ayaHome),owner=record(seeded.ayaHome).pid;
 // Host PID discovery can precede main's recovery fence. Only an explicitly
 // not-sent empty readiness probe is retried; no user input is repeated.
 for(let i=0;i<3;i++){const old=await crash(seeded.ayaHome);await recovered(seeded.ayaHome,old);await expect(visiblePane(window,'shell 1').getByTestId('terminal-history-notice')).toContainText('Previously consumed');await expect.poll(()=>window.evaluate(()=>window.aya.ptyWrite('tab-left','').catch((error:unknown)=>{if(/This request was not sent/.test(String(error)))return false;throw error;}))).toBe(true);}
 await crash(seeded.ayaHome);
 await expect(visiblePane(window,'shell 1').getByTestId('terminal-history-notice')).toContainText('recovery budget');
 expect(hostPidsForHome(seeded.ayaHome)).toEqual([]);expect(identities(seeded.ayaHome)).toEqual(before);expect(record(seeded.ayaHome).pid).toBe(owner);
 for(const p of before)expect(alive(p.pid)).toBe(true);
 await window.reload();const pane=visiblePane(window,'shell 1');await expect(pane.getByTestId('terminal-history-notice')).toContainText('recovery budget');
 const row=window.locator('.aya-sidebar-row[data-terminal-name="shell 1"]');await row.click({button:'right'});const restart=window.locator('.aya-context-menu-item',{hasText:'Restart terminal'});await expect(restart).toBeDisabled();await expect(restart).toContainText('host recovering');await expect(restart).toHaveAttribute('title',/recovery budget/);await window.keyboard.press('Escape');
 await app.evaluate((_api,root)=>{const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js'),attempt=PtyHostClient.prototype.recoverCrashedHost;const g=globalThis as unknown as {manualAttempts:number};g.manualAttempts=0;PtyHostClient.prototype.recoverCrashedHost=function(...args:unknown[]){g.manualAttempts++;return attempt.apply(this,args);};},join(__dirname,'..'));
 await pane.getByTestId('terminal-recovery-retry').click();await expect(pane.getByTestId('terminal-history-notice')).toContainText('Previously consumed');
 expect(await app.evaluate(()=>(globalThis as unknown as {manualAttempts:number}).manualAttempts)).toBe(1);
 await expect(pane.getByTestId('terminal-recovery-retry')).toHaveCount(0);expect(identities(seeded.ayaHome)).toEqual(before);expect(record(seeded.ayaHome).pid).toBe(owner);
});

test.describe('a recovered pane mounted later',()=>{
 test.use({seedOptions:{split:false,launchEnv:{AYA_E2E_PTY_SHUTDOWN:'0'}}});
 test('gets replay and the history-loss explanation without creating another process',async({window,seeded})=>{
  await waitForShellReady(window);
  const file=join(seeded.ayaHome,'projects/e2e-proj.json'),project=JSON.parse(readFileSync(file,'utf8'));
  project.tabs.push({id:'deferred-crash',presetId:'shell',name:'Deferred crash'});writeFileSync(file,JSON.stringify(project));
  const row=window.locator('.aya-sidebar-row[data-terminal-name="Deferred crash"]');await expect(row).toBeVisible();
  await window.evaluate(cwd=>window.aya.ptySpawn({ptyId:'deferred-crash',agent:'custom',command:"exec /bin/sh -c 'echo BEFORE_CRASH; while IFS= read -r line; do echo REPLY:$line; done'",cwd,cols:80,rows:24}),seeded.projectDir);
  await expect.poll(()=>record(seeded.ayaHome).panes.length).toBe(3);const before=identities(seeded.ayaHome),old=await crash(seeded.ayaHome);await recovered(seeded.ayaHome,old);
  // A new host PID shows up before main finishes recovering, and until then a write is refused as not sent.
  // Only that refusal is repeated (nothing reached the pane); any other error fails at once.
  await expect.poll(()=>window.evaluate(()=>window.aya.ptyWrite('deferred-crash','WAITING_FOR_LATE_VIEW\n').then(r=>r,(e:unknown)=>{if(/This request was not sent/.test(String(e)))return 'not sent';throw e;}))).toBe(true);
  await expect.poll(()=>window.evaluate(()=>window.aya.ptyBuffer('deferred-crash'))).toContain('REPLY:WAITING_FOR_LATE_VIEW');
  // Exactly once: a later sentinel's reply follows the only one, so a write delivered and then repeated fails here.
  await window.evaluate(()=>window.aya.ptyWrite('deferred-crash','ORDER_SENTINEL\n'));
  await expect.poll(()=>window.evaluate(()=>window.aya.ptyBuffer('deferred-crash'))).toContain('REPLY:ORDER_SENTINEL');
  const parts=(await window.evaluate(()=>window.aya.ptyBuffer('deferred-crash'))).split('REPLY:WAITING_FOR_LATE_VIEW');
  expect(parts).toHaveLength(2);expect(parts[1]).toContain('REPLY:ORDER_SENTINEL');
  await row.click();const pane=window.locator('.aya-pane[data-terminal-id="deferred-crash"]');
  await expect(pane.getByTestId('terminal-history-notice')).toContainText('Previously consumed');await expect(pane.getByTestId('xterm-host')).toContainText('REPLY:WAITING_FOR_LATE_VIEW');
  await pane.getByTestId('xterm-host').click();await window.keyboard.type('LATE_INPUT');await window.keyboard.press('Enter');await expect(pane.getByTestId('xterm-host')).toContainText('REPLY:LATE_INPUT');
  expect(identities(seeded.ayaHome)).toEqual(before);
 });
});

for(const [mode,cli] of [['recorded','claude'],['recorded','codex'],['busy','claude'],['held','claude'],['fragment','claude']]){
 const name=`${cli} ${mode}`;
 test.describe(name,()=>{
  const executable=agentBin(cli,join(__dirname,'helpers/crash-agent.cjs'));
  const preset={id:cli,name:cli,agent:cli,icon:'a',color:'',command:`'${executable}' ${mode} ${cli}`};
  const options={launchEnv:{AYA_E2E_PTY_SHUTDOWN:'0'},rightTab:{presetId:cli,name},presetList:[{id:'shell',name:'Shell',icon:'$',color:'',command:'$SHELL'},preset]};
  test.use(mode==='fragment'?teamSeed(BARE_TEAM,{presetList:options.presetList,seed:options}):{seedOptions:options});
  test('keeps the agent process and proves redraw before trusting its screen',async({app,window,seeded})=>{
   test.setTimeout(30000);await waitForShellReady(window);await expect.poll(()=>record(seeded.ayaHome).panes.length).toBe(2);
   await expect.poll(()=>window.evaluate(()=>window.aya.ptyBuffer('tab-right'))).not.toBe('');
   // Recorded raw sessions have120x40 geometry; replay them at their actual size.
   if(mode==='recorded')await window.evaluate(()=>window.aya.ptyResize('tab-right',120,40));
   const before=identities(seeded.ayaHome),old=await crash(seeded.ayaHome);await recovered(seeded.ayaHome,old);
   const pane=visiblePane(window,name);await expect(pane.getByTestId('terminal-history-notice')).toContainText('Previously consumed');
   const state=()=>app.evaluate(async (_electron,root)=>{const require=process.getBuiltinModule('module').createRequire(root+'/package.json');const {PtyHostClient}=require(root+'/dist-electron/pty-host-client.js');const client=new PtyHostClient(root+'/dist-electron/pty-host.js');try{return{hold:await client.holdReason('tab-right'),busy:await client.paneBusy('tab-right')};}finally{client.dispose();client.dropSocket();}},join(__dirname,'..'));
   if(mode==='fragment'){
    await expect(pane.getByTestId('terminal-history-notice')).toContainText('Screen unknown after the terminal host restarted',{timeout:15000});
    expect((await state()).hold).toContain('screen unknown after the terminal host restarted');expect((await state()).busy).toBe(false);
    const sent=await askControl(seeded.ayaHome,{type:'team-send',role:'implementer',text:'RECOVERY_DELIVERY'});
    expect(JSON.stringify(sent)).toContain('screen unknown after the terminal host restarted');
    expect(teamLog(seeded.projectDir)('tab-right')).not.toContain('RECOVERY_DELIVERY');
    await window.reload();
    await expect(visiblePane(window,name).getByTestId('terminal-history-notice')).toContainText('Screen unknown after the terminal host restarted');
    expect((await state()).hold).toContain('screen unknown after the terminal host restarted');
    await window.evaluate(()=>window.aya.ptyWrite('tab-right','REDRAW'));await expect.poll(async()=>(await state()).hold).toBe(null);
    await expect(pane.getByTestId('terminal-history-notice')).not.toContainText('Screen unknown');
    await expect.poll(()=>teamLog(seeded.projectDir)('tab-right'),{timeout:10000}).toContain('RECOVERY_DELIVERY');
    expect(teamLog(seeded.projectDir)('tab-right').split('RECOVERY_DELIVERY').length-1).toBe(1);
   }else if(mode==='busy'){await expect.poll(async()=>(await state()).busy).toBe(true);}
   else if(mode==='held'){await expect.poll(async()=>(await state()).hold).toMatch(/approval|choice|dialog/);await expect(pane.getByTestId('terminal-history-notice')).not.toContainText('Screen unknown');}
   else {await expect.poll(async()=>(await state()).hold,{timeout:15000}).toBe(null);}
   expect(identities(seeded.ayaHome)).toEqual(before);
  });
 });
}

test('a paste whose host ACK is lost is reported as uncertain and never repeated after recovery',async({app,window,seeded})=>{
 await waitForShellReady(window);
 const file=join(seeded.projectDir,'input-once');
 await window.evaluate(file=>window.aya.ptyWrite('tab-left',`stty -echo; while IFS= read -r line; do printf '%s\\n' "$line" >> '${file}'; printf 'PASTE_RECEIVED\\n'; done\r`),file);
 await expect.poll(()=>window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('stty -echo;');
 await app.evaluate((_electron,root)=>{
  const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js');
  const g=globalThis as unknown as {pasteAckHeld:boolean;pasteCalls:number;restorePaste:()=>void};g.pasteAckHeld=false;g.pasteCalls=0;
  const reply=PtyHostClient.prototype.onResponse,write=PtyHostClient.prototype.write;
  PtyHostClient.prototype.onResponse=function(message:{id:number}){const pending=this.pending.get(message.id);if(pending?.type==='write'&&pending.ptyId==='tab-left'){g.pasteAckHeld=true;return;}return reply.call(this,message);};
  PtyHostClient.prototype.write=function(id:string,data:string){if(id==='tab-left'&&data.includes('ONCE_ENTER'))g.pasteCalls++;return write.call(this,id,data);};
  g.restorePaste=()=>{PtyHostClient.prototype.onResponse=reply;};
 },join(__dirname,'..'));
 const pane=visiblePane(window,'shell 1'),terminal=pane.getByTestId('xterm-host');await terminal.click();
 await terminal.locator('.xterm-helper-textarea').evaluate(textarea=>{const transfer=new DataTransfer();transfer.setData('text/plain','ONCE_ENTER\n');textarea.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));});
 await expect.poll(()=>{try{return readFileSync(file,'utf8');}catch{return '';}}).toBe('ONCE_ENTER\n');
 await expect.poll(()=>app.evaluate(()=>(globalThis as unknown as {pasteAckHeld:boolean}).pasteAckHeld)).toBe(true);
 const before=identities(seeded.ayaHome),old=await crash(seeded.ayaHome);
 await app.evaluate(()=>(globalThis as unknown as {restorePaste:()=>void}).restorePaste());await recovered(seeded.ayaHome,old);
 await expect(pane.getByTestId('terminal-history-notice')).toContainText('Input acknowledgement was lost');
 await expect(pane.getByTestId('terminal-history-notice')).toContainText('Aya did not resend it');
 expect(readFileSync(file,'utf8')).toBe('ONCE_ENTER\n');expect(await app.evaluate(()=>(globalThis as unknown as {pasteCalls:number}).pasteCalls)).toBe(1);expect(identities(seeded.ayaHome)).toEqual(before);
});

for(const gap of [false,true])test(`real exit23 ${gap?'during the no-JS gap':'after recovery'} reaches the pane without a replacement`,async({app,window,seeded})=>{
 await waitForShellReady(window);const before=identities(seeded.ayaHome),child=before.find(p=>p.id==='tab-left')!.pid;
 const releaseFile=join(seeded.projectDir,'exit-release');
 await window.evaluate(file=>window.aya.ptyWrite('tab-left',`exec /bin/sh -c 'while [ ! -f "${file}" ]; do sleep .01; done; exit 23'\r`),releaseFile);
 if(gap)await app.evaluate((_electron,root)=>{
  const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js');
  const attempt=PtyHostClient.prototype.recoverCrashedHost,g=globalThis as unknown as {releaseGap:()=>void;gapWaiting:boolean};g.gapWaiting=false;
  PtyHostClient.prototype.recoverCrashedHost=async function(signal:AbortSignal){g.gapWaiting=true;await new Promise<void>(resolve=>{g.releaseGap=resolve;signal.addEventListener('abort',()=>resolve(),{once:true});});return attempt.call(this,signal);};
 },join(__dirname,'..'));
 const old=await crash(seeded.ayaHome);
 if(gap){await expect.poll(()=>app.evaluate(()=>(globalThis as unknown as {gapWaiting:boolean}).gapWaiting)).toBe(true);writeFileSync(releaseFile,'exit');await expect.poll(()=>alive(child)).toBe(false);await app.evaluate(()=>(globalThis as unknown as {releaseGap:()=>void}).releaseGap());}
 await recovered(seeded.ayaHome,old);if(!gap)writeFileSync(releaseFile,'exit');
 if(gap)await expect(visiblePane(window,'shell 1').getByTestId('terminal-history-notice')).toContainText('the process had exited with code 23');
 await expect(visiblePane(window,'shell 1').getByTestId('xterm-host')).toContainText('process exited with code 23');
 await window.evaluate(()=>window.aya.ptySpawn({ptyId:'tab-left',command:'echo MUST_NOT_SPAWN',cwd:'/',cols:80,rows:24,attachOnly:true}));
 expect(alive(child)).toBe(false);
 expect(readFileSync(join(seeded.ayaHome,'pty-events.log'),'utf8').split('\n').filter(line=>{try{return JSON.parse(line).ev==='spawn';}catch{return false;}})).toHaveLength(2);
});

const quitTest=test.extend({app:async({seeded},use)=>{const root=join(__dirname,'..');const app=await _electron.launch({cwd:root,args:[join(root,'dist-electron/main.js'),`--user-data-dir=${seeded.userDataDir}`,...ciElectronFlags()],env:appEnv({...seeded,launchEnv:{...seeded.launchEnv,AYA_E2E_PTY_SHUTDOWN:'0'}})}),pid=app.process().pid!;await use(app);if(alive(pid))await closeAndWait(app);}});
quitTest('app quit during a real pending recovery cancels it without starting another JS reader',async({app,window,seeded})=>{
 await waitForShellReady(window);const before=identities(seeded.ayaHome),owner=record(seeded.ayaHome).pid,attemptFile=join(seeded.root,'unexpected-successors');
 await app.evaluate((_electron,{root,file})=>{
  const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js'),fs=require('node:fs');
  const attempt=PtyHostClient.prototype.recoverCrashedHost,start=PtyHostClient.prototype.startHost;
  PtyHostClient.prototype.startHost=function(...args:unknown[]){fs.appendFileSync(file,'start\n');return start.apply(this,args);};
  PtyHostClient.prototype.recoverCrashedHost=async function(signal:AbortSignal){(globalThis as unknown as {quitRecoveryWaiting:boolean}).quitRecoveryWaiting=true;await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});return attempt.call(this,signal);};
 },{root:join(__dirname,'..'),file:attemptFile});
 await crash(seeded.ayaHome);await expect.poll(()=>app.evaluate(()=>(globalThis as unknown as {quitRecoveryWaiting:boolean}).quitRecoveryWaiting)).toBe(true);
 await closeAndWait(app);
 expect(hostPidsForHome(seeded.ayaHome)).toEqual([]);expect(record(seeded.ayaHome).pid).toBe(owner);expect(identities(seeded.ayaHome)).toEqual(before);for(const p of before)expect(alive(p.pid)).toBe(true);
 expect(existsSync(attemptFile)?readFileSync(attemptFile,'utf8'):'').toBe('');
});

test('an incompatible owner at crash time stays disconnected and is never replaced implicitly',async({window,seeded})=>{
 await waitForShellReady(window);const before=record(seeded.ayaHome),file=join(seeded.ayaHome,'pty-owner/record.json'),saved=readFileSync(file);
 writeFileSync(file,JSON.stringify({...before,binaryHash:'0'.repeat(64)}));
 try{
  await crash(seeded.ayaHome);await expect(visiblePane(window,'shell 1').getByTestId('terminal-history-notice')).toContainText('recovery budget');
  expect(hostPidsForHome(seeded.ayaHome)).toEqual([]);expect(record(seeded.ayaHome).pid).toBe(before.pid);expect(alive(before.pid)).toBe(true);for(const p of before.panes)expect(alive(p.pid)).toBe(true);
 }finally{writeFileSync(file,saved);}
});

test('keyboard and paste stay blocked until the recovered replay fence is actually applied',async({app,window,seeded})=>{
 await waitForShellReady(window);const file=join(seeded.projectDir,'gated-input'),ready=join(seeded.projectDir,'gated-ready');
 await window.evaluate(({file,ready})=>window.aya.ptyWrite('tab-left',`stty -echo; touch '${ready}'; while IFS= read -r line; do printf '%s\\n' "$line" >> '${file}'; done\r`),{file,ready});
 await expect.poll(()=>existsSync(ready)).toBe(true);
 await app.evaluate((_api,root)=>{
  const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js');
  const g=globalThis as unknown as {gateWrites:number;gateReady:()=>boolean;releaseReplay:()=>void};g.gateWrites=0;
  const send=PtyHostClient.prototype.sendToSinks,write=PtyHostClient.prototype.write,held:Array<{client:unknown;event:unknown}>=[];
  PtyHostClient.prototype.sendToSinks=function(events:Array<{type:string;ptyId:string;replayToken?:string}>){const pass=[];for(const event of events){if(event.type==='data'&&event.ptyId==='tab-left'&&event.replayToken)held.push({client:this,event});else pass.push(event);}if(pass.length)send.call(this,pass);};
  PtyHostClient.prototype.write=function(id:string,...args:unknown[]){if(id==='tab-left')g.gateWrites++;return write.call(this,id,...args);};
  g.gateReady=()=>held.length>0&&!(held[0].client as {crashBlocked:boolean}).crashBlocked;
  g.releaseReplay=()=>{for(const item of held.splice(0))send.call(item.client,[item.event]);};
 },join(__dirname,'..'));
 const old=await crash(seeded.ayaHome);await recovered(seeded.ayaHome,old);await expect.poll(()=>app.evaluate(()=>(globalThis as unknown as {gateReady:()=>boolean}).gateReady())).toBe(true);
 const terminal=visiblePane(window,'shell 1').getByTestId('xterm-host');await terminal.click();await window.keyboard.type('BEFORE_GATE');await window.keyboard.press('Enter');
 const paste=(text:string)=>terminal.locator('.xterm-helper-textarea').evaluate((textarea,text)=>{const transfer=new DataTransfer();transfer.setData('text/plain',text);textarea.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));},text);
 await paste('BEFORE_PASTE\n');
 expect(await app.evaluate(()=>(globalThis as unknown as {gateWrites:number}).gateWrites)).toBe(0);expect(existsSync(file)).toBe(false);
 await app.evaluate(()=>(globalThis as unknown as {releaseReplay:()=>void}).releaseReplay());
 await expect(terminal.locator('.xterm-helper-textarea')).not.toHaveAttribute('readonly','');
 // The native ACK removes the main display record only after the xterm write callback.
 await expect.poll(()=>window.evaluate(()=>window.aya.handoverDisplay('tab-left'))).toBe(null);
 await paste('AFTER_GATE\n');await expect.poll(()=>existsSync(file)?readFileSync(file,'utf8'):'').toBe('AFTER_GATE\n');
 expect(await app.evaluate(()=>(globalThis as unknown as {gateWrites:number}).gateWrites)).toBe(1);
});

test('failed Try again returns its reason with one counted attempt and leaves every process intact',async({app,window,seeded})=>{
 await waitForShellReady(window);const before=identities(seeded.ayaHome),owner=record(seeded.ayaHome).pid;
 await app.evaluate((_api,root)=>{const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js');const g=globalThis as unknown as {manualFailureCalls:number};g.manualFailureCalls=0;PtyHostClient.prototype.recoverCrashedHost=async function(){g.manualFailureCalls++;this.recoveryFailure='Controlled test recovery refusal: inventory could not be reconciled';return 'blocked';};},join(__dirname,'..'));
 await crash(seeded.ayaHome);const pane=visiblePane(window,'shell 1');await expect(pane.getByTestId('terminal-recovery-retry')).toBeVisible();
 const baseline=await app.evaluate(()=>(globalThis as unknown as {manualFailureCalls:number}).manualFailureCalls);
 await pane.getByTestId('terminal-recovery-retry').click();await expect.poll(()=>app.evaluate(()=>(globalThis as unknown as {manualFailureCalls:number}).manualFailureCalls)).toBe(baseline+1);await expect(pane.getByTestId('terminal-history-notice')).toContainText('Controlled test recovery refusal');await expect(pane.getByTestId('terminal-recovery-retry')).toBeVisible();
 expect(await app.evaluate(()=>(globalThis as unknown as {manualFailureCalls:number}).manualFailureCalls)).toBe(baseline+1);expect(hostPidsForHome(seeded.ayaHome)).toEqual([]);expect(identities(seeded.ayaHome)).toEqual(before);expect(record(seeded.ayaHome).pid).toBe(owner);for(const p of before)expect(alive(p.pid)).toBe(true);
});

test('restarting an ended pane after another pane loses its owner is a friendly single refusal',async({app,window,seeded})=>{
 await waitForShellReady(window);const errors:string[]=[];window.on('pageerror',error=>errors.push(String(error)));
 await window.evaluate(()=>{const w=window as unknown as {attachRejections:string[]};w.attachRejections=[];window.addEventListener('unhandledrejection',e=>w.attachRejections.push(String(e.reason)));});
 await window.evaluate(()=>window.aya.ptyWrite('tab-left','exit 0\r'));
 const ended=visiblePane(window,'shell 1').getByTestId('xterm-host');await expect(ended).toContainText('process exited with code 0');
 const quote=(s:string)=>`'${s.replace(/'/g,"'\\''")}'`;
 await window.evaluate(command=>window.aya.ptyWrite('tab-right',command+'\r'),`exec ${quote(process.execPath)} ${quote(join(__dirname,'helpers/pty-owner-survivor.cjs'))}`);
 await expect(visiblePane(window,'shell 2').getByTestId('xterm-host')).toContainText('SURVIVOR_READY');
 const before=record(seeded.ayaHome),survivor=before.panes.find(p=>p.id==='tab-right')!;
 await app.evaluate((_electron,root)=>{const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js'),spawn=PtyHostClient.prototype.spawn,g=globalThis as unknown as {endedRestartCalls:number};g.endedRestartCalls=0;PtyHostClient.prototype.spawn=async function(...args:Parameters<typeof spawn>){if(args[0].ptyId==='tab-left')g.endedRestartCalls++;return spawn.apply(this,args);};},join(__dirname,'..'));
 process.kill(before.pid,'SIGKILL');await expect.poll(()=>alive(before.pid)).toBe(false);await crash(seeded.ayaHome);
 await expect(visiblePane(window,'shell 2').getByTestId('terminal-history-notice')).toContainText('recovery budget');
 await ended.click();await window.keyboard.press('Shift+Enter');
 await expect(visiblePane(window,'shell 1').getByTestId('terminal-history-notice')).toContainText('processes may still be running');
 await expect.poll(()=>app.evaluate(()=>(globalThis as unknown as {endedRestartCalls:number}).endedRestartCalls)).toBe(1);
 await expect(ended).not.toContainText('Terminal attachment failed');await expect(ended).not.toContainText('Error invoking remote method');
 await window.waitForTimeout(500);expect(await app.evaluate(()=>(globalThis as unknown as {endedRestartCalls:number}).endedRestartCalls)).toBe(1);
 expect(errors).toEqual([]);expect(await window.evaluate(()=>(window as unknown as {attachRejections:string[]}).attachRejections)).toEqual([]);
 expect(alive(survivor.pid)).toBe(true);expect(record(seeded.ayaHome).pid).toBe(before.pid);expect(record(seeded.ayaHome).panes.find(p=>p.id==='tab-right')?.pid).toBe(survivor.pid);
 expect(readFileSync(join(seeded.ayaHome,'pty-events.log'),'utf8').split('\n').filter(line=>{try{return JSON.parse(line).ev==='spawn';}catch{return false;}})).toHaveLength(2);
});
