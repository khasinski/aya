import {readFileSync,writeFileSync,unlinkSync,readdirSync,mkdirSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {_electron} from '@playwright/test';
import {appEnv} from './helpers/seed';
import {test as base,expect,launchApp,closeAndWait,hostPidsForHome,ciElectronFlags} from './fixtures';
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
  await expect(window.getByTestId('terminal-history-notice').first()).toContainText('authenticate');
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
  await fireShortcut(app,'open-settings');const settings=window.locator('.aya-modal--settings');await settings.getByTestId('settings-tab').filter({hasText:'Diagnostics'}).click();
  window.once('dialog',dialog=>void dialog.accept());
  await settings.locator('.aya-settings-general-row',{hasText:'PTY host'}).getByRole('button',{name:'Restart'}).click();
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

test('an unannounced main crash cannot adopt even an exact old disk key; Cancel preserves every process',async({app,window,seeded})=>{
 await waitForShellReady(window);const before=record(seeded.ayaHome),hosts=hostPidsForHome(seeded.ayaHome),root=join(__dirname,'..');
 // Put an exact valid old capability on disk only as a migration artifact.
 // It never leaves this main through argv, env, logs or the test bridge result.
 await app.evaluate((_api,root)=>{const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js'),request=PtyHostClient.prototype.request;PtyHostClient.prototype.request=function(...args:unknown[]){(globalThis as any).crashAuthClient=this;return request.apply(this,args);};},root);
 await window.evaluate(()=>window.aya.ptyBuffer('tab-left'));
 await app.evaluate((_api,home)=>{const fs=process.getBuiltinModule('fs'),path=process.getBuiltinModule('path');fs.mkdirSync(path.join(home,'pty-host-auth'),{mode:0o700});fs.writeFileSync(path.join(home,'pty-host-auth/key'),(globalThis as any).crashAuthClient.hostAuthKey,{mode:0o600});},seeded.ayaHome);
 const child=app.process();child.kill('SIGKILL');await expect.poll(()=>alive(child.pid!)).toBe(false);
 expect(readdirSync(seeded.ayaHome).filter(name=>/^pty-handover\.[a-f0-9]{64}\.json$/.test(name))).toHaveLength(0);
 const entry=join(seeded.root,'unannounced-main.cjs');writeFileSync(entry,`const electron=require('electron');global.authQuestions=[];electron.dialog.showMessageBox=async(...args)=>{const options=args.at(-1);global.authQuestions.push(options);return{response:options.buttons?.length===1?0:1,checkboxChecked:false};};require(require('path').join(process.env.AYA_TEST_APP_ROOT,'dist-electron/main.js'));`);
 const next=await _electron.launch({cwd:root,args:[entry,`--user-data-dir=${seeded.userDataDir}`,...ciElectronFlags()],env:appEnv({...seeded,launchEnv:{...seeded.launchEnv,AYA_E2E_PTY_SHUTDOWN:'0',AYA_TEST_APP_ROOT:root}})});
 try{
  const view=await next.firstWindow(),errors:string[]=[];view.on('pageerror',error=>errors.push(String(error)));
  await expect(view.getByTestId('terminal-history-notice').first()).toContainText('input remains disabled');
  const questions=await next.evaluate(()=>(globalThis as any).authQuestions);expect(questions).toHaveLength(1);expect(questions[0].message).toBe('Work in progress will stop');
  for(const pane of before.panes){expect(questions[0].detail).toContain(`PID ${pane.pid}`);expect(alive(pane.pid)).toBe(true);}
  expect(hostPidsForHome(seeded.ayaHome)).toEqual(hosts);expect(record(seeded.ayaHome).pid).toBe(before.pid);expect(record(seeded.ayaHome).panes).toEqual(before.panes);expect(errors).toEqual([]);
  expect(readFileSync(join(seeded.ayaHome,'pty-events.log'),'utf8').split('\n').filter(line=>{try{return JSON.parse(line).ev==='spawn';}catch{return false;}})).toHaveLength(2);
 }finally{await closeAndWait(next);}
});
