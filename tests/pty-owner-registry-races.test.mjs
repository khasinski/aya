import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
fs.mkdirSync('test-results',{recursive:true});const home=fs.mkdtempSync(path.resolve('test-results/owner-record-races-'));process.env.AYA_HOME=home;
const require=createRequire(import.meta.url),registry=require('../dist-electron/pty-owner-registry.js');
const file=path.join(home,'pty-owner/record.json');
const record={pid:process.pid,startTime:'original',executable:process.execPath,binaryHash:'a'.repeat(64),instanceId:'b'.repeat(32),jsPid:process.pid,jsStartTime:'reader',panes:[]};
after(()=>fs.rmSync(home,{recursive:true,force:true}));
function reset(){registry.prepareOwnerDirectory();fs.rmSync(file,{force:true});registry.writeOwnerRecord(record);}
test('owner publication creates a private exclusive temporary inode before any bytes and reads only the published path',()=>{
 reset();const write=fs.writeFileSync,open=fs.openSync;let writes=0,reads=0;
 try{
  fs.writeFileSync=(target,data,options)=>{if(String(target).startsWith(file+'.')){writes++;assert.deepEqual(options,{mode:0o600,flag:'wx'});}return write(target,data,options);};
  registry.writeOwnerRecord({...record,startTime:'next'});
  fs.openSync=(target,...args)=>{assert.equal(target,file);reads++;return open(target,...args);};
  assert.equal(registry.readOwnerRecord().startTime,'next');assert.equal(writes,1);assert.equal(reads,1);assert.equal(fs.statSync(file).mode&0o777,0o600);
 }finally{fs.writeFileSync=write;fs.openSync=open;}
});
for(const boundary of ['before-fstat','after-read'])test(`atomic replacement ${boundary} retries the new published inode, never the unlinked old record`,()=>{
 reset();const fstat=fs.fstatSync,read=fs.readSync;let replaced=false;
 const replace=()=>{if(!replaced){replaced=true;registry.writeOwnerRecord({...record,startTime:'replacement'});}};
 try{
  if(boundary==='before-fstat')fs.fstatSync=(...args)=>{replace();return fstat(...args);};
  else fs.readSync=(...args)=>{const n=read(...args);replace();return n;};
  assert.equal(registry.readOwnerRecord().startTime,'replacement');assert.equal(replaced,true);
 }finally{fs.fstatSync=fstat;fs.readSync=read;}
});
test('verified removal of the opened inode returns absent after a bounded retry',()=>{
 reset();const fstat=fs.fstatSync;let removed=false;
 try{fs.fstatSync=(...args)=>{if(!removed){removed=true;fs.unlinkSync(file);}return fstat(...args);};assert.equal(registry.readOwnerRecord(),null);}
 finally{fs.fstatSync=fstat;}
});
test('continuous atomic replacement exhausts three attempts and never returns stale or absent inventory',()=>{
 reset();const fstat=fs.fstatSync;let replacements=0;
 try{fs.fstatSync=(...args)=>{replacements++;registry.writeOwnerRecord({...record,startTime:String(replacements)});return fstat(...args);};assert.throws(()=>registry.readOwnerRecord(),/changed while reading/);assert.equal(replacements,3);}
 finally{fs.fstatSync=fstat;}
});
for(const kind of ['mode','hardlink','empty','oversized','symlink','fifo'])test(`unsafe ${kind} replacement is refused rather than retried as valid`,()=>{
 reset();const fstat=fs.fstatSync;let replaced=false;
 try{
  fs.fstatSync=(...args)=>{if(!replaced){replaced=true;registry.writeOwnerRecord({...record,startTime:'unsafe'});
   if(kind==='mode')fs.chmodSync(file,0o644);
   if(kind==='hardlink')fs.linkSync(file,file+'.link');
   if(kind==='empty')fs.truncateSync(file,0);
   if(kind==='oversized')fs.truncateSync(file,65537);
   if(kind==='symlink'){fs.renameSync(file,file+'.target');fs.symlinkSync(file+'.target',file);}
   if(kind==='fifo'){fs.unlinkSync(file);require('node:child_process').execFileSync('mkfifo',['-m','600',file]);}
  }return fstat(...args);};
  assert.throws(()=>registry.readOwnerRecord());
 }finally{fs.fstatSync=fstat;for(const suffix of ['', '.link','.target'])fs.rmSync(file+suffix,{force:true});}
});
test('an unsafe opened inode is refused even when a safe replacement is concurrently published',()=>{
 reset();fs.chmodSync(file,0o644);const fstat=fs.fstatSync;let replaced=false;
 try{fs.fstatSync=(...args)=>{if(!replaced){replaced=true;registry.writeOwnerRecord({...record,startTime:'safe replacement'});}return fstat(...args);};assert.throws(()=>registry.readOwnerRecord(),/not private/);}
 finally{fs.fstatSync=fstat;}
});
test('in-place mutation is not an atomic-replacement retry',()=>{
 reset();const read=fs.readSync;let writes=0;
 try{fs.readSync=(...args)=>{const count=read(...args);writes++;fs.appendFileSync(file,' ');return count;};assert.throws(()=>registry.readOwnerRecord(),/changed while reading/);assert.equal(writes,1);}
 finally{fs.readSync=read;}
});
