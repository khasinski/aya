import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test,expect,hostPidsForHome,handleRendererDialogs} from './fixtures';
import {waitForShellReady,visiblePane} from './helpers/terminal';
import {fireShortcut} from './helpers/shortcut';
test('a changed restart target asks again; Cancel keeps Aya open and a later crash recovers',async({app,window,seeded})=>{
 await handleRendererDialogs(window,seeded,{'renderer.confirm':true});
 await waitForShellReady(window);const before=JSON.parse(readFileSync(join(seeded.ayaHome,'pty-owner/record.json'),'utf8')),hosts=hostPidsForHome(seeded.ayaHome);
 await app.evaluate(({dialog},root)=>{
  const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js');
  const g=globalThis as unknown as {maskTarget:boolean;targetQuestions:string[];shutdownRequests:number};g.maskTarget=true;g.targetQuestions=[];g.shutdownRequests=0;
  const status=PtyHostClient.prototype.hostStatus,restart=PtyHostClient.prototype.restart,send=PtyHostClient.prototype.sendRequest,ask=dialog.showMessageBox.bind(dialog);
  PtyHostClient.prototype.hostStatus=async function(){const current=await status.call(this);return g.maskTarget?{...current,owner:{...current.owner,pid:800,instanceId:'a'.repeat(32),incompatible:true,disconnected:['ghost'],inventory:[{id:'ghost',pid:900}]}}:current;};
  PtyHostClient.prototype.restart=function(...args:Parameters<typeof restart>){g.maskTarget=false;return restart.apply(this,args);};
  PtyHostClient.prototype.sendRequest=function(socket:unknown,request:{type:string}){if(request.type==='shutdown')g.shutdownRequests++;return send.call(this,socket,request);};
  dialog.showMessageBox=(async(...args:Parameters<typeof dialog.showMessageBox>)=>{const options=args.at(-1) as {message:string;detail?:string};if(options.message!=='Work in progress will stop')return ask(...args);g.targetQuestions.push(options.detail??'');return{response:g.targetQuestions.length===1?0:1,checkboxChecked:false};}) as typeof dialog.showMessageBox;
 },join(__dirname,'..'));
 await fireShortcut(app,'open-settings');const settings=window.locator('.aya-modal--settings');await settings.getByTestId('settings-tab').filter({hasText:'Diagnostics'}).click();
 await settings.locator('.aya-settings-general-row',{hasText:'PTY host'}).getByRole('button',{name:'Restart'}).click();
 await expect.poll(()=>app.evaluate(()=>(globalThis as unknown as {targetQuestions:string[]}).targetQuestions.length)).toBe(2);
 const result=await app.evaluate(()=>{const g=globalThis as unknown as {targetQuestions:string[];shutdownRequests:number};return{questions:g.targetQuestions,shutdown:g.shutdownRequests};});
 expect(result.questions[0]).toContain('ghost (PID 900)');expect(result.questions[1]).toContain('host changed');
 for(const pane of before.panes){expect(result.questions[1]).toContain(`PID ${pane.pid}`);expect(result.questions[1]).toContain(pane.id==='tab-left'?'shell 1':'shell 2');}
 expect(result.shutdown).toBe(0);expect(hostPidsForHome(seeded.ayaHome)).toEqual(hosts);
 const after=JSON.parse(readFileSync(join(seeded.ayaHome,'pty-owner/record.json'),'utf8'));expect(after.pid).toBe(before.pid);expect(after.panes.map((p:{pid:number})=>p.pid)).toEqual(before.panes.map((p:{pid:number})=>p.pid));
 await window.keyboard.press('Escape');await expect(settings).not.toBeVisible();
 process.kill(hosts[0],'SIGKILL');await expect.poll(()=>hostPidsForHome(seeded.ayaHome).filter(pid=>pid!==hosts[0]).length).toBe(1);
 const pane=visiblePane(window,'shell 1');await expect(pane.getByTestId('terminal-history-notice')).toContainText('Previously consumed');
 const recovered=JSON.parse(readFileSync(join(seeded.ayaHome,'pty-owner/record.json'),'utf8'));expect(recovered.pid).toBe(before.pid);expect(recovered.panes.map((p:{pid:number})=>p.pid)).toEqual(before.panes.map((p:{pid:number})=>p.pid));
 await pane.getByTestId('xterm-host').click();await window.keyboard.type("printf 'AFTER_CANCEL_CRASH\\n'");await window.keyboard.press('Enter');await expect(pane.getByTestId('xterm-host')).toContainText('AFTER_CANCEL_CRASH');await expect.poll(()=>window.evaluate(()=>window.aya.ptyBuffer('tab-left'))).toContain('AFTER_CANCEL_CRASH\r\n');
 expect(await app.evaluate(()=>(globalThis as unknown as {shutdownRequests:number}).shutdownRequests)).toBe(0);
});
