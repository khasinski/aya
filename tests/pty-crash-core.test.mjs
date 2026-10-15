import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {isolateHome} from './helpers/isolate-home.mjs';
fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/crash-core-'));isolateHome(root);
const {parseRecoveryBootstrap}=await import('../dist-electron/pty-recovery-bootstrap.js');
const {cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(f){const end=Date.now()+7000;while(!f()){if(Date.now()>end)throw Error('crash fixture timeout');await sleep(2);}}
function start(mode,variant){
 const child=fork(new URL('./helpers/pty-crash-core.cjs',import.meta.url),[mode,variant],{execArgv:[],env:{...process.env,ELECTRON_RUN_AS_NODE:'1',AYA_PTY_OWNER_FD:'3'},stdio:['ignore','pipe','pipe','pipe','ipc']});
 child.stdio[3].on('error',()=>{});child.stdio[3].end(Buffer.alloc(32,mode==='next'&&variant==='wrong-secret'?18:17));
 let errors='';child.stderr.on('data',b=>{errors+=b;});child.stdout.resume();
 const result=new Promise((resolve,reject)=>{child.once('message',resolve);child.once('exit',code=>{if(code)reject(Error(`fixture exit${code}: ${errors}`));});});
 return {child,result};
}
for(const variant of ['agent','shell','exit-gap','mismatch','wrong-owner','missing-owner','wrong-secret'])test(`crash-only core attaches the same owner and child: ${variant}`,{timeout:20000},async()=>{
 fs.mkdirSync(process.env.AYA_HOME,{recursive:true});let old,next;
 try{
  old=start('old',variant);const bootstrap=await old.result;fs.writeFileSync(path.join(process.env.AYA_HOME,'bootstrap.json'),JSON.stringify(bootstrap));
  const gone=new Promise(r=>old.child.once('exit',r));old.child.kill('SIGKILL');await gone;
  fs.writeFileSync(path.join(process.env.AYA_HOME,'release'),'go');await wait(()=>fs.existsSync(path.join(process.env.AYA_HOME,'produced')));
  if(variant==='exit-gap')await wait(()=>{try{process.kill(bootstrap.panes[0].pid,0);return false;}catch{return true;}});
  next=start('next',variant);const result=await next.result;assert.equal(result[variant==='mismatch'?'mismatch':['wrong-owner','missing-owner','wrong-secret'].includes(variant)?'refused':'recovered'],true);
  if(['agent','shell','exit-gap'].includes(variant))assert.equal(result.exit,23);
 }finally{old?.child.kill('SIGKILL');next?.child.kill('SIGKILL');await cleanupNativeOwner(process.env.AYA_HOME);fs.rmSync(process.env.AYA_HOME,{recursive:true,force:true});}
});
test('recovery bootstrap is closed, bounded and rejects duplicate generations/IDs before attach',()=>{
 const request={ptyId:'p',command:'shell',cwd:'/',cols:80,rows:24};
 const value={format:1,kind:'crash',owner:{pid:123,startTime:'T',instanceId:'a'.repeat(32),binaryHash:'b'.repeat(64)},panes:[{id:'p',pid:124,generation:1,startIdentity:'1:2',request,launch:{command:'shell',cwd:'/'},spawnedAt:1}]};
 assert.deepEqual(parseRecoveryBootstrap(Buffer.from(JSON.stringify(value))),value);
 for(const mutate of [v=>{v.credential='secret';},v=>{v.owner.pid=1;},v=>{v.panes[0].generation=0;},v=>{v.panes[0].request.ptyId='other';},v=>{v.panes.push(v.panes[0]);},v=>{v.panes=Array(26).fill(v.panes[0]);},v=>{v.panes[0].startIdentity='unknown';},v=>{v.panes[0].request.env={TOKEN:'secret'};}]){
  const bad=structuredClone(value);mutate(bad);assert.throws(()=>parseRecoveryBootstrap(Buffer.from(JSON.stringify(bad))));
 }
 assert.throws(()=>parseRecoveryBootstrap(Buffer.alloc(1024*1024+1)),/length limit/);
});
