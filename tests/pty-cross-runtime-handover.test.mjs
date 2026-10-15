import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {cleanupNativeOwner} from './helpers/pty-host.mjs';
const node=execFileSync('which',['node'],{encoding:'utf8'}).trim();
const electron=path.resolve('node_modules/electron/dist',process.platform==='darwin'?'Electron.app/Contents/MacOS/Electron':'electron');
for(const [from,to] of [[node,electron],[electron,node]])test(`planned runtime handover from ${from===node?'Node':'Electron'} to ${to===node?'Node':'Electron'} preserves real panes`,{timeout:30000},async()=>{
 fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/cross-runtime-')),home=path.join(root,'home'),aya=path.join(root,'aya'),children=[];
 fs.mkdirSync(home);fs.mkdirSync(aya);
 async function run(executable,role){
  const child=spawn(executable,['tests/helpers/pty-cross-runtime-handover.cjs',role],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',HOME:home,AYA_HOME:aya},stdio:['ignore','ignore','pipe','ipc']});children.push(child);
  let message,error='';child.on('message',m=>{message=m;});child.stderr.on('data',b=>{error+=b;});
  return new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>code===0&&message?resolve(message):reject(Error(`${role} ${code}/${signal}: ${error}`)));});
 }
 try{const old=await run(from,'old'),next=await run(to,'new');assert.notEqual(old.electron,next.electron);}
 finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await cleanupNativeOwner(aya);fs.rmSync(root,{recursive:true,force:true});}
});
