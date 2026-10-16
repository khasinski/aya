import {join} from 'node:path';
import type {ElectronApplication} from '@playwright/test';

/** Capture the real main-owned client through an ordinary renderer request.
 * No capability is returned to the test or lent to another principal. */
export async function captureMainPtyClient(app:ElectronApplication):Promise<void>{
 await app.evaluate((_api,root)=>{
  const require=process.getBuiltinModule('module').createRequire(root+'/package.json');
  const {PtyHostClient}=require(root+'/dist-electron/pty-host-client.js'),original=PtyHostClient.prototype.request;
  PtyHostClient.prototype.request=function(...args:unknown[]){
   (globalThis as any).e2eMainPtyClient=this;PtyHostClient.prototype.request=original;
   return original.apply(this,args);
  };
 },join(__dirname,'../..'));
 const window=await app.firstWindow();await window.evaluate(()=>window.aya.ptyBuffer('tab-left'));
 await app.evaluate(()=>{if(!(globalThis as any).e2eMainPtyClient)throw Error('Main-owned PTY client was not captured');});
}
