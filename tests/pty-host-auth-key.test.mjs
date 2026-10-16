import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {readHostAuthKey,createHostAuthKey,HOST_AUTH_KEY_DIRECTORY}=require('../dist-electron/pty-host-auth-key.js');
function home(fn){fs.mkdirSync('test-results',{recursive:true});const dir=fs.mkdtempSync(path.resolve('test-results/host-auth-key-'));try{return fn(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}}
const file=home=>path.join(home,HOST_AUTH_KEY_DIRECTORY,'key');
test('only explicit main creation creates a private stable per-home capability; reads are independent copies',()=>home(dir=>{
 assert.throws(()=>readHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});assert.equal(fs.existsSync(file(dir)),false);
 const first=createHostAuthKey(dir);assert.equal(first.length,32);
 assert.equal(fs.statSync(path.dirname(file(dir))).mode&0o777,0o700);assert.equal(fs.statSync(file(dir)).mode&0o777,0o600);
 assert.deepEqual(readHostAuthKey(dir),first);assert.deepEqual(createHostAuthKey(dir),first);
 const copy=readHostAuthKey(dir);copy.fill(0);assert.deepEqual(readHostAuthKey(dir),first);
 home(other=>assert.notDeepEqual(createHostAuthKey(other),first));
}));
test('missing, truncated, oversized and wrong-mode files are refused without repair or replacement',()=>home(dir=>{
 createHostAuthKey(dir);
 for(const size of [0,31,33,4096]){
  fs.writeFileSync(file(dir),Buffer.alloc(size,9));const before=fs.statSync(file(dir));
  assert.throws(()=>readHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});assert.throws(()=>createHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});
  assert.equal(fs.statSync(file(dir)).ino,before.ino);assert.equal(fs.statSync(file(dir)).size,size);
 }
 fs.writeFileSync(file(dir),Buffer.alloc(32));fs.chmodSync(file(dir),0o644);
 assert.throws(()=>createHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});assert.equal(fs.statSync(file(dir)).mode&0o777,0o644);
 fs.unlinkSync(file(dir));assert.throws(()=>readHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});assert.equal(fs.existsSync(file(dir)),false);
}));
test('symlink, hardlink, directory and FIFO keys promptly refuse, retaining the original objects',()=>home(dir=>{
 createHostAuthKey(dir);const target=path.join(dir,'target');fs.renameSync(file(dir),target);
 for(const setup of [()=>fs.symlinkSync(target,file(dir)),()=>fs.linkSync(target,file(dir)),()=>fs.mkdirSync(file(dir)),()=>execFileSync('mkfifo',[file(dir)])]){
  setup();const before=fs.lstatSync(file(dir));const began=performance.now();
  assert.throws(()=>readHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});assert.throws(()=>createHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});
  assert.ok(performance.now()-began<1000);assert.equal(fs.lstatSync(file(dir)).ino,before.ino);
  fs.rmSync(file(dir),{recursive:true});
 }
 assert.equal(fs.statSync(target).size,32);
}));
test('unsafe capability directory and another owner are refused without chmod',()=>home(dir=>{
 const expected=createHostAuthKey(dir),folder=path.dirname(file(dir));fs.chmodSync(folder,0o755);
 assert.throws(()=>readHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});assert.throws(()=>createHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});
 assert.equal(fs.statSync(folder).mode&0o777,0o755);fs.chmodSync(folder,0o700);
 const original=fs.fstatSync;
 try{fs.fstatSync=(...args)=>{const stat=original(...args);stat.uid++;return stat;};assert.throws(()=>readHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});}
 finally{fs.fstatSync=original;}
 assert.deepEqual(readHostAuthKey(dir),expected);
 fs.renameSync(folder,folder+'-real');fs.symlinkSync(folder+'-real',folder);
 assert.throws(()=>createHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});
}));
test('an unreadable existing key is not repaired, removed or replaced',()=>home(dir=>{
 const expected=createHostAuthKey(dir),before=fs.statSync(file(dir)),open=fs.openSync;
 try{
  fs.openSync=(name,...args)=>{if(name===file(dir))throw Object.assign(new Error('private injected read denial'),{code:'EACCES'});return open(name,...args);};
  assert.throws(()=>readHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});
  assert.throws(()=>createHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});
 }finally{fs.openSync=open;}
 assert.equal(fs.statSync(file(dir)).ino,before.ino);assert.deepEqual(readHostAuthKey(dir),expected);
}));
test('failed creation removes only its own incomplete inode, without replacing another file',()=>home(dir=>{
 const write=fs.writeFileSync;
 try{
  fs.writeFileSync=(...args)=>{if(typeof args[0]==='number')throw new Error('injected storage failure');return write(...args);};
  assert.throws(()=>createHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});
 }finally{fs.writeFileSync=write;}
 assert.equal(fs.existsSync(file(dir)),false);assert.equal(createHostAuthKey(dir).length,32);
}));
test('a racing creator refuses a pending writer without repairing its incomplete file',()=>home(dir=>{
 const write=fs.writeFileSync;let raced=false,refused=false;
 try{
  fs.writeFileSync=(...args)=>{
   if(typeof args[0]==='number'&&!raced){
    raced=true;assert.equal(fs.statSync(file(dir)).size,0);const inode=fs.statSync(file(dir)).ino;
    assert.throws(()=>createHostAuthKey(dir),{code:'PTY_HOST_AUTH_UNAVAILABLE'});refused=true;
    assert.equal(fs.statSync(file(dir)).ino,inode);assert.equal(fs.statSync(file(dir)).size,0);
   }
   return write(...args);
  };
  const winner=createHostAuthKey(dir);assert.ok(refused);assert.deepEqual(readHostAuthKey(dir),winner);assert.deepEqual(createHostAuthKey(dir),winner);
 }finally{fs.writeFileSync=write;}
}));
