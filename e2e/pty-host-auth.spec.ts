import {readFileSync,writeFileSync,unlinkSync,readdirSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {appEnv} from './helpers/seed';
import {test as base,expect,launchApp,launchE2eElectron,closeAndWait,hostPidsForHome,ciElectronFlags} from './fixtures';
import {waitForShellReady} from './helpers/terminal';
import {fireShortcut} from './helpers/shortcut';
import {envWithoutAya} from './helpers/env';
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const record=(home:string)=>JSON.parse(readFileSync(join(home,'pty-owner/record.json'),'utf8')) as {pid:number;instanceId:string;panes:Array<{id:string;pid:number;generation:number}>};
const test=base.extend({app:async({seeded},use)=>{const app=await launchApp({...seeded,launchEnv:{...seeded.launchEnv,AYA_E2E_PTY_SHUTDOWN:'0'}}),pid=app.process().pid!;await use(app);if(alive(pid))await closeAndWait(app);}});

test('ordinary relaunch proves continuity and a later JS crash recovers the original owner and panes',async({app,window,seeded})=>{
 await waitForShellReady(window);const before=record(seeded.ayaHome),old=hostPidsForHome(seeded.ayaHome);expect(old).toHaveLength(1);expect(existsSync(join(seeded.ayaHome,'pty-host-auth'))).toBe(false);
 await closeAndWait(app);expect(alive(old[0])).toBe(true);
 expect(readdirSync(seeded.ayaHome).filter(name=>/^pty-handover\.[a-f0-9]{64}\.json$/.test(name))).toHaveLength(1);
 mkdirSync(join(seeded.ayaHome,'pty-host-auth'),{mode:0o700});writeFileSync(join(seeded.ayaHome,'pty-host-auth/key'),Buffer.alloc(32,42),{mode:0o600});
 const next=await launchApp({...seeded,launchEnv:{...seeded.launchEnv,AYA_E2E_PTY_SHUTDOWN:'0'}});
 try{
  const view=await next.firstWindow();await waitForShellReady(view);
  expect(hostPidsForHome(seeded.ayaHome)).toEqual(old);expect(record(seeded.ayaHome).panes).toEqual(before.panes);
  expect(readdirSync(seeded.ayaHome).filter(name=>/^pty-handover\.[a-f0-9]{64}\.json$/.test(name))).toHaveLength(0);
  process.kill(old[0],'SIGKILL');
  await expect.poll(()=>hostPidsForHome(seeded.ayaHome).filter(pid=>pid!==old[0]).length).toBe(1);
  await expect(view.getByTestId('terminal-history-notice').first()).toContainText('Previously consumed');
  expect(record(seeded.ayaHome).pid).toBe(before.pid);expect(record(seeded.ayaHome).panes.map(p=>[p.id,p.pid,p.generation])).toEqual(before.panes.map(p=>[p.id,p.pid,p.generation]));
  const terminal=view.getByTestId('xterm-host').first();await terminal.click();await view.keyboard.type("printf 'AUTH_RELAUNCH_IO\\n'");await view.keyboard.press('Enter');
  await expect.poll(()=>view.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('AUTH_RELAUNCH_IO\r\n');
  const log=readFileSync(join(seeded.ayaHome,'pty-events.log'),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  expect(log.filter(e=>e.ev==='spawn')).toHaveLength(2);
 }finally{await closeAndWait(next);}
});

for(const fault of ['missing','wrong','unknown identity'])test(`a ${fault} capability gives a friendly real attachment refusal; Cancel keeps the host and processes`,async({app,window,seeded})=>{
 await waitForShellReady(window);const before=record(seeded.ayaHome),hosts=hostPidsForHome(seeded.ayaHome);
 const retainedFiles=fault==='unknown identity'?[join(seeded.ayaHome,'pty-owner/record.json'),join(seeded.ayaHome,'pty-hosts',`${hosts[0]}.json`)].map(file=>({file,bytes:readFileSync(file)})):[];
 const errors:string[]=[];window.on('pageerror',e=>errors.push(String(e)));
 const inputFile=join(seeded.projectDir,'auth-refused-input');expect(inputFile).not.toContain("'");
 await window.evaluate(file=>window.aya.ptyWrite('tab-left',`stty -echo; printf 'AUTH_CAPTURE_READY\\n'; while IFS= read -r line; do printf '%s\\n' "$line" >> '${file}'; done\r`),inputFile);
 await expect.poll(()=>window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('AUTH_CAPTURE_READY\r\n');
 await app.evaluate(({ipcMain})=>{
  const original=(ipcMain as any)._invokeHandlers.get('pty:write');(globalThis as any).authWriteCalls=0;
  ipcMain.removeHandler('pty:write');ipcMain.handle('pty:write',(event,...args)=>{(globalThis as any).authWriteCalls++;return original(event,...args);});
 });
 await app.evaluate((_api,root)=>{
  const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js'),request=PtyHostClient.prototype.request;
  PtyHostClient.prototype.request=function(...args:unknown[]){(globalThis as any).authClient=this;return request.apply(this,args);};
 },join(__dirname,'..'));
 await window.evaluate(()=>window.aya.ptyBuffer('tab-left'));
 for(const saved of retainedFiles)unlinkSync(saved.file);
 try{
  await app.evaluate((_api,fault)=>{const client=(globalThis as any).authClient;(globalThis as any).authSavedMemoryKey=Buffer.from(client.hostAuthKey);client.hostAsked=true;client.dropSocket();client.hostAsked=false;client.hostAuthKey=fault==='wrong'?Buffer.alloc(32,42):null;},fault);
  await window.addInitScript(()=>{(window as any).authUnhandled=[];window.addEventListener('unhandledrejection',e=>(window as any).authUnhandled.push(String(e.reason)));});
  await window.reload();
  await expect(window.getByTestId('terminal-history-notice').first()).toContainText(fault==='wrong'?'authenticate':'cannot be reattached by this Aya');
  await expect(window.getByTestId('terminal-history-notice').first()).toContainText('input remains disabled');
  const state=execFileSync(join(__dirname,'..','bin','aya'),['pane','state','shell 1','--explain'],{env:{...envWithoutAya(),AYA_HOME:seeded.ayaHome},encoding:'utf8',timeout:10000});
  expect(state).toContain('"shell 1": unknown; busy: no; waiting: unknown');
  expect(state).not.toContain('excerpt:');
  const refusedTerminal=window.getByTestId('xterm-host').first();await refusedTerminal.click();await window.keyboard.type('not-delivered');await window.keyboard.press('Enter');
  await refusedTerminal.locator('.xterm-helper-textarea').evaluate(textarea=>{const data=new DataTransfer();data.setData('text/plain','paste-not-delivered\n');textarea.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
  expect(await app.evaluate(()=>(globalThis as any).authWriteCalls)).toBe(0);
  expect(require('node:fs').existsSync(inputFile)).toBe(false);
  await expect(window.getByTestId('xterm-host').first()).not.toContainText('Error invoking remote method');
  await expect(window.getByTestId('xterm-host').first()).not.toContainText('Terminal attachment failed');
  await app.evaluate(({dialog})=>{const original=dialog.showMessageBox.bind(dialog);(globalThis as any).authQuestions=[];dialog.showMessageBox=(async(...args:Parameters<typeof dialog.showMessageBox>)=>{const options=args.at(-1) as {message:string;detail:string;buttons:string[]};if(!['Work in progress will stop','Aya cannot safely restart this terminal host'].includes(options.message))return original(...args);(globalThis as any).authQuestions.push(options);return {response:options.buttons.length===1?0:1,checkboxChecked:false};}) as typeof dialog.showMessageBox;});
  await app.evaluate(({ipcMain})=>{
   const original=(ipcMain as any)._invokeHandlers.get('pty:spawn');(globalThis as any).authLateSpawns=0;
   ipcMain.removeHandler('pty:spawn');ipcMain.handle('pty:spawn',(event,...args)=>{(globalThis as any).authLateSpawns++;return original(event,...args);});
   const client=(globalThis as any).authClient,restart=client.restart.bind(client);(globalThis as any).authRestarts=0;
   client.restart=(...args:unknown[])=>{(globalThis as any).authRestarts++;return restart(...args);};
  });
  await window.evaluate(()=>{
   const w=window as any;w.headlessUiEvents=[];
   window.addEventListener('aya:e2e-headless-dialog',event=>w.headlessUiEvents.push((event as CustomEvent).detail));
   w.__ayaE2eHeadlessUi.setResponse('renderer.confirm',true);
  });
  await fireShortcut(app,'open-settings');const settings=window.locator('.aya-modal--settings');await settings.getByTestId('settings-tab').filter({hasText:'Diagnostics'}).click();
  await settings.locator('.aya-settings-general-row',{hasText:'PTY host'}).getByRole('button',{name:'Restart'}).click();
  await expect.poll(()=>window.evaluate(()=>(window as any).headlessUiEvents)).toContainEqual({kind:'renderer.confirm',message:'Restart the PTY host? This stops all running terminals; restart each with Shift+Enter.'});
  await expect.poll(()=>app.evaluate(()=>(globalThis as any).authQuestions.length)).toBe(1);
  const question=await app.evaluate(()=>(globalThis as any).authQuestions[0]);
  if(fault==='unknown identity'){
   expect(await app.evaluate(()=>(globalThis as any).authRestarts)).toBe(0);expect(await app.evaluate(()=>(globalThis as any).authLateSpawns)).toBe(0);
   expect(question.buttons).toEqual(['OK']);expect(question.detail).toContain('identity could not be verified');
   await settings.getByRole('button',{name:'Cancel',exact:true}).click();
   await expect(window.locator('.aya-sidebar-row[data-terminal-name="shell 1"] .aya-sidebar-statusdot')).toHaveClass(/--error/);
   await expect(window.getByTestId('terminal-history-notice').first()).toContainText('input remains disabled');
   await refusedTerminal.click();await window.keyboard.type('after-ok-not-delivered');await window.keyboard.press('Enter');
   await refusedTerminal.locator('.xterm-helper-textarea').evaluate(textarea=>{const data=new DataTransfer();data.setData('text/plain','after-ok-paste\n');textarea.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
   expect(await app.evaluate(()=>(globalThis as any).authWriteCalls)).toBe(0);
   expect(require('node:fs').existsSync(inputFile)).toBe(false);
   expect(await app.evaluate(()=>(globalThis as any).authQuestions.length)).toBe(1);
  }else for(const p of before.panes)expect(question.detail).toContain(`PID ${p.pid}`);
  expect(hostPidsForHome(seeded.ayaHome)).toEqual(hosts);expect(alive(before.pid)).toBe(true);for(const p of before.panes)expect(alive(p.pid)).toBe(true);
  if(!retainedFiles.length)expect(record(seeded.ayaHome).pid).toBe(before.pid);
  expect(errors).toEqual([]);expect(await window.evaluate(()=>(window as any).authUnhandled)).toEqual([]);
 }finally{for(const saved of retainedFiles)writeFileSync(saved.file,saved.bytes,{mode:0o600});await app.evaluate(()=>{const g=globalThis as any;g.authClient.hostAuthKey=g.authSavedMemoryKey;delete g.authSavedMemoryKey;});}
});

for(const loss of ['main crash'] as const)test(`${loss} opens a window without a modal; explicit consent alone stops the retained processes`,async({app,window,seeded})=>{
 await waitForShellReady(window);await expect.poll(()=>record(seeded.ayaHome).panes.length).toBe(2);const before=record(seeded.ayaHome),hosts=hostPidsForHome(seeded.ayaHome),root=join(__dirname,'..');expect(hosts).toHaveLength(1);
 // Put an exact valid old capability on disk only as a migration artifact.
 // It never leaves this main through argv, env, logs or the test bridge result.
 await app.evaluate((_api,root)=>{const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js'),request=PtyHostClient.prototype.request;PtyHostClient.prototype.request=function(...args:unknown[]){(globalThis as any).crashAuthClient=this;return request.apply(this,args);};},root);
 await window.evaluate(()=>window.aya.ptyBuffer('tab-left'));
 await app.evaluate((_api,home)=>{const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path');fs.mkdirSync(path.join(home,'pty-host-auth'),{mode:0o700});fs.writeFileSync(path.join(home,'pty-host-auth/key'),(globalThis as any).crashAuthClient.hostAuthKey,{mode:0o600});},seeded.ayaHome);
 const child=app.process();child.kill('SIGKILL');await expect.poll(()=>alive(child.pid!)).toBe(false);
 expect(readdirSync(seeded.ayaHome).filter(name=>/^pty-handover\.[a-f0-9]{64}\.json$/.test(name))).toHaveLength(0);
 const entry=join(seeded.root,'unannounced-main.cjs');writeFileSync(entry,`const electron=require('electron'),original=electron.dialog.showMessageBox.bind(electron.dialog);global.authQuestions=[];global.authAnswer=1;electron.dialog.showMessageBox=async(...args)=>{const options=args.at(-1);if(!['Work in progress will stop','Aya cannot safely restart this terminal host'].includes(options.message))return original(...args);global.authQuestions.push(options);return{response:options.buttons?.length===1?0:global.authAnswer,checkboxChecked:false};};require(require('path').join(process.env.AYA_TEST_APP_ROOT,'dist-electron/main.js'));`);
 const next=await launchE2eElectron({cwd:root,args:[entry,`--user-data-dir=${seeded.userDataDir}`,...ciElectronFlags()],env:appEnv({...seeded,launchEnv:{...seeded.launchEnv,AYA_E2E_PTY_SHUTDOWN:'0',AYA_TEST_APP_ROOT:root}})});
 try{
  const view=await next.firstWindow(),errors:string[]=[];view.on('pageerror',error=>errors.push(String(error)));
  await view.evaluate(()=>{
   const w=window as any;w.headlessUiEvents=[];
   window.addEventListener('aya:e2e-headless-dialog',event=>w.headlessUiEvents.push((event as CustomEvent).detail));
   w.__ayaE2eHeadlessUi.setResponse('renderer.confirm',true);
  });
  expect(await next.evaluate(()=>(globalThis as any).authQuestions)).toEqual([]);
  await next.evaluate(({ipcMain})=>{const original=(ipcMain as any)._invokeHandlers.get('pty:write');(globalThis as any).unannouncedWrites=0;ipcMain.removeHandler('pty:write');ipcMain.handle('pty:write',(event,...args)=>{(globalThis as any).unannouncedWrites++;return original(event,...args);});});
  for(const oldPane of before.panes){
   const pane=view.locator(`.aya-pane[data-terminal-id="${oldPane.id}"]`);
   await expect(pane.getByTestId('terminal-history-notice')).toContainText('input remains disabled');
   await expect(pane.getByTestId('terminal-history-notice')).toContainText('cannot be reattached by this Aya');
   const terminal=pane.getByTestId('xterm-host');await terminal.click();await view.keyboard.type(`not-delivered-${oldPane.id}`);await view.keyboard.press('Enter');
   await terminal.locator('.xterm-helper-textarea').evaluate((textarea,id)=>{const data=new DataTransfer();data.setData('text/plain',`paste-not-delivered-${id}\n`);textarea.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},oldPane.id);
   expect(await next.evaluate(()=>(globalThis as any).unannouncedWrites),`no keyboard/paste writes from retained pane ${oldPane.id}`).toBe(0);
  }
  for(const pane of before.panes)expect(alive(pane.pid)).toBe(true);
  expect(hostPidsForHome(seeded.ayaHome)).toEqual(hosts);expect(record(seeded.ayaHome).pid).toBe(before.pid);expect(record(seeded.ayaHome).panes).toEqual(before.panes);expect(errors).toEqual([]);
  expect(readFileSync(join(seeded.ayaHome,'pty-events.log'),'utf8').split('\n').filter(line=>{try{return JSON.parse(line).ev==='spawn';}catch{return false;}})).toHaveLength(2);
  await fireShortcut(next,'open-settings');const settings=view.locator('.aya-modal--settings');await settings.getByTestId('settings-tab').filter({hasText:'Diagnostics'}).click();
  const restart=settings.locator('.aya-settings-general-row',{hasText:'PTY host'}).getByRole('button',{name:'Restart'});await restart.click();
  await expect.poll(()=>view.evaluate(()=>(window as any).headlessUiEvents)).toContainEqual({kind:'renderer.confirm',message:'Restart the PTY host? This stops all running terminals; restart each with Shift+Enter.'});
  await expect.poll(()=>next.evaluate(()=>(globalThis as any).authQuestions.length)).toBe(1);
  const question=await next.evaluate(()=>(globalThis as any).authQuestions[0]);expect(question.message).toBe('Work in progress will stop');for(const pane of before.panes)expect(question.detail).toContain(`PID ${pane.pid}`);
  expect(hostPidsForHome(seeded.ayaHome)).toEqual(hosts);expect(alive(before.pid)).toBe(true);for(const pane of before.panes)expect(alive(pane.pid)).toBe(true);
  await next.evaluate(()=>{(globalThis as any).authAnswer=0;});await restart.click();
  await expect.poll(()=>hosts.some(alive)||alive(before.pid)||before.panes.some(p=>alive(p.pid)),{timeout:10000}).toBe(false);
  expect(await next.evaluate(()=>(globalThis as any).authQuestions.length)).toBe(2);expect(errors).toEqual([]);
 }finally{await closeAndWait(next);}
});


test('normal quit keeps its one-use transfer across six simulated months before relaunch',async({seeded})=>{
 const root=join(__dirname,'..'),clockFile=join(seeded.root,'auth-clock.json'),hostEntry=join(seeded.root,'long-closed-host.cjs'),mainEntry=join(seeded.root,'long-closed-main.cjs');
 writeFileSync(clockFile,'0');
 // Test-only host clock advances both expiry clocks; real principal identities
 // still come from the kernel. Wrapper source is constant, paths are data.
 writeFileSync(hostEntry,`const path=require('node:path'),fs=require('node:fs'),perf=require('node:perf_hooks').performance,mod=require(path.join(process.env.AYA_TEST_APP_ROOT,'dist-electron/pty-host-auth-transfer.js')),Original=mod.HostAuthTransfer,offset=()=>Number(fs.readFileSync(process.env.AYA_TEST_AUTH_CLOCK,'utf8'));mod.HostAuthTransfer=class extends Original{constructor(key){super(key,{wall:()=>Date.now()+offset(),monotonic:()=>perf.now()+offset()});}};`);
 writeFileSync(mainEntry,`const path=require('node:path'),cp=require('node:child_process'),spawn=cp.spawn;cp.spawn=function(executable,args,options){const target=path.join(process.env.AYA_TEST_APP_ROOT,'dist-electron/pty-host.js');return spawn.call(this,executable,args?.[0]===target?['--require',process.env.AYA_TEST_AUTH_HOST,...args]:args,options);};const electron=require('electron'),original=electron.dialog.showMessageBox.bind(electron.dialog);global.authQuestions=[];electron.dialog.showMessageBox=async(...args)=>{global.authQuestions.push(args.at(-1));return original(...args);};require(path.join(process.env.AYA_TEST_APP_ROOT,'dist-electron/main.js'));`);
 const env=appEnv({...seeded,launchEnv:{...seeded.launchEnv,AYA_E2E_PTY_SHUTDOWN:'0',AYA_TEST_APP_ROOT:root,AYA_TEST_AUTH_CLOCK:clockFile,AYA_TEST_AUTH_HOST:hostEntry}});
 const launch=()=>launchE2eElectron({cwd:root,args:[mainEntry,`--user-data-dir=${seeded.userDataDir}`,...ciElectronFlags()],env});
 const first=await launch(),firstPid=first.process().pid!;let next:Awaited<ReturnType<typeof launch>>|null=null;
 try{
  await waitForShellReady(await first.firstWindow());await expect.poll(()=>record(seeded.ayaHome).panes.length).toBe(2);
  const before=record(seeded.ayaHome),hosts=hostPidsForHome(seeded.ayaHome);expect(hosts).toHaveLength(1);
  await closeAndWait(first);const tickets=readdirSync(seeded.ayaHome).filter(name=>/^pty-handover\.[a-f0-9]{64}\.json$/.test(name));expect(tickets).toHaveLength(1);
  const ticket=JSON.parse(readFileSync(join(seeded.ayaHome,tickets[0]),'utf8'));expect(ticket.purpose).toBe('ordinary-quit');expect(ticket.deadline).toBeNull();
  writeFileSync(clockFile,String(180*86400000));next=await launch();const view=await next.firstWindow();await waitForShellReady(view);
  expect(await next.evaluate(()=>(globalThis as any).authQuestions)).toEqual([]);
  expect(hostPidsForHome(seeded.ayaHome)).toEqual(hosts);expect(record(seeded.ayaHome).pid).toBe(before.pid);expect(record(seeded.ayaHome).panes).toEqual(before.panes);
  expect(readdirSync(seeded.ayaHome).filter(name=>/^pty-handover\.[a-f0-9]{64}\.json$/.test(name))).toHaveLength(0);
  const terminal=view.getByTestId('xterm-host').first();await terminal.click();await view.keyboard.type("printf 'LONG_QUIT_IO\\n'");await view.keyboard.press('Enter');
  await expect.poll(()=>view.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('LONG_QUIT_IO\r\n');
  expect(readFileSync(join(seeded.ayaHome,'pty-events.log'),'utf8').split('\n').filter(line=>{try{return JSON.parse(line).ev==='spawn';}catch{return false;}})).toHaveLength(2);
 }finally{if(next)await closeAndWait(next);else if(alive(firstPid))await closeAndWait(first);}
});
