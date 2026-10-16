// The former persistent capability API is intentionally removed. These are
// migration contracts: even an exact old disk key confers no authority.
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
fs.mkdirSync('test-results',{recursive:true});const root=fs.mkdtempSync(path.resolve('test-results/memory-auth-'));process.env.AYA_HOME=root;process.env.HOME=root;process.env.SHELL='/bin/sh';
const require=createRequire(import.meta.url),{PtyHostClient}=require('../dist-electron/pty-host-client.js');
const {waitFor,cleanupNativeOwner}=await import('./helpers/pty-host.mjs');
const main=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),folder=path.join(root,'pty-host-auth'),file=path.join(folder,'key');let key,pid,host;
before(async()=>{await main.spawn({ptyId:'kept',command:"exec /bin/sh -c 'stty -echo; printf MEMORY_READY; cat'",cwd:root,cols:80,rows:24});await waitFor(async()=>(await main.getBuffer('kept')).includes('MEMORY_READY'));key=Buffer.from(main.hostAuthKey);pid=await main.getPid('kept');host=(await main.hostStatus()).pid;});
after(async()=>{try{await main.shutdown();}finally{main.dispose();main.dropSocket();key?.fill(0);await cleanupNativeOwner(root);fs.rmSync(root,{recursive:true,force:true});}});
test('fresh main generates32bytes only in memory, passes inherited bootstrap and creates no capability path',()=>{
 assert.equal(key.length,32);assert.equal(fs.existsSync(folder),false);
 assert.equal(fs.existsSync('electron/pty-host-auth-key.ts'),false);
 for(const name of ['pty-host-client.ts','pty-host.ts','pty-host-auth-bootstrap.ts'])assert.doesNotMatch(fs.readFileSync(path.join('electron',name),'utf8'),/readHostAuthKey|createHostAuthKey|pty-host-auth\/key/);
});
for(const kind of ['exact-old-key','wrong-key','unsafe-mode','symlink','fifo','missing'])test(`old ${kind} artifact is ignored and untouched; only explicit in-memory authority works`,async()=>{
 fs.rmSync(folder,{recursive:true,force:true});fs.mkdirSync(folder,{mode:0o700});
 if(kind==='exact-old-key'||kind==='unsafe-mode')fs.writeFileSync(file,key,{mode:kind==='unsafe-mode'?0o644:0o600});
 if(kind==='wrong-key')fs.writeFileSync(file,Buffer.alloc(32,7),{mode:0o600});
 if(kind==='symlink'){fs.writeFileSync(path.join(root,'old-key-target'),key,{mode:0o600});fs.symlinkSync(path.join(root,'old-key-target'),file);}
 if(kind==='fifo')execFileSync('mkfifo',['-m','600',file]);
 const before=kind==='missing'?null:fs.lstatSync(file),open=fs.openSync,read=fs.readFileSync;let touches=0,starts=0;
 const cold=new PtyHostClient(path.resolve('dist-electron/pty-host.js')),authorized=new PtyHostClient(path.resolve('dist-electron/pty-host.js'));authorized.hostAuthKey=Buffer.from(key);
 cold.startHost=()=>{starts++;throw Error('cold read must not create a host');};
 try{
  const guard=(original)=>(name,...args)=>{if(name===file){touches++;throw Error('old key must never be read');}return original(name,...args);};fs.openSync=guard(open);fs.readFileSync=guard(read);
  assert.equal(await cold.getPid('kept'),undefined);await assert.rejects(cold.spawn({ptyId:'kept',command:'cat',cwd:root,cols:80,rows:24,attachOnly:true}),error=>error.code==='PTY_HOST_AUTH_REQUIRED');assert.equal(starts,0);
  assert.equal(await authorized.getPid('kept'),pid);assert.equal((await main.hostStatus()).pid,host);assert.equal(touches,0);
  if(before){const after=fs.lstatSync(file);assert.equal(after.ino,before.ino);assert.equal(after.mode,before.mode);assert.equal(after.size,before.size);}else assert.equal(fs.existsSync(file),false);
 }finally{fs.openSync=open;fs.readFileSync=read;cold.dispose();authorized.dispose();}
});
