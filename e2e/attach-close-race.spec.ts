import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test,expect,handleRendererDialogs} from './fixtures';
import {waitForShellReady} from './helpers/terminal';
import {fireShortcut} from './helpers/shortcut';

for(const action of ['pane','project','hidden-pane'] as const)test(`closing a ${action} cancels its unsent attach while display or visibility is pending`,async({app,window,seeded})=>{
 const rendererDialogs=await handleRendererDialogs(window,seeded,{'renderer.alert':undefined});
 await waitForShellReady(window);
 const record=()=>JSON.parse(readFileSync(join(seeded.ayaHome,'pty-owner/record.json'),'utf8'));
 await expect.poll(()=>record().panes.length).toBe(2);
 const leftPid=record().panes.find((p:{id:string})=>p.id==='tab-left').pid;
 await app.evaluate(({ipcMain},action)=>{
  const handlers=ipcMain as unknown as {_invokeHandlers:Map<string,(...args:unknown[])=>unknown>};
  const display=handlers._invokeHandlers.get('pty-checkpoint:display')!,kill=handlers._invokeHandlers.get('pty:kill')!,spawn=handlers._invokeHandlers.get('pty:spawn')!,write=handlers._invokeHandlers.get('pty:write')!;
  const state=globalThis as unknown as {pendingId:string;killSeen:boolean;spawned:string[];writes:string[];releaseDisplay:()=>void;releaseKill:()=>void};
  state.pendingId='';state.killSeen=false;state.spawned=[];state.writes=[];
  const displayGate=new Promise<void>(resolve=>{state.releaseDisplay=resolve;});
  ipcMain.removeHandler('pty-checkpoint:display');
  ipcMain.handle('pty-checkpoint:display',async(event,id)=>{
   if(id==='tab-left'||id==='tab-right')return display(event,id);
   state.pendingId=id;await displayGate;
   return action==='hidden-pane'?{json:null,generation:'held-test-generation',offset:0,notice:'History from replay'}:display(event,id);
  });
  ipcMain.removeHandler('pty:spawn');ipcMain.handle('pty:spawn',(event,request)=>{state.spawned.push(request.ptyId);return spawn(event,request);});
  ipcMain.removeHandler('pty:write');ipcMain.handle('pty:write',(event,id,data)=>{state.writes.push(id);return write(event,id,data);});
  ipcMain.removeHandler('pty:kill');ipcMain.handle('pty:kill',async(event,id)=>{
   if(id===state.pendingId){state.killSeen=true;if(action!=='project')await new Promise<void>(resolve=>{state.releaseKill=resolve;});}
   if(action==='project'&&id==='tab-left')throw Error('test refusal keeps the existing live pane');
   return kill(event,id);
  });
 },action);
 await fireShortcut(app,'new-shell');
 await expect.poll(()=>app.evaluate(()=>(globalThis as unknown as {pendingId:string}).pendingId)).not.toBe('');
 const id=await app.evaluate(()=>(globalThis as unknown as {pendingId:string}).pendingId);
 const pane=window.locator(`.aya-pane[data-terminal-id="${id}"]`);
 await expect(pane).toBeVisible();
 if(action==='hidden-pane'){
  await window.locator('.aya-sidebar-row[data-terminal-id="tab-left"]').click();
  await expect(pane).toBeAttached();await expect(pane).toBeHidden();
  await app.evaluate(()=>(globalThis as unknown as {releaseDisplay:()=>void}).releaseDisplay());
  await window.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await window.locator(`.aya-sidebar-row[data-terminal-id="${id}"]`).getByTitle(/^Close terminal /).click();
 }else if(action==='pane')await fireShortcut(app,'close-tab');
 else await window.getByTitle(/^Close project /).click();
 await expect.poll(()=>app.evaluate(()=>(globalThis as unknown as {killSeen:boolean}).killSeen)).toBe(true);
 if(action==='project')await expect.poll(async()=> (await rendererDialogs.read()).map(event=>event.message).join('\n')).toContain('test refusal keeps the existing live pane');
 if(action!=='hidden-pane')await app.evaluate(()=>(globalThis as unknown as {releaseDisplay:()=>void}).releaseDisplay());
 // This notice is emitted only after the old lookup resumes and observes its
 // cancellation. Thus zero calls is checked after that continuation, not a sleep.
 await expect(pane.getByTestId('terminal-history-notice')).toContainText('Terminal attachment cancelled by a stop request.');
 if(action!=='hidden-pane'){await pane.click();await window.keyboard.type('not delivered');await window.keyboard.press('Enter');}
 await pane.locator('.xterm-helper-textarea').evaluate(textarea=>{
  const transfer=new DataTransfer();transfer.setData('text/plain','CANCELLED_PASTE');
  textarea.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
 });
 expect(await app.evaluate(id=>(globalThis as unknown as {writes:string[]}).writes.filter(p=>p===id),id)).toEqual([]);
 expect(await app.evaluate(id=>(globalThis as unknown as {spawned:string[]}).spawned.filter(p=>p===id),id)).toEqual([]);
 if(action!=='project'){
  await app.evaluate(()=>(globalThis as unknown as {releaseKill:()=>void}).releaseKill());
  await expect(pane).toHaveCount(0);
 }else{
  await expect(window.locator('.aya-sidebar-row[data-terminal-name="shell 1"]')).toBeVisible();
  await expect.poll(()=>record().panes.some((p:{id:string})=>p.id==='tab-right')).toBe(false);
 }
 expect(record().panes.find((p:{id:string})=>p.id==='tab-left').pid).toBe(leftPid);
 expect(record().panes.some((p:{id:string})=>p.id===id)).toBe(false);
 expect(await app.evaluate(id=>(globalThis as unknown as {spawned:string[]}).spawned.filter(p=>p===id),id)).toEqual([]);
});
