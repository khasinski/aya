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

for(const fault of ['missing','wrong'])test(`a ${fault} capability gives a friendly real attachment refusal; Cancel keeps the host and processes`,async({app,window,seeded})=>{
 await waitForShellReady(window);const before=record(seeded.ayaHome),hosts=hostPidsForHome(seeded.ayaHome),keyFile=join(seeded.ayaHome,'pty-host-auth/key'),key=readFileSync(keyFile);
 const errors:string[]=[];window.on('pageerror',e=>errors.push(String(e)));
 await app.evaluate((_api,root)=>{
  const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js'),request=PtyHostClient.prototype.request;
  PtyHostClient.prototype.request=function(...args:unknown[]){(globalThis as any).authClient=this;return request.apply(this,args);};
 },join(__dirname,'..'));
 await window.evaluate(()=>window.aya.ptyBuffer('tab-left'));
 if(fault==='missing')unlinkSync(keyFile);else writeFileSync(keyFile,Buffer.alloc(32,42),{mode:0o600});
 try{
  await app.evaluate(()=>{const client=(globalThis as any).authClient;client.hostAsked=true;client.dropSocket();client.hostAsked=false;client.hostAuthKey=null;});
  await window.addInitScript(()=>{(window as any).authUnhandled=[];window.addEventListener('unhandledrejection',e=>(window as any).authUnhandled.push(String(e.reason)));});
  await window.reload();
  await expect(window.getByTestId('terminal-history-notice').first()).toContainText('authenticate');
  await expect(window.getByTestId('xterm-host').first()).not.toContainText('Error invoking remote method');
  await expect(window.getByTestId('xterm-host').first()).not.toContainText('Terminal attachment failed');
  await app.evaluate(({dialog})=>{const original=dialog.showMessageBox.bind(dialog);(globalThis as any).authQuestions=[];dialog.showMessageBox=(async(...args:Parameters<typeof dialog.showMessageBox>)=>{const options=args.at(-1) as {message:string;detail:string};if(options.message!=='Work in progress will stop')return original(...args);(globalThis as any).authQuestions.push(options.detail);return {response:1,checkboxChecked:false};}) as typeof dialog.showMessageBox;});
  await fireShortcut(app,'open-settings');const settings=window.locator('.aya-modal--settings');await settings.getByTestId('settings-tab').filter({hasText:'Diagnostics'}).click();
  window.once('dialog',dialog=>void dialog.accept());
  await settings.locator('.aya-settings-general-row',{hasText:'PTY host'}).getByRole('button',{name:'Restart'}).click();
  await expect.poll(()=>app.evaluate(()=>(globalThis as any).authQuestions.length)).toBe(1);
  const question=await app.evaluate(()=>(globalThis as any).authQuestions[0]);for(const p of before.panes)expect(question).toContain(`PID ${p.pid}`);
  expect(hostPidsForHome(seeded.ayaHome)).toEqual(hosts);expect(record(seeded.ayaHome).pid).toBe(before.pid);for(const p of before.panes)expect(alive(p.pid)).toBe(true);
  expect(errors).toEqual([]);expect(await window.evaluate(()=>(window as any).authUnhandled)).toEqual([]);
 }finally{writeFileSync(keyFile,key,{mode:0o600});}
});
