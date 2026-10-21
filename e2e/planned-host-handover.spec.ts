import {appendFileSync,readFileSync,writeFileSync,existsSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {_electron,type ElectronApplication,type Page} from "@playwright/test";
import {test,expect,hostPidsForHome,closeAndWait,ciElectronFlags} from "./fixtures";
import {appEnv,type SeededEnv} from "./helpers/seed";
import {waitForShellReady,visiblePane} from "./helpers/terminal";
const root=join(__dirname,'..'),hostScript=join(root,'dist-electron/pty-host.js'),built=readFileSync(hostScript);
const rulesScript=join(root,'dist-electron/agent-screen-rules.js'),rulesBuilt=readFileSync(rulesScript),packageFile=join(root,'package.json'),packageBuilt=readFileSync(packageFile);
const apps:ElectronApplication[]=[];
test.afterEach(async()=>{writeFileSync(hostScript,built);writeFileSync(rulesScript,rulesBuilt);writeFileSync(packageFile,packageBuilt);for(const app of apps.splice(0))await closeAndWait(app);});
async function launch(seeded:SeededEnv,choice=1,blockDisplay=false,realUpdate=false,plainHost=false,dateOffsetMs=0,failOrdinaryAnnouncement=false){
 const wrapper=join(seeded.root,'handover-main.js');
 // Wrapper code is constant; disposable paths/options are data, never JS source.
 writeFileSync(wrapper,`const electron=require('electron'),path=require('node:path'),root=process.env.AYA_TEST_APP_ROOT;
 globalThis.handoverQuestions=[];globalThis.handoverOrder=[];globalThis.handoverSpawns=[];globalThis.handoverWrites=[];
 const MainClient=require(path.join(root,'dist-electron/pty-host-client.js')).PtyHostClient,mainRequest=MainClient.prototype.request;
 MainClient.prototype.request=function(...args){globalThis.handoverMainClient??=this;return mainRequest.apply(this,args);};
 const trackHandle=electron.ipcMain.handle.bind(electron.ipcMain);
 electron.ipcMain.handle=(channel,handler)=>trackHandle(channel,(event,...args)=>{if(channel==='pty:spawn')globalThis.handoverSpawns.push(args[0]);if(channel==='pty:write')globalThis.handoverWrites.push(args[0]);return handler(event,...args);});
 electron.dialog.showMessageBox=async(...args)=>{const fs=require('node:fs'),options=args.at(-1);globalThis.handoverQuestions.push(options);globalThis.handoverOrder.push('question');fs.writeFileSync(process.env.AYA_TEST_QUESTIONS_FILE,JSON.stringify(globalThis.handoverQuestions));return{response:Number(process.env.AYA_TEST_HANDOVER_CHOICE),checkboxChecked:false};};
 if(process.env.AYA_TEST_PLAIN_HOST==='1'){
  const cp=require('node:child_process'),spawn=cp.spawn,hostScript=path.join(root,'dist-electron/pty-host.js');
  cp.spawn=(file,args,options)=>spawn(file===process.execPath&&args?.[0]===hostScript?process.env.AYA_TEST_PLAIN_NODE:file,args,options);
  const {hostBuildHash}=require(path.join(root,'dist-electron/pty-host-staleness.js'));
  MainClient.prototype.expectedHostIdentity=function(version){const runtime=JSON.parse(process.env.AYA_TEST_PLAIN_RUNTIME);return{version,runtime,scriptHash:hostBuildHash(path.dirname(this.hostScript),path.basename(this.hostScript),runtime)};};
 }
 if(process.env.AYA_TEST_BLOCK_DISPLAY==='1'){
  const fs=require('node:fs'),original=electron.ipcMain.handle.bind(electron.ipcMain);globalThis.handoverDisplayWaiting=false;globalThis.inputCalls=0;
  electron.ipcMain.handle=(channel,handler)=>original(channel,async(event,...args)=>{if(channel==='pty:write')globalThis.inputCalls++;if(channel==='pty-checkpoint:display'&&args[0]==='tab-left'){globalThis.handoverDisplayWaiting=true;const deadline=Date.now()+15000;while(!fs.existsSync(process.env.AYA_TEST_DISPLAY_RELEASE)){if(Date.now()>deadline)throw Error('test display gate expired');await new Promise(r=>setTimeout(r,2));}}return handler(event,...args);});
 }
 if(process.env.AYA_TEST_REAL_UPDATE==='1'){
  Object.defineProperty(electron.app,'isPackaged',{get:()=>true});process.env.APPIMAGE='test-only-appimage';
  const updater=require(path.join(root,'node_modules/electron-updater')).autoUpdater;updater.checkForUpdates=async()=>null;
  updater.quitAndInstall=()=>{globalThis.handoverOrder.push('installer');globalThis.installerHandedOff=true;};globalThis.testUpdater=updater;
 }
 if(process.env.AYA_TEST_FAIL_ORDINARY_ANNOUNCEMENT==='1'){
  const {PtyHostClient}=require(path.join(root,'dist-electron/pty-host-client.js'));
  PtyHostClient.prototype.announceOrdinaryQuit=async function(){require('node:fs').writeFileSync(process.env.AYA_TEST_ORDINARY_RESULT,'failed');return false;};
 }
 const offset=Number(process.env.AYA_TEST_DATE_OFFSET_MS||0);
 if(offset){const now=Date.now;Date.now=()=>now()+offset;}
 require(path.join(root,'dist-electron/main.js'));
 `);
 const app=await _electron.launch({args:[wrapper,`--user-data-dir=${seeded.userDataDir}`,...ciElectronFlags()],cwd:root,env:appEnv({...seeded,launchEnv:{...seeded.launchEnv,AYA_E2E_PTY_SHUTDOWN:'0',AYA_TEST_APP_ROOT:root,
  AYA_TEST_HANDOVER_CHOICE:String(choice),AYA_TEST_PLAIN_HOST:plainHost?'1':'0',AYA_TEST_PLAIN_NODE:process.execPath,AYA_TEST_PLAIN_RUNTIME:JSON.stringify({node:process.versions.node,electron:null}),
  AYA_TEST_BLOCK_DISPLAY:blockDisplay?'1':'0',AYA_TEST_DISPLAY_RELEASE:join(seeded.root,'release-display'),AYA_TEST_REAL_UPDATE:realUpdate?'1':'0',
  AYA_TEST_DATE_OFFSET_MS:String(dateOffsetMs),AYA_TEST_FAIL_ORDINARY_ANNOUNCEMENT:failOrdinaryAnnouncement?'1':'0',AYA_TEST_QUESTIONS_FILE:join(seeded.root,'handover-questions.json'),AYA_TEST_ORDINARY_RESULT:join(seeded.root,'ordinary-result'),
 }})});apps.push(app);
 return {app,window:await app.firstWindow()};
}
async function quit(app:ElectronApplication){apps.splice(apps.indexOf(app),1);await closeAndWait(app);}
const inventory=(home:string)=>JSON.parse(readFileSync(join(home,'pty-owner/record.json'),'utf8')) as {pid:number;panes:Array<{id:string;pid:number}>};
const identities=(home:string)=>inventory(home).panes.map(({id,pid})=>({id,pid})).sort((a,b)=>a.id.localeCompare(b.id));
async function prepare(app:ElectronApplication,budget?:number){
 return app.evaluate(async({ipcMain,BrowserWindow,dialog},{root,budget})=>{
  const require=process.getBuiltinModule('node:module').createRequire(root+'/package.json');
  const {PtyHostClient}=require(root+'/dist-electron/pty-host-client.js');
  const {HandoverDisplays}=require(root+'/dist-electron/pty-handover-display.js');
  const {PlannedUpdate}=require(root+'/dist-electron/pty-planned-update.js');
  const {confirmStoppingProcesses}=require(root+'/dist-electron/relaunch-notes.js');
  const {readCheckpoint}=require(root+'/dist-electron/pty-checkpoint-store.js');
  const {decodeCheckpointPayload}=require(root+'/dist-electron/pty-checkpoint-payload.js');
  const {expandRendererRows}=require(root+'/dist-electron/renderer-vt-checkpoint.js');
  const fs=require('fs'),path=require('path'),crypto=require('crypto');
  const client=(globalThis as unknown as {handoverMainClient:InstanceType<typeof PtyHostClient>}).handoverMainClient;if(!client)throw Error('actual main client was not captured');
  const displays=new HandoverDisplays(async()=>BrowserWindow.getAllWindows().find(w=>!w.isDestroyed())?.webContents??null,()=>{});
  ipcMain.removeHandler('pty-checkpoint:display');ipcMain.removeHandler('pty-checkpoint:display-ack');displays.register(ipcMain);
  if(budget){const ask=displays.ask.bind(displays);displays.ask=(id:string,_budget:number,deadline:number)=>ask(id,budget,deadline);}
  const original=displays.capture.bind(displays),views:Record<string,unknown>={};
  displays.capture=async(state:unknown)=>{
   const receipt=await original(state);
   for await(const part of readCheckpoint(path.join(process.env.AYA_HOME,'pty-handover-display'),receipt)){
    const dto=JSON.parse(decodeCheckpointPayload(part.data));const normal=dto.state.normal;
    const expanded=expandRendererRows(dto.state).normal;const text=expanded.lines.map((line:{data:string})=>{const b=Buffer.from(line.data,'base64');let s='';for(let x=0;x<b.length;x+=12){const cp=b.readUInt32LE(x)&0x1fffff;s+=cp?String.fromCodePoint(cp):' ';}return s;}).join('\n');
    views[part.id]={text,history:normal.state.ybase,viewport:normal.state.ydisp,lines:crypto.createHash('sha256').update(JSON.stringify(normal.lines)).digest('hex'),cut:dto.cutLines};
   }
   return receipt;
  };
  const project=JSON.parse(fs.readFileSync(path.join(process.env.AYA_HOME,'projects/e2e-proj.json'),'utf8'));
  const relaunch={file:path.join(process.env.AYA_HOME,'relaunch-notes.json'),panes:async(ids?:string[])=>project.tabs.filter((p:{id:string})=>!ids||ids.includes(p.id)),pid:(id:string)=>client.getPid(id),screen:(id:string)=>client.getBuffer(id),agentOf:async()=> 'custom',command:async()=>null,busy:async()=>false,foreground:async()=>null};
  const planned=new PlannedUpdate({host:client,displays,expected:()=>client.expectedHostIdentity('test'),confirmStop:(ids:string[]|undefined,action:string)=>confirmStoppingProcesses(relaunch,action,(text:string)=>dialog.showMessageBox({message:'Work in progress will stop',detail:text,buttons:['Restart terminals','Cancel'],cancelId:1}).then((r:{response:number})=>r.response===0),ids),log:()=>{}});
  const ok=await planned.prepare();
  (globalThis as unknown as {testPlanned:unknown}).testPlanned={planned,client,displays};
  return {ok,views};
 },{root,budget});
}
async function captureCurrent(app:ElectronApplication){
 // Prepare uses the real renderer capture IPC and freezes output again, so
 // hashes compare applied display state after an empty replay fence.
 const result=await prepare(app);
 await app.evaluate(async()=>{await (globalThis as unknown as {testPlanned:{planned:{abort():Promise<void>}}}).testPlanned.planned.abort();});
 return result;
}
async function history(window:Page){
 await window.evaluate(()=>window.aya.ptyWrite('tab-left',"i=0; while [ \"$i\" -lt 400 ]; do printf '\\033[31mHISTORY%04d\\033[0m\\n' \"$i\"; i=$((i+1)); done; printf 'CHECKPOINT_DONE\\n'\r"));
 await expect.poll(()=>window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('\r\nCHECKPOINT_DONE\r\n');
 const pane=visiblePane(window,'shell 1').getByTestId('xterm-host');await pane.hover();await window.mouse.wheel(0,-600);
}
for(const change of ['core','rules','version','runtime'])test(`a planned ${change} change keeps PIDs, actual renderer history and the scrolled viewport without a stops-work question`,async({seeded})=>{
 test.setTimeout(45000);const first=await launch(seeded,1,false,false,change==='runtime');await waitForShellReady(first.window);await history(first.window);
 const before=identities(seeded.ayaHome),owner=inventory(seeded.ayaHome).pid,hosts=hostPidsForHome(seeded.ayaHome);
 const captured=await prepare(first.app);expect(captured.ok).toBe(true);expect(Object.keys(captured.views)).toContain('tab-left');
 const left=captured.views['tab-left'] as {history:number;viewport:number};expect(left.history).toBeGreaterThan(300);expect(left.viewport).toBeLessThan(left.history);
 expect(await first.app.evaluate(()=> (globalThis as unknown as {handoverQuestions:unknown[]}).handoverQuestions)).toEqual([]);
 await quit(first.app);
 if(change==='core')appendFileSync(hostScript,'\n// planned core replacement test\n');
 else if(change==='rules')appendFileSync(rulesScript,'\n// rules-only update keeps the host\n');
 else if(change==='version'){const pkg=JSON.parse(packageBuilt.toString());pkg.version='99.0.0';writeFileSync(packageFile,JSON.stringify(pkg,null,2)+'\n');}
 const second=await launch(seeded);await expect(second.window.getByTestId('xterm-host').first()).toBeVisible();
 await expect.poll(()=>identities(seeded.ayaHome)).toEqual(before);expect(inventory(seeded.ayaHome).pid).toBe(owner);
 expect(hostPidsForHome(seeded.ayaHome)).toHaveLength(1);if(change==='core'||change==='runtime')expect(hostPidsForHome(seeded.ayaHome)[0]).not.toBe(hosts[0]);else expect(hostPidsForHome(seeded.ayaHome)[0]).toBe(hosts[0]);
 await expect(second.window.getByTestId('terminal-history-notice')).toHaveCount(0);
 expect(await second.app.evaluate(()=> (globalThis as unknown as {handoverQuestions:unknown[]}).handoverQuestions)).toEqual([]);
 const restored=await captureCurrent(second.app);expect(restored.views['tab-left']).toEqual(captured.views['tab-left']);
});
for(const yes of [false,true])test(`one ineligible process is asked alone before quitting, yes=${yes}`,async({seeded})=>{
 test.setTimeout(45000);
 appendFileSync(hostScript,`\nconst TestAdapter=require('./pty-owner-adapter').OwnerPty,oldFreeze=TestAdapter.prototype.freezeForHandover;TestAdapter.prototype.freezeForHandover=function(...args){if(this.pane.id==='tab-right')throw Error('test ineligible process');return oldFreeze.apply(this,args);};\n`);
 const first=await launch(seeded,yes?0:1);await waitForShellReady(first.window);await expect.poll(()=>inventory(seeded.ayaHome).panes.length).toBe(2);
 const before=identities(seeded.ayaHome),captured=await prepare(first.app);expect(captured.ok).toBe(yes);
 const questions=await first.app.evaluate(()=> (globalThis as unknown as {handoverQuestions:Array<{detail:string}>}).handoverQuestions);
 expect(questions).toHaveLength(1);expect(questions[0].detail).toContain('shell 2');expect(questions[0].detail).not.toContain('shell 1');
 if(!yes){expect(identities(seeded.ayaHome)).toEqual(before);expect(readdirSync(seeded.ayaHome).filter(name=>/^pty-handover\.[a-f0-9]{64}\.json$/.test(name))).toHaveLength(0);await first.window.evaluate(()=>window.aya.ptyWrite('tab-left',"printf 'AFTER_CANCEL\\n'\r"));await expect.poll(()=>first.window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('AFTER_CANCEL\r\n');return;}
 await quit(first.app);writeFileSync(hostScript,built);const second=await launch(seeded);await waitForShellReady(second.window);
 await expect.poll(()=>identities(seeded.ayaHome).length).toBe(2);const after=identities(seeded.ayaHome);
 expect(after.find(p=>p.id==='tab-left')?.pid).toBe(before.find(p=>p.id==='tab-left')?.pid);expect(after.find(p=>p.id==='tab-right')?.pid).not.toBe(before.find(p=>p.id==='tab-right')?.pid);
 expect(await second.app.evaluate(()=> (globalThis as unknown as {handoverQuestions:unknown[]}).handoverQuestions)).toEqual([]);
});


test('a missing renderer moves without a question and rebuilds its first display from ordered replay',async({seeded})=>{
 test.setTimeout(45000);const first=await launch(seeded);await waitForShellReady(first.window);
 const projectFile=join(seeded.ayaHome,'projects/e2e-proj.json'),project=JSON.parse(readFileSync(projectFile,'utf8'));
 project.tabs.push({id:'deferred',presetId:'shell',name:'Deferred'});writeFileSync(projectFile,JSON.stringify(project));
 await expect(first.window.locator('.aya-sidebar-row[data-terminal-name="Deferred"]')).toBeVisible();
 await expect(first.window.locator('.aya-pane[data-terminal-id="deferred"]')).toHaveCount(0);
 const release=join(seeded.root,'release-deferred');
 const command=`/bin/sh -c 'stty -echo; echo DEFERRED_BEFORE; while [ ! -f "${release}" ]; do sleep .01; done; echo DEFERRED_BETWEEN; while IFS= read -r line; do printf "R:%s\\n" "$line"; done'`;
 await first.window.evaluate(({command,cwd})=>window.aya.ptySpawn({ptyId:'deferred',command,cwd,cols:80,rows:24}),{command,cwd:seeded.projectDir});
 await expect.poll(()=>first.window.evaluate(()=>window.aya.ptyBuffer('deferred'))).toContain('DEFERRED_BEFORE');
 const before=identities(seeded.ayaHome),captured=await prepare(first.app);expect(captured.ok).toBe(true);expect(captured.views).not.toHaveProperty('deferred');
 await quit(first.app);appendFileSync(hostScript,'\n// missing renderer handover test\n');writeFileSync(release,'go');
 const second=await launch(seeded);await expect(second.window.getByTestId('xterm-host').first()).toBeVisible();
 await expect.poll(()=>second.window.evaluate(()=>window.aya.ptyBuffer('deferred'))).toContain('DEFERRED_BETWEEN');
 await second.window.locator('.aya-sidebar-row[data-terminal-name="Deferred"]').click();
 await expect(second.window.locator('.aya-pane[data-terminal-id="deferred"]').getByTestId('terminal-history-notice')).toContainText('History from replay');
 const applied=await captureCurrent(second.app),replay=(applied.views['deferred'] as {text:string}).text;
 expect(replay.split('DEFERRED_BETWEEN').length-1).toBe(1);expect(replay.indexOf('DEFERRED_BEFORE')).toBeLessThan(replay.indexOf('DEFERRED_BETWEEN'));
 expect(identities(seeded.ayaHome)).toEqual(before);expect(readFileSync(join(seeded.ayaHome,'diagnostics.log'),'utf8')).toContain('handover-history-from-replay');
 expect(await second.app.evaluate(()=> (globalThis as unknown as {handoverQuestions:unknown[]}).handoverQuestions)).toEqual([]);
});

test('an unexpected refusal after relaunch asks there; Cancel keeps the old host, PIDs and red dot',async({seeded})=>{
 test.setTimeout(45000);const first=await launch(seeded);await waitForShellReady(first.window);
 const before=identities(seeded.ayaHome),hosts=hostPidsForHome(seeded.ayaHome);expect((await prepare(first.app)).ok).toBe(true);await quit(first.app);
 const escrow=join(seeded.ayaHome,'pty-handover-core'),nonce=readdirSync(escrow)[0],part=join(escrow,nonce,'0.json'),bytes=readFileSync(part);bytes[bytes.length-1]^=1;writeFileSync(part,bytes);
 appendFileSync(hostScript,'\n// refused planned handover test\n');const second=await launch(seeded,1);
 await expect(second.window.getByTestId('xterm-host').first()).toBeVisible();
 const questions=await second.app.evaluate(()=> (globalThis as unknown as {handoverQuestions:Array<{detail:string}>}).handoverQuestions);
 expect(questions).toHaveLength(1);expect(questions[0].detail).toContain('planned handover could not complete');
 expect(hostPidsForHome(seeded.ayaHome)).toEqual(hosts);expect(identities(seeded.ayaHome)).toEqual(before);
 expect(await second.app.evaluate(({Menu})=>!Menu.getApplicationMenu()?.getMenuItemById('restart-aya')?.icon?.isEmpty())).toBe(true);
 await second.window.evaluate(()=>window.aya.ptyWrite('tab-left',"printf 'AFTER_REFUSAL\\n'\r"));await expect.poll(()=>second.window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('AFTER_REFUSAL\r\n');
});


test('trimmed replay resets the captured display once and explains history loss without stopping the pane',async({seeded})=>{
 test.setTimeout(45000);const first=await launch(seeded);await waitForShellReady(first.window);await history(first.window);
 const before=identities(seeded.ayaHome);expect((await prepare(first.app)).ok).toBe(true);await quit(first.app);appendFileSync(hostScript,'\n// trimmed replay handover test\n');
 const second=await launch(seeded,1,true);await expect(second.window.getByTestId('xterm-host').first()).toBeVisible();
 await expect.poll(()=>second.app.evaluate(()=> (globalThis as unknown as {handoverDisplayWaiting:boolean}).handoverDisplayWaiting)).toBe(true);
 await second.window.evaluate(()=>window.aya.ptyWrite('tab-left',"i=0; while [ \"$i\" -lt 40000 ]; do printf 'FLOOD%06d:%060s\\n' \"$i\" x; i=$((i+1)); done; printf 'FLOOD_DONE\\n'\r"));
 await expect.poll(()=>second.window.evaluate(()=>window.aya.ptyBuffer('tab-left')),{timeout:15000}).toContain('\r\nFLOOD_DONE\r\n');
 const calls=await second.app.evaluate(()=> (globalThis as unknown as {inputCalls:number}).inputCalls);
 const left=visiblePane(second.window,'shell 1').getByTestId('xterm-host');await left.click();await second.window.keyboard.insertText('must not be delivered');
 await left.locator('.xterm-helper-textarea').evaluate(textarea=>{const data=new DataTransfer();data.setData('text/plain','no paste\n');textarea.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
 await second.window.evaluate(()=>window.aya.ptyBuffer('tab-left'));
 expect(await second.app.evaluate(()=> (globalThis as unknown as {inputCalls:number}).inputCalls)).toBe(calls);
 writeFileSync(join(seeded.root,'release-display'),'go');
 await expect(visiblePane(second.window,'shell 1').getByTestId('terminal-history-notice')).toContainText('History from replay');
 const applied=await captureCurrent(second.app),text=(applied.views['tab-left'] as {text:string}).text;
 expect(text.split('FLOOD_DONE').length-1).toBe(1);expect(text).not.toContain('CHECKPOINT_DONE');expect(identities(seeded.ayaHome)).toEqual(before);
 expect(readFileSync(join(seeded.ayaHome,'pty-events.log'),'utf8')).toContain('checkpoint boundary unavailable');
 expect(await second.app.evaluate(()=> (globalThis as unknown as {handoverQuestions:unknown[]}).handoverQuestions)).toEqual([]);
});


test('the real Restart to update IPC announces handover and preserves a foreground command without asking to stop it',async({seeded})=>{
 test.setTimeout(45000);const first=await launch(seeded,1,false,true);await waitForShellReady(first.window);
 await first.window.evaluate(()=>window.aya.ptyWrite('tab-left',"printf 'ACTUAL_UPDATE_ROUTE\\n'; sleep 1000\r"));
 await expect.poll(()=>first.window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('ACTUAL_UPDATE_ROUTE\r\n');
 const before=identities(seeded.ayaHome),shell=before.find(p=>p.id==='tab-left')!.pid;
 const foreground=async(app:ElectronApplication)=>app.evaluate((_electron,pid)=>Number(process.getBuiltinModule('node:child_process').execFileSync('ps',['-o','tpgid=','-p',String(pid)],{encoding:'utf8'}).trim()),shell);
 await expect.poll(()=>foreground(first.app)).not.toBe(shell);const command=await foreground(first.app);
 await first.app.evaluate(({app})=>{(globalThis as unknown as {testUpdater:{emit:(event:string,data:unknown)=>void}}).testUpdater.emit('update-downloaded',{version:app.getVersion()});});
 await first.window.evaluate(()=>window.aya.installUpdate());
 const tickets=readdirSync(seeded.ayaHome).filter(name=>/^pty-handover\.[a-f0-9]{64}\.json$/.test(name));
 expect(tickets).toHaveLength(1);expect(JSON.parse(readFileSync(join(seeded.ayaHome,tickets[0]),'utf8'))).toMatchObject({format:2,purpose:'planned-update'});
 expect(await first.app.evaluate(()=> (globalThis as unknown as {installerHandedOff:boolean}).installerHandedOff)).toBe(true);
 expect(await first.app.evaluate(()=> (globalThis as unknown as {handoverQuestions:unknown[]}).handoverQuestions)).toEqual([]);
 await quit(first.app);appendFileSync(hostScript,'\n// actual installer planned handover test\n');const second=await launch(seeded);
 await expect(visiblePane(second.window,'shell 1').locator('.xterm-rows')).toContainText('ACTUAL_UPDATE_ROUTE');
 expect(identities(seeded.ayaHome)).toEqual(before);expect(await foreground(second.app)).toBe(command);
 expect(await second.app.evaluate(()=> (globalThis as unknown as {handoverQuestions:unknown[]}).handoverQuestions)).toEqual([]);
});


test('a build installed by hand hands panes over after the planned-update window has elapsed',async({seeded})=>{
 test.setTimeout(45000);const first=await launch(seeded);await waitForShellReady(first.window);
 await first.window.evaluate(()=>window.aya.ptyWrite('tab-left',"printf 'MANUAL_INSTALL_ROUTE\\n'; sleep 1000\r"));
 await expect.poll(()=>first.window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('MANUAL_INSTALL_ROUTE\r\n');
 const before=identities(seeded.ayaHome),owner=inventory(seeded.ayaHome).pid;
 // The new build lands while the old one runs, as a copy into /Applications does.
 appendFileSync(hostScript,'\n// manual install planned handover test\n');
 const proc=first.app.process(),exited=new Promise<void>(resolve=>proc.once('exit',()=>resolve()));
 apps.splice(apps.indexOf(first.app),1);await first.app.evaluate(({app})=>app.quit());await exited;
 expect(readFileSync(join(seeded.ayaHome,'diagnostics.log'),'utf8')).toContain('"ev":"installed-build-quit","handover":"prepared"');
 const ticketName=readdirSync(seeded.ayaHome).find(name=>/^pty-handover\.[a-f0-9]{64}\.json$/.test(name));expect(ticketName).toBeTruthy();
 expect(JSON.parse(readFileSync(join(seeded.ayaHome,ticketName!),'utf8'))).toMatchObject({format:2,purpose:'ordinary-quit',deadline:null});
 const second=await launch(seeded,1,false,false,false,121000);
 await expect(visiblePane(second.window,'shell 1').locator('.xterm-rows')).toContainText('MANUAL_INSTALL_ROUTE');
 expect(identities(seeded.ayaHome)).toEqual(before);expect(inventory(seeded.ayaHome).pid).toBe(owner);
 expect(hostPidsForHome(seeded.ayaHome)).toHaveLength(1);
 expect(await second.app.evaluate(()=> (globalThis as unknown as {handoverQuestions:unknown[]}).handoverQuestions)).toEqual([]);
});
test('a failed manual-install announcement does not ask the user to stop panes',async({seeded})=>{
 test.setTimeout(30000);const first=await launch(seeded,1,false,false,false,0,true);await waitForShellReady(first.window);
 await first.window.evaluate(()=>window.aya.ptyWrite('tab-left',"printf 'KEPT_AFTER_ANNOUNCEMENT_FAILURE\\n'\r"));
 await expect.poll(()=>first.window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('KEPT_AFTER_ANNOUNCEMENT_FAILURE');
 const before=identities(seeded.ayaHome);
 appendFileSync(hostScript,'\n// failed ordinary handover announcement test\n');
 const exited=new Promise<void>(resolve=>first.app.process().once('exit',()=>resolve()));apps.splice(apps.indexOf(first.app),1);await first.app.evaluate(({app})=>app.quit());await exited;
 expect(readFileSync(join(seeded.root,'ordinary-result'),'utf8')).toBe('failed');
 expect(existsSync(join(seeded.root,'handover-questions.json'))?JSON.parse(readFileSync(join(seeded.root,'handover-questions.json'),'utf8')):[]).toEqual([]);
 expect(identities(seeded.ayaHome)).toEqual(before);
});
test('two replacements retain an unmounted ended pane until its real view applies replay',async({seeded})=>{
 test.setTimeout(45000);const first=await launch(seeded);await waitForShellReady(first.window);
 const projectFile=join(seeded.ayaHome,'projects/e2e-proj.json'),project=JSON.parse(readFileSync(projectFile,'utf8'));
 project.tabs.push({id:'ended-deferred',presetId:'shell',name:'Ended deferred'});writeFileSync(projectFile,JSON.stringify(project));
 await expect(first.window.locator('.aya-sidebar-row[data-terminal-name="Ended deferred"]')).toBeVisible();
 const release=join(seeded.root,'release-ended-deferred');
 const command=`exec /bin/sh -c 'stty -echo; echo ENDED_BEFORE; while [ ! -f "${release}" ]; do sleep .01; done; echo LAST_SUFFIX; exit 23'`;
 await first.window.evaluate(({command,cwd})=>window.aya.ptySpawn({ptyId:'ended-deferred',command,cwd,cols:80,rows:24}),{command,cwd:seeded.projectDir});
 await expect.poll(()=>first.window.evaluate(()=>window.aya.ptyBuffer('ended-deferred'))).toContain('ENDED_BEFORE');
 const owner=inventory(seeded.ayaHome).pid;
 expect((await prepare(first.app)).ok).toBe(true);await quit(first.app);appendFileSync(hostScript,'\n// first ended-pane replacement\n');
 const second=await launch(seeded);await expect(second.window.getByTestId('xterm-host').first()).toBeVisible();writeFileSync(release,'go');
 await expect.poll(()=>second.window.evaluate(()=>window.aya.ptyBuffer('ended-deferred'))).toContain('LAST_SUFFIX');
 // B4 retains the native outcome until main observes it. An unmounted
 // restored view has not received its exit yet; the next checkpoint carries it.
 await expect.poll(()=>inventory(seeded.ayaHome).panes.find(p=>p.id==='ended-deferred')?.exited).toBe(true);
 expect((await prepare(second.app)).ok).toBe(true);await quit(second.app);appendFileSync(hostScript,'\n// second ended-pane replacement\n');
 const third=await launch(seeded);await expect(third.window.getByTestId('xterm-host').first()).toBeVisible();
 await third.window.locator('.aya-sidebar-row[data-terminal-name="Ended deferred"]').click();
 const pane=third.window.locator('.aya-pane[data-terminal-id="ended-deferred"]');
 await expect(pane.getByTestId('terminal-history-notice')).toContainText('History from replay');
 await expect(pane.locator('.xterm-rows')).toContainText('ENDED_BEFORE');
 await expect(pane.locator('.xterm-rows')).toContainText('LAST_SUFFIX');
 await expect(pane.locator('.xterm-rows')).toContainText('process exited with code 23');
 const displayed=await pane.locator('.xterm-rows').textContent();expect(displayed?.split('LAST_SUFFIX').length).toBe(2);
 expect(inventory(seeded.ayaHome).pid).toBe(owner);expect(inventory(seeded.ayaHome).panes.some(p=>p.id==='ended-deferred')).toBe(false);
 expect(await third.app.evaluate(()=> (globalThis as unknown as {handoverQuestions:unknown[]}).handoverQuestions)).toEqual([]);
});

test('explicit restart before display lookup completes retires the old continuation and accepts new output and input',async({seeded})=>{
 const first=await launch(seeded);await waitForShellReady(first.window);
 await first.window.evaluate(()=>window.aya.ptyWrite('tab-left',"printf 'BEFORE_EARLY_RESTART\\n'\r"));
 await expect(visiblePane(first.window,'shell 1').locator('.xterm-rows')).toContainText('BEFORE_EARLY_RESTART');
 expect((await prepare(first.app)).ok).toBe(true);await quit(first.app);
 appendFileSync(hostScript,'\n// early explicit restart handover test\n');
 const second=await launch(seeded,0,true);
 await expect.poll(()=>second.app.evaluate(()=>(globalThis as unknown as {handoverDisplayWaiting:boolean}).handoverDisplayWaiting)).toBe(true);
 const oldPid=inventory(seeded.ayaHome).panes.find((p:{id:string})=>p.id==='tab-left').pid;
 await second.app.evaluate(({ipcMain})=>{
  const handlers=ipcMain as unknown as {_invokeHandlers:Map<string,(...args:unknown[])=>unknown>};
  const spawn=handlers._invokeHandlers.get('pty:spawn')!;(globalThis as unknown as {restartSpawns:number}).restartSpawns=0;
  ipcMain.removeHandler('pty:spawn');ipcMain.handle('pty:spawn',(event,req)=>{if(req.ptyId==='tab-left')(globalThis as unknown as {restartSpawns:number}).restartSpawns++;return spawn(event,req);});
 });
 await second.window.locator('.aya-sidebar-row[data-terminal-id="tab-left"]').click({button:'right'});
 await second.window.getByRole('button',{name:'Restart terminal',exact:true}).click();
 await expect.poll(()=>{const pane=inventory(seeded.ayaHome).panes.find((p:{id:string})=>p.id==='tab-left');return !!pane&&pane.pid!==oldPid;}).toBe(true);
 const freshPid=inventory(seeded.ayaHome).panes.find((p:{id:string})=>p.id==='tab-left').pid;
 await second.window.evaluate(()=>window.aya.ptyWrite('tab-left',"printf 'AFTER_EXPLICIT_RESTART\\n'\r"));
 const pane=visiblePane(second.window,'shell 1');
 await expect(pane.locator('.xterm-rows')).toContainText('AFTER_EXPLICIT_RESTART',{timeout:5000});
 await pane.click();await second.window.keyboard.type("printf 'UI_AFTER_%s\\n' RESTART");await second.window.keyboard.press('Enter');
 await expect.poll(()=>second.window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('UI_AFTER_RESTART');
 writeFileSync(join(seeded.root,'release-display'),'go');
 expect(await second.window.evaluate(()=>window.aya.handoverDisplay('tab-left'))).toBe(null);
 await second.window.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 await expect(pane.locator('.xterm-rows')).toContainText('AFTER_EXPLICIT_RESTART');
 expect(await second.app.evaluate(()=>(globalThis as unknown as {restartSpawns:number}).restartSpawns)).toBe(1);
 expect(inventory(seeded.ayaHome).panes.find((p:{id:string})=>p.id==='tab-left').pid).toBe(freshPid);
});

test('explicit restart of an ended pane with an unapplied acknowledgement starts a fresh live session',async({seeded})=>{
 const first=await launch(seeded);await waitForShellReady(first.window);
 const release=join(seeded.root,'release-before-ended-restart');
 const command=`exec /bin/sh -c 'echo BEFORE_ENDED_RESTART; while [ ! -f "${release}" ]; do sleep .01; done; echo ENDED_RESTART_SUFFIX; exit 23'\r`;
 await first.window.evaluate(command=>window.aya.ptyWrite('tab-left',command),command);
 await expect.poll(()=>first.window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('BEFORE_ENDED_RESTART');
 expect((await prepare(first.app)).ok).toBe(true);await quit(first.app);
 appendFileSync(hostScript,'\n// ended explicit restart handover test\n');
 const second=await launch(seeded,0,true);
 await expect.poll(()=>second.app.evaluate(()=>(globalThis as unknown as {handoverDisplayWaiting:boolean}).handoverDisplayWaiting)).toBe(true);
 await second.app.evaluate(({ipcMain})=>{ipcMain.removeHandler('pty-checkpoint:display-ack');ipcMain.handle('pty-checkpoint:display-ack',()=>false);});
 const before=inventory(seeded.ayaHome),oldPid=before.panes.find((p:{id:string})=>p.id==='tab-left').pid;
 writeFileSync(join(seeded.root,'release-display'),'go');
 const pane=visiblePane(second.window,'shell 1');await expect(pane.locator('.xterm-rows')).toContainText('BEFORE_ENDED_RESTART');
 writeFileSync(release,'go');await expect(pane.locator('.xterm-rows')).toContainText('process exited with code 23');
 expect(await second.window.evaluate(()=>window.aya.handoverDisplay('tab-left'))).not.toBe(null);
 await second.window.locator('.aya-sidebar-row[data-terminal-id="tab-left"]').click({button:'right'});
 await second.window.getByRole('button',{name:'Restart terminal',exact:true}).click();
 await expect.poll(()=>{const p=inventory(seeded.ayaHome).panes.find((p:{id:string})=>p.id==='tab-left');return !!p&&p.pid!==oldPid;}).toBe(true);
 await pane.click();await second.window.keyboard.type("printf 'FRESH_ENDED_%s\\n' RESTART");await second.window.keyboard.press('Enter');
 await expect.poll(()=>second.window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('FRESH_ENDED_RESTART');
 await expect(pane.locator('.xterm-rows')).toContainText('FRESH_ENDED_RESTART');
 expect(await second.window.evaluate(()=>window.aya.handoverDisplay('tab-left'))).toBe(null);
 expect(inventory(seeded.ayaHome).pid).toBe(before.pid);
 expect(inventory(seeded.ayaHome).panes.find((p:{id:string})=>p.id==='tab-right').pid).toBe(before.panes.find((p:{id:string})=>p.id==='tab-right').pid);
});


test('successor restore refusal after detach asks in the new main; Cancel leaves live panes disconnected without respawning',async({seeded})=>{
 test.setTimeout(45000);const first=await launch(seeded);await waitForShellReady(first.window);
 const before=identities(seeded.ayaHome),owner=inventory(seeded.ayaHome).pid,hosts=hostPidsForHome(seeded.ayaHome);
 expect((await prepare(first.app)).ok).toBe(true);await quit(first.app);
 appendFileSync(hostScript,`\nif(process.env.AYA_PTY_CHECKPOINT_FD==='4')require('./pty-core').restorePtyCorePane=async()=>{throw Error('test successor restore refusal after detach');};\n`);
 const second=await launch(seeded,1);await expect(second.window.getByTestId('xterm-host').first()).toBeVisible();
 const questions=await second.app.evaluate(()=>(globalThis as unknown as {handoverQuestions:Array<{detail:string}>}).handoverQuestions);
 expect(questions).toHaveLength(1);expect(questions[0].detail).toContain('planned handover could not complete');
 // A later inventory-only host may serve disconnected metadata. Neither it
 // nor a renderer attach may create a replacement child after Cancel.
 expect(hostPidsForHome(seeded.ayaHome).some(pid=>hosts.includes(pid))).toBe(false);
 const failed=readFileSync(join(seeded.ayaHome,'pty-events.log'),'utf8').trim().split('\n').map(line=>JSON.parse(line)).find(event=>event.ev==='owner-start-failed'&&event.error?.includes('test successor restore refusal after detach'));
 expect(failed).toBeTruthy();
 expect(await second.app.evaluate((_electron,pid)=>{try{process.kill(pid,0);return false;}catch{return true;}},failed.pid)).toBe(true);
 expect(await second.app.evaluate((_electron,pids)=>pids.every(pid=>{try{process.kill(pid,0);return false;}catch{return true;}}),hosts)).toBe(true);
 expect(inventory(seeded.ayaHome).pid).toBe(owner);expect(identities(seeded.ayaHome)).toEqual(before);
 expect(await second.app.evaluate((_electron,pids)=>pids.every(pid=>{try{process.kill(pid,0);return true;}catch{return false;}}),[owner,...before.map(p=>p.pid)])).toBe(true);
 const terminal=visiblePane(second.window,'shell 1').getByTestId('xterm-host');
 await expect(terminal).toContainText('Input is disabled while disconnected');
 await terminal.click();await second.window.keyboard.type('not delivered');await second.window.keyboard.press('Enter');
 await terminal.locator('.xterm-helper-textarea').evaluate(textarea=>{const data=new DataTransfer();data.setData('text/plain','not pasted\n');textarea.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
 expect(await second.app.evaluate(()=>(globalThis as unknown as {handoverWrites:unknown[]}).handoverWrites)).toEqual([]);
 expect(await second.app.evaluate(()=>(globalThis as unknown as {handoverSpawns:Array<{attachOnly?:boolean;attachIfReused?:boolean}>}).handoverSpawns.filter(req=>!req.attachOnly&&!req.attachIfReused))).toEqual([]);
 expect(identities(seeded.ayaHome)).toEqual(before);
 expect(readFileSync(join(seeded.ayaHome,'pty-events.log'),'utf8')).toContain('test successor restore refusal after detach');
});

test('a capped renderer capture restores with a visible oldest-history-cut notice',async({seeded})=>{
 test.setTimeout(45000);const first=await launch(seeded);await waitForShellReady(first.window);await history(first.window);
 const before=identities(seeded.ayaHome),captured=await prepare(first.app,65536);expect(captured.ok).toBe(true);
 const cut=(captured.views['tab-left'] as {cut:number}).cut;expect(cut).toBeGreaterThan(0);
 await quit(first.app);appendFileSync(hostScript,'\n// capped renderer capture restoration\n');const second=await launch(seeded);
 await expect(visiblePane(second.window,'shell 1').getByTestId('terminal-history-notice')).toHaveText(`${cut} oldest history lines were cut during the update.`);
 expect(identities(seeded.ayaHome)).toEqual(before);
 expect(await second.app.evaluate(()=>(globalThis as unknown as {handoverQuestions:unknown[]}).handoverQuestions)).toEqual([]);
 expect(readFileSync(join(seeded.ayaHome,'diagnostics.log'),'utf8')).toContain('handover-history-cut');
});

for(const yes of [false,true])test(`real Restart to update asks about the ineligible pane before installer handoff, yes=${yes}`,async({seeded})=>{
 test.setTimeout(45000);
 appendFileSync(hostScript,`\nconst UpdateTestAdapter=require('./pty-owner-adapter').OwnerPty,updateFreeze=UpdateTestAdapter.prototype.freezeForHandover;UpdateTestAdapter.prototype.freezeForHandover=function(...args){if(this.pane.id==='tab-right')throw Error('test update route ineligible process');return updateFreeze.apply(this,args);};\n`);
 const first=await launch(seeded,yes?0:1,false,true);await waitForShellReady(first.window);await expect.poll(()=>inventory(seeded.ayaHome).panes.length).toBe(2);
 const before=identities(seeded.ayaHome);
 await first.app.evaluate(({app})=>{(globalThis as unknown as {testUpdater:{emit:(event:string,data:unknown)=>void}}).testUpdater.emit('update-downloaded',{version:app.getVersion()});});
 await first.window.evaluate(()=>window.aya.installUpdate());
 const result=await first.app.evaluate(()=>{const g=globalThis as unknown as {handoverQuestions:Array<{message:string;detail:string}>;handoverOrder:string[];installerHandedOff?:boolean};return{questions:g.handoverQuestions,order:g.handoverOrder,installed:!!g.installerHandedOff};});
 expect(result.questions).toHaveLength(1);expect(result.questions[0].message).toBe('Work in progress will stop');
 expect(result.questions[0].detail).toContain('Restarting to update');expect(result.questions[0].detail).toContain('shell 2');expect(result.questions[0].detail).not.toContain('shell 1');
 expect(result.order).toEqual(yes?['question','installer']:['question']);expect(result.installed).toBe(yes);
 expect(readdirSync(seeded.ayaHome).filter(name=>/^pty-handover\.[a-f0-9]{64}\.json$/.test(name))).toHaveLength(yes?1:0);expect(identities(seeded.ayaHome)).toEqual(before);
 if(!yes){await first.window.evaluate(()=>window.aya.ptyWrite('tab-right',"printf 'UPDATE_CANCEL_ALIVE\\n'\r"));await expect.poll(()=>first.window.evaluate(()=>window.aya.ptyBuffer('tab-right'))).toContain('UPDATE_CANCEL_ALIVE\r\n');}
});
