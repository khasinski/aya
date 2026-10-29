import {readFileSync,writeFileSync,unlinkSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {test,expect,hostPidsForHome,closeAndWait,ciElectronFlags,launchE2eElectron} from './fixtures';
import {appEnv} from './helpers/seed';
import {waitForShellReady} from './helpers/terminal';
test.use({seedOptions:{launchEnv:{AYA_E2E_PTY_SHUTDOWN:'0'}}});
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
for(const shutdown of [true,false])test(`a socketless host gets a bounded shutdown grace before creation or consent: shutdown=${shutdown}`,async({app,window,seeded})=>{
 await waitForShellReady(window);const root=join(__dirname,'..'),old=hostPidsForHome(seeded.ayaHome)[0],before=JSON.parse(readFileSync(join(seeded.ayaHome,'pty-owner/record.json'),'utf8')),socket=join(seeded.ayaHome,'pty-host.sock');expect(old).toBeGreaterThan(1);
 if(shutdown){
  await app.evaluate((_api,root)=>{const require=process.getBuiltinModule('module').createRequire(root+'/package.json'),{PtyHostClient}=require(root+'/dist-electron/pty-host-client.js'),request=PtyHostClient.prototype.request;PtyHostClient.prototype.request=function(...args:unknown[]){(globalThis as any).shutdownClient=this;return request.apply(this,args);};},root);
  await window.evaluate(()=>window.aya.ptyBuffer('tab-left'));
  await app.evaluate(()=>{void (globalThis as any).shutdownClient.shutdown();});
  await expect.poll(()=>existsSync(socket)).toBe(false);expect(alive(old)).toBe(true);
 }else unlinkSync(socket);
 const entry=join(seeded.root,'shutdown-grace-main.js');
 writeFileSync(entry,`const {dialog}=require('electron');global.graceQuestions=[];dialog.showMessageBox=async(...args)=>{const o=args.at(-1);global.graceQuestions.push(o);return {response:o.buttons?.length===1?0:1,checkboxChecked:false};};const {PtyHostClient}=require(require('node:path').join(process.env.AYA_TEST_APP_ROOT,'dist-electron/pty-host-client.js'));const {ownerProcessStartIdentity}=require(require('node:path').join(process.env.AYA_TEST_APP_ROOT,'dist-electron/pty-owner-client.js'));const start=PtyHostClient.prototype.startHost;global.graceStarts=[];PtyHostClient.prototype.startHost=function(...args){global.graceStarts.push({oldGone:ownerProcessStartIdentity(Number(process.env.AYA_TEST_OLD_HOST_PID))===null});return start.apply(this,args);};require(require('node:path').join(process.env.AYA_TEST_APP_ROOT,'dist-electron/main.js'));`);
 const started=Date.now(),next=await launchE2eElectron({cwd:root,args:[entry,`--user-data-dir=${join(seeded.root,'second-profile')}`,...ciElectronFlags()],env:appEnv({...seeded,launchEnv:{...seeded.launchEnv,AYA_TEST_APP_ROOT:root,AYA_TEST_OLD_HOST_PID:String(old)}})});
 try{
  await next.firstWindow({timeout:7000});const questions=await next.evaluate(()=>(globalThis as any).graceQuestions),starts=await next.evaluate(()=>(globalThis as any).graceStarts);
  if(shutdown){expect(questions).toEqual([]);expect(starts).toEqual([{oldGone:true}]);expect(alive(old)).toBe(false);await expect.poll(()=>hostPidsForHome(seeded.ayaHome).filter(pid=>pid!==old).length).toBe(1);}
  else{expect(Date.now()-started).toBeGreaterThanOrEqual(2800);expect(questions.some((q:{message:string})=>q.message==='Stop the other terminal host?')).toBe(true);expect(starts).toEqual([]);expect(alive(old)).toBe(true);expect(existsSync(socket)).toBe(false);for(const pane of before.panes)expect(alive(pane.pid)).toBe(true);}
 }finally{await closeAndWait(next);}
});
