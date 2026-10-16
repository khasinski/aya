import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test,expect,hostPidsForHome} from './fixtures';
import {waitForShellReady} from './helpers/terminal';
import {fireShortcut} from './helpers/shortcut';
test('a changed restart target asks again and Cancel stops neither host nor panes',async({app,window,seeded})=>{
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
 window.once('dialog',dialog=>void dialog.accept());await settings.locator('.aya-settings-general-row',{hasText:'PTY host'}).getByRole('button',{name:'Restart'}).click();
 await expect.poll(()=>app.evaluate(()=>(globalThis as unknown as {targetQuestions:string[]}).targetQuestions.length)).toBe(2);
 const result=await app.evaluate(()=>{const g=globalThis as unknown as {targetQuestions:string[];shutdownRequests:number};return{questions:g.targetQuestions,shutdown:g.shutdownRequests};});
 expect(result.questions[0]).toContain('ghost (PID 900)');expect(result.questions[1]).toContain('host changed');
 for(const pane of before.panes)expect(result.questions[1]).toContain(`PID ${pane.pid}`);
 expect(result.shutdown).toBe(0);expect(hostPidsForHome(seeded.ayaHome)).toEqual(hosts);
 const after=JSON.parse(readFileSync(join(seeded.ayaHome,'pty-owner/record.json'),'utf8'));expect(after.pid).toBe(before.pid);expect(after.panes.map((p:{pid:number})=>p.pid)).toEqual(before.panes.map((p:{pid:number})=>p.pid));
});
