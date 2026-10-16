import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {test as base,expect,launchApp,closeAndWait,hostPidsForHome} from './fixtures';
import {waitForShellReady} from './helpers/terminal';
import {fireShortcut} from './helpers/shortcut';
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const record=(home:string)=>JSON.parse(readFileSync(join(home,'pty-owner/record.json'),'utf8')) as {pid:number;instanceId:string;panes:Array<{id:string;pid:number;generation:number}>};
const test=base.extend({app:async({seeded},use)=>{const app=await launchApp({...seeded,launchEnv:{...seeded.launchEnv,AYA_E2E_PTY_SHUTDOWN:'0'}}),pid=app.process().pid!;await use(app);if(alive(pid))await closeAndWait(app);}});

test('ordinary relaunch proves continuity and a later JS crash recovers the original owner and panes',async({app,window,seeded})=>{
 await waitForShellReady(window);const before=record(seeded.ayaHome),old=hostPidsForHome(seeded.ayaHome);expect(old).toHaveLength(1);
 await closeAndWait(app);expect(alive(old[0])).toBe(true);
 const next=await launchApp({...seeded,launchEnv:{...seeded.launchEnv,AYA_E2E_PTY_SHUTDOWN:'0'}});
 try{
  const view=await next.firstWindow();await waitForShellReady(view);
  expect(hostPidsForHome(seeded.ayaHome)).toEqual(old);expect(record(seeded.ayaHome).panes).toEqual(before.panes);
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
 await waitForShellReady(window);const before=record(seeded.ayaHome),hosts=hostPidsForHome(seeded.ayaHome),keyFile=join(seeded.ayaHome,'pty-host-auth/key'),key=readFileSync(keyFile);
 const retainedFiles=fault==='unknown identity'?[join(seeded.ayaHome,'pty-owner/record.json'),join(seeded.ayaHome,'pty-hosts',`${hosts[0]}.json`)].map(file=>({file,bytes:readFileSync(file)})):[];
 const errors:string[]=[];window.on('pageerror',e=>errors.push(String(e)));
 const inputFile=join(seeded.projectDir,'auth-refused-input');
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
 if(fault==='wrong')writeFileSync(keyFile,Buffer.alloc(32,42),{mode:0o600});else unlinkSync(keyFile);
 for(const saved of retainedFiles)unlinkSync(saved.file);
 try{
  await app.evaluate(()=>{const client=(globalThis as any).authClient;client.hostAsked=true;client.dropSocket();client.hostAsked=false;client.hostAuthKey=null;});
  await window.addInitScript(()=>{(window as any).authUnhandled=[];window.addEventListener('unhandledrejection',e=>(window as any).authUnhandled.push(String(e.reason)));});
  await window.reload();
  await expect(window.getByTestId('terminal-history-notice').first()).toContainText('authenticate');
  await expect(window.getByTestId('terminal-history-notice').first()).toContainText('input remains disabled');
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
 }finally{for(const saved of retainedFiles)writeFileSync(saved.file,saved.bytes,{mode:0o600});writeFileSync(keyFile,key,{mode:0o600});}
});
