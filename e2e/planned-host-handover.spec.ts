import {appendFileSync,readFileSync,writeFileSync,existsSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {_electron,type ElectronApplication,type Page} from "@playwright/test";
import {test,expect,hostPidsForHome,closeAndWait,ciElectronFlags} from "./fixtures";
import {appEnv,type SeededEnv} from "./helpers/seed";
import {waitForShellReady,visiblePane} from "./helpers/terminal";
const root=join(__dirname,'..'),hostScript=join(root,'dist-electron/pty-host.js'),built=readFileSync(hostScript);
const apps:ElectronApplication[]=[];
test.afterEach(async()=>{writeFileSync(hostScript,built);for(const app of apps.splice(0))await closeAndWait(app);});
async function launch(seeded:SeededEnv,choice=1,blockDisplay=false,realUpdate=false){
 const wrapper=join(seeded.root,'handover-main.js');
 const updater=realUpdate?`Object.defineProperty(electron.app,'isPackaged',{get:()=>true});process.env.APPIMAGE='test-only-appimage';const updater=require(${JSON.stringify(join(root,'node_modules/electron-updater'))}).autoUpdater;updater.checkForUpdates=async()=>null;updater.quitAndInstall=()=>{globalThis.installerHandedOff=true;};globalThis.testUpdater=updater;`:'';

 const delayed=blockDisplay?`const fs=require('fs'),original=electron.ipcMain.handle.bind(electron.ipcMain);globalThis.handoverDisplayWaiting=false;globalThis.inputCalls=0;electron.ipcMain.handle=(channel,handler)=>original(channel,async(event,...args)=>{if(channel==='pty:write')globalThis.inputCalls++;if(channel==='pty-checkpoint:display'&&args[0]==='tab-left'){globalThis.handoverDisplayWaiting=true;const deadline=Date.now()+15000;while(!fs.existsSync(${JSON.stringify(join(seeded.root,'release-display'))})){if(Date.now()>deadline)throw Error('test display gate expired');await new Promise(r=>setTimeout(r,2));}}return handler(event,...args);});`:'';

 writeFileSync(wrapper,`const electron=require('electron');globalThis.handoverQuestions=[];electron.dialog.showMessageBox=async(...args)=>{const options=args.at(-1);globalThis.handoverQuestions.push(options);return{response:${choice},checkboxChecked:false};};${delayed}${updater}require(${JSON.stringify(join(root,'dist-electron/main.js'))});`);
 const app=await _electron.launch({args:[wrapper,`--user-data-dir=${seeded.userDataDir}`,...ciElectronFlags()],cwd:root,env:appEnv({...seeded,launchEnv:{...seeded.launchEnv,AYA_E2E_PTY_SHUTDOWN:'0'}})});apps.push(app);
 return {app,window:await app.firstWindow()};
}
async function quit(app:ElectronApplication){apps.splice(apps.indexOf(app),1);await closeAndWait(app);}
const inventory=(home:string)=>JSON.parse(readFileSync(join(home,'pty-owner/record.json'),'utf8')) as {pid:number;panes:Array<{id:string;pid:number}>};
const identities=(home:string)=>inventory(home).panes.map(({id,pid})=>({id,pid})).sort((a,b)=>a.id.localeCompare(b.id));
async function prepare(app:ElectronApplication){
 return app.evaluate(async({ipcMain,BrowserWindow,dialog},{root})=>{
  const require=process.getBuiltinModule('node:module').createRequire(root+'/package.json');
  const {PtyHostClient}=require(root+'/dist-electron/pty-host-client.js');
  const {HandoverDisplays}=require(root+'/dist-electron/pty-handover-display.js');
  const {PlannedUpdate}=require(root+'/dist-electron/pty-planned-update.js');
  const {confirmStoppingProcesses}=require(root+'/dist-electron/relaunch-notes.js');
  const {readCheckpoint}=require(root+'/dist-electron/pty-checkpoint-store.js');
  const {decodeCheckpointPayload}=require(root+'/dist-electron/pty-checkpoint-payload.js');
  const {expandRendererRows}=require(root+'/dist-electron/renderer-vt-checkpoint.js');
  const fs=require('fs'),path=require('path'),crypto=require('crypto');
  const client=new PtyHostClient(root+'/dist-electron/pty-host.js');
  const displays=new HandoverDisplays(async()=>BrowserWindow.getAllWindows().find(w=>!w.isDestroyed())?.webContents??null,()=>{});
  ipcMain.removeHandler('pty-checkpoint:display');ipcMain.removeHandler('pty-checkpoint:display-ack');displays.register(ipcMain);
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
 },{root});
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
test('a planned core change keeps PIDs, actual renderer history and the scrolled viewport without a stops-work question',async({seeded})=>{
 test.setTimeout(45000);const first=await launch(seeded);await waitForShellReady(first.window);await history(first.window);
 const before=identities(seeded.ayaHome),owner=inventory(seeded.ayaHome).pid,hosts=hostPidsForHome(seeded.ayaHome);
 const captured=await prepare(first.app);expect(captured.ok).toBe(true);expect(Object.keys(captured.views)).toContain('tab-left');
 const left=captured.views['tab-left'] as {history:number;viewport:number};expect(left.history).toBeGreaterThan(300);expect(left.viewport).toBeLessThan(left.history);
 expect(await first.app.evaluate(()=> (globalThis as unknown as {handoverQuestions:unknown[]}).handoverQuestions)).toEqual([]);
 await quit(first.app);appendFileSync(hostScript,'\n// planned core replacement test\n');
 const second=await launch(seeded);await expect(second.window.getByTestId('xterm-host').first()).toBeVisible();
 await expect.poll(()=>identities(seeded.ayaHome)).toEqual(before);expect(inventory(seeded.ayaHome).pid).toBe(owner);
 expect(hostPidsForHome(seeded.ayaHome)).toHaveLength(1);expect(hostPidsForHome(seeded.ayaHome)[0]).not.toBe(hosts[0]);
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
 if(!yes){expect(identities(seeded.ayaHome)).toEqual(before);expect(existsSync(join(seeded.ayaHome,'pty-handover.json'))).toBe(false);await first.window.evaluate(()=>window.aya.ptyWrite('tab-left',"printf 'AFTER_CANCEL\\n'\r"));await expect.poll(()=>first.window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('\r\nAFTER_CANCEL\r\n');return;}
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
 await second.window.evaluate(()=>window.aya.ptyWrite('tab-left',"printf 'AFTER_REFUSAL\\n'\r"));await expect.poll(()=>second.window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('\r\nAFTER_REFUSAL\r\n');
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
 await expect.poll(()=>first.window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('\r\nACTUAL_UPDATE_ROUTE\r\n');
 const before=identities(seeded.ayaHome),shell=before.find(p=>p.id==='tab-left')!.pid;
 const foreground=async(app:ElectronApplication)=>app.evaluate((_electron,pid)=>Number(process.getBuiltinModule('node:child_process').execFileSync('ps',['-o','tpgid=','-p',String(pid)],{encoding:'utf8'}).trim()),shell);
 await expect.poll(()=>foreground(first.app)).not.toBe(shell);const command=await foreground(first.app);
 await first.app.evaluate(({app})=>{(globalThis as unknown as {testUpdater:{emit:(event:string,data:unknown)=>void}}).testUpdater.emit('update-downloaded',{version:app.getVersion()});});
 await first.window.evaluate(()=>window.aya.installUpdate());
 expect(existsSync(join(seeded.ayaHome,'pty-handover.json'))).toBe(true);
 expect(await first.app.evaluate(()=> (globalThis as unknown as {installerHandedOff:boolean}).installerHandedOff)).toBe(true);
 expect(await first.app.evaluate(()=> (globalThis as unknown as {handoverQuestions:unknown[]}).handoverQuestions)).toEqual([]);
 await quit(first.app);appendFileSync(hostScript,'\n// actual installer planned handover test\n');const second=await launch(seeded);
 await expect(visiblePane(second.window,'shell 1').locator('.xterm-rows')).toContainText('ACTUAL_UPDATE_ROUTE');
 expect(identities(seeded.ayaHome)).toEqual(before);expect(await foreground(second.app)).toBe(command);
 expect(await second.app.evaluate(()=> (globalThis as unknown as {handoverQuestions:unknown[]}).handoverQuestions)).toEqual([]);
});
