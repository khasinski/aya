import {agentBin} from './helpers/agent-bin';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {test,expect,hostPidsForHome,closeAndWait} from './fixtures';
import {waitForShellReady,visiblePane} from './helpers/terminal';
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

test('three short-lived recoveries exhaust the shared budget and keep every process disconnected',async({window,seeded})=>{
 await waitForShellReady(window);const before=identities(seeded.ayaHome),owner=record(seeded.ayaHome).pid;
 for(let i=0;i<3;i++){const old=await crash(seeded.ayaHome);await recovered(seeded.ayaHome,old);await expect(visiblePane(window,'shell 1').getByTestId('terminal-history-notice')).toContainText('Previously consumed');await expect.poll(()=>window.evaluate(()=>window.aya.ptyWrite('tab-left',''))).toBe(true);}
 await crash(seeded.ayaHome);
 await expect(visiblePane(window,'shell 1').getByTestId('terminal-history-notice')).toContainText('recovery budget');
 expect(hostPidsForHome(seeded.ayaHome)).toEqual([]);expect(identities(seeded.ayaHome)).toEqual(before);expect(record(seeded.ayaHome).pid).toBe(owner);
 for(const p of before)expect(alive(p.pid)).toBe(true);
});

test.describe('a recovered pane mounted later',()=>{
 test.use({seedOptions:{split:false}});
 test('gets replay and the history-loss explanation without creating another process',async({window,seeded})=>{
  await waitForShellReady(window);
  const file=join(seeded.ayaHome,'projects/e2e-proj.json'),project=JSON.parse(readFileSync(file,'utf8'));
  project.tabs.push({id:'deferred-crash',presetId:'shell',name:'Deferred crash'});writeFileSync(file,JSON.stringify(project));
  const row=window.locator('.aya-sidebar-row[data-terminal-name="Deferred crash"]');await expect(row).toBeVisible();
  await window.evaluate(cwd=>window.aya.ptySpawn({ptyId:'deferred-crash',agent:'custom',command:"exec /bin/sh -c 'echo BEFORE_CRASH; while IFS= read -r line; do echo REPLY:$line; done'",cwd,cols:80,rows:24}),seeded.projectDir);
  await expect.poll(()=>record(seeded.ayaHome).panes.length).toBe(3);const before=identities(seeded.ayaHome),old=await crash(seeded.ayaHome);await recovered(seeded.ayaHome,old);
  await expect.poll(()=>window.evaluate(()=>window.aya.ptyWrite('deferred-crash','WAITING_FOR_LATE_VIEW\n'))).toBe(true);
  await expect.poll(()=>window.evaluate(()=>window.aya.ptyBuffer('deferred-crash'))).toContain('REPLY:WAITING_FOR_LATE_VIEW');
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
  test.use({seedOptions:{rightTab:{presetId:cli,name},presetList:[{id:'shell',name:'Shell',icon:'$',color:'',command:'$SHELL'},preset]}});
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
    await window.evaluate(()=>window.aya.ptyWrite('tab-right','REDRAW'));await expect.poll(async()=>(await state()).hold).toBe(null);
    await expect(pane.getByTestId('terminal-history-notice')).not.toContainText('Screen unknown');
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
 await expect(visiblePane(window,'shell 1').getByTestId('xterm-host')).toContainText('process exited with code 23');
 await window.evaluate(()=>window.aya.ptySpawn({ptyId:'tab-left',command:'echo MUST_NOT_SPAWN',cwd:'/',cols:80,rows:24,attachOnly:true}));
 expect(alive(child)).toBe(false);
 expect(readFileSync(join(seeded.ayaHome,'pty-events.log'),'utf8').split('\n').filter(line=>{try{return JSON.parse(line).ev==='spawn';}catch{return false;}})).toHaveLength(2);
});

test('app quit during a real pending recovery cancels it without starting another JS reader',async({app,window,seeded})=>{
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
