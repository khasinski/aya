import {_electron} from '@playwright/test';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {test as base,expect,launchApp,closeAndWait,hostPidsForHome,ciElectronFlags} from './fixtures';
import {appEnv} from './helpers/seed';
import {waitForShellReady} from './helpers/terminal';
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const inventory=(home:string)=>JSON.parse(readFileSync(join(home,'pty-owner/record.json'),'utf8')) as {pid:number;panes:Array<{id:string;pid:number;generation:number}>};
const test=base.extend({app:async({seeded},use)=>{const app=await launchApp({...seeded,launchEnv:{...seeded.launchEnv,AYA_E2E_PTY_SHUTDOWN:'0'}}),pid=app.process().pid!;await use(app);if(alive(pid))await closeAndWait(app);}});
for(const scenario of ['takeover','deadline','close','quit'])test(`a still-closing main never blocks the new window or asks to stop work: ${scenario}`,async({app,window,seeded})=>{
 const expiry=scenario==='deadline';
 await waitForShellReady(window);const before=inventory(seeded.ayaHome),hosts=hostPidsForHome(seeded.ayaHome),root=join(__dirname,'..');
 const entry=join(seeded.root,'principal-wait-main.js'),exhaustionFile=join(seeded.root,'principal-exhaustion.json');
 writeFileSync(entry,`const {dialog}=require('electron');const originalDialog=dialog.showMessageBox.bind(dialog);global.principalQuestions=[];dialog.showMessageBox=async(...args)=>{const options=args.at(-1);if(options.message?.startsWith('Aya did not '))return originalDialog(...args);global.principalQuestions.push(options);return {response:options.buttons?.length===1?0:1,checkboxChecked:false};};const {PtyHostClient}=require(require('node:path').join(process.env.AYA_TEST_APP_ROOT,'dist-electron/pty-host-client.js'));const request=PtyHostClient.prototype.request;PtyHostClient.prototype.request=function(...args){global.principalClient=this;return request.apply(this,args);};global.principalSent=[];const send=PtyHostClient.prototype.sendRequest;PtyHostClient.prototype.sendRequest=function(socket,req){global.principalSent.push({type:req.type,ptyId:req.type==='spawn'?req.req.ptyId:req.ptyId});return send.call(this,socket,req);};const wait=PtyHostClient.prototype.waitForPrincipal;PtyHostClient.prototype.waitForPrincipal=function(...args){const began=Date.now(),lag=require('node:perf_hooks').monitorEventLoopDelay({resolution:10});lag.enable();return wait.apply(this,args).finally(()=>{lag.disable();require('fs').writeFileSync(process.env.AYA_TEST_TRACE_FILE,JSON.stringify({pid:process.pid,exhausted:this.principalRetryExhausted,elapsedMs:Date.now()-began,eventLoopMaxMs:lag.max/1e6,eventLoopMeanMs:lag.mean/1e6}));});};global.principalStarts=0;const start=PtyHostClient.prototype.startHost;PtyHostClient.prototype.startHost=function(...args){global.principalStarts++;return start.apply(this,args);};require(require('node:path').join(process.env.AYA_TEST_APP_ROOT,'dist-electron/main.js'));`);
 // This models an announced ordinary quit whose final exit is held by the
 // fixture. The second main receives authority only through the real ticket.
 await app.evaluate((_api,root)=>{const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js'),request=PtyHostClient.prototype.request;PtyHostClient.prototype.request=function(...args:unknown[]){(globalThis as any).announcingClient=this;return request.apply(this,args);};},root);
 await window.evaluate(()=>window.aya.ptyBuffer('tab-left'));
 expect(await app.evaluate(()=>(globalThis as any).announcingClient.announceOrdinaryQuit())).toBe(true);
 const next=await _electron.launch({cwd:root,args:[entry,`--user-data-dir=${join(seeded.root,'second-profile')}`,...ciElectronFlags()],env:appEnv({...seeded,launchEnv:{...seeded.launchEnv,AYA_E2E_PTY_SHUTDOWN:'0',AYA_TEST_APP_ROOT:root,AYA_TEST_TRACE_FILE:exhaustionFile}})});
 const nextPid=next.process().pid!;
 try{
  const view=await next.firstWindow({timeout:5000}),errors:string[]=[];view.on('pageerror',error=>errors.push(String(error)));
  await expect(view.getByTestId('terminal-history-notice').first()).toContainText('previous Aya process is still closing');
  expect(await next.evaluate(()=>(globalThis as any).principalQuestions)).toEqual([]);expect(await next.evaluate(()=>(globalThis as any).principalStarts)).toBe(0);
  expect(alive(app.process().pid!)).toBe(true);expect(inventory(seeded.ayaHome).panes).toEqual(before.panes);
  await next.evaluate(({ipcMain})=>{const original=(ipcMain as any)._invokeHandlers.get('pty:write');(globalThis as any).principalWrites=0;ipcMain.removeHandler('pty:write');ipcMain.handle('pty:write',(event,...args)=>{(globalThis as any).principalWrites++;return original(event,...args);});});
  const waiting=view.getByTestId('xterm-host').first();await waiting.click();await view.keyboard.type('not-delivered');await view.keyboard.press('Enter');
  await waiting.locator('.xterm-helper-textarea').evaluate(textarea=>{const data=new DataTransfer();data.setData('text/plain','not-delivered-paste\n');textarea.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
  expect(await next.evaluate(()=>(globalThis as any).principalWrites)).toBe(0);
  if(scenario==='close'){
   const told=new Promise<string>((resolve,reject)=>view.once('dialog',dialog=>{const message=dialog.message();void dialog.accept().then(()=>resolve(message),reject);}));
   await view.locator('.aya-sidebar-row[data-terminal-name="shell 1"]').click({button:'right'});
   await view.locator('.aya-context-menu-item',{hasText:'Close terminal'}).click();expect(await told).toContain('Aya did not close shell 1');
  }
  if(scenario==='quit'){
   await closeAndWait(next);await closeAndWait(app);
   expect(hostPidsForHome(seeded.ayaHome)).toEqual(hosts);expect(alive(before.pid)).toBe(true);for(const pane of before.panes)expect(alive(pane.pid)).toBe(true);return;
  }
  if(expiry){
   // Main owns the observation so CDP cannot lose a transient evaluation
   // promise while repeatedly polling a synchronous boolean during its GC.
   await expect.poll(()=>{try{return JSON.parse(readFileSync(exhaustionFile,'utf8')).exhausted;}catch{return false;}},{timeout:15000}).toBe(true);
   const exhaustion=JSON.parse(readFileSync(exhaustionFile,'utf8'));expect(exhaustion.pid).toBe(nextPid);expect(exhaustion.elapsedMs).toBeGreaterThanOrEqual(9000);expect(exhaustion.eventLoopMaxMs).toBeGreaterThan(0);expect(Number.isFinite(exhaustion.eventLoopMeanMs)).toBe(true);console.log('PRINCIPAL_EXHAUSTION',JSON.stringify(exhaustion));
   await expect(view.getByTestId('terminal-history-notice').first()).toContainText('input remains disabled');
   expect(await next.evaluate(()=>(globalThis as any).principalQuestions)).toEqual([]);
  }
  await closeAndWait(app);
  if(scenario==='close'){
   await expect.poll(()=>next.evaluate(()=>(globalThis as any).principalClient.principalRetry===null)).toBe(true);
   expect(await next.evaluate(()=>(globalThis as any).principalSent.filter((r:{type:string;ptyId:string})=>r.type==='spawn'&&r.ptyId==='tab-left'))).toEqual([]);
   await expect(view.locator('.aya-sidebar-row[data-terminal-name="shell 1"]')).toBeVisible();
   expect(inventory(seeded.ayaHome).panes).toEqual(before.panes);expect(hostPidsForHome(seeded.ayaHome)).toEqual(hosts);expect(errors).toEqual([]);return;
  }
  if(expiry){
   // After the exhausted wait only the reloaded view's attach opens a new connection; until then main refuses
   // buffer reads with the still-closing reason, which a poll of the buffer reports as a failure, not as "not yet".
   await view.reload();
   await expect.poll(()=>next.evaluate(()=>{const client=(globalThis as any).principalClient;return client.isConnected()&&!client.principalRetryExhausted;})).toBe(true);
  }
  await expect(view.getByTestId('terminal-history-notice').first()).not.toBeVisible();
  await waitForShellReady(view);
  const terminal=view.getByTestId('xterm-host').first();await terminal.click();await view.keyboard.type("printf 'PRINCIPAL_TAKEOVER\\n'");await view.keyboard.press('Enter');
  await expect.poll(()=>view.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('PRINCIPAL_TAKEOVER\r\n');
  expect(hostPidsForHome(seeded.ayaHome)).toEqual(hosts);expect(inventory(seeded.ayaHome).pid).toBe(before.pid);expect(inventory(seeded.ayaHome).panes).toEqual(before.panes);
  expect(await next.evaluate(()=>(globalThis as any).principalQuestions)).toEqual([]);expect(await next.evaluate(()=>(globalThis as any).principalStarts)).toBe(0);expect(await next.evaluate(()=>(globalThis as any).principalClient.ownsOwnerKey)).toBe(true);expect(errors).toEqual([]);
  expect(readFileSync(join(seeded.ayaHome,'pty-events.log'),'utf8').split('\n').filter(line=>{try{return JSON.parse(line).ev==='spawn';}catch{return false;}})).toHaveLength(2);
 }finally{if(alive(nextPid))await closeAndWait(next);}
});
