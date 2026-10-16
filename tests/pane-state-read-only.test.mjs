import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {envWithoutAya} from './helpers/env.mjs';
const exec=promisify(execFile);
async function child(home,source){const {stdout}=await exec(process.execPath,['-e',source],{env:{...envWithoutAya(),AYA_HOME:home,ELECTRON_RUN_AS_NODE:'1'},timeout:8000});return JSON.parse(stdout);}
const preamble=`const {PtyHostClient}=require('./dist-electron/pty-host-client');let starts=0;PtyHostClient.prototype.startHost=()=>{starts++;throw Error('MUST NOT START');};`;
for(const code of ['ENOENT','ECONNREFUSED'])test(`public cold paneState ${code} never starts/unlinks/creates a key or owner`,async()=>{
 const home=mkdtempSync(join(tmpdir(),'aya-state-missing-'));
 try{
  const result=await child(home,preamble+(code==='ECONNREFUSED'?`PtyHostClient.prototype.openSocket=async()=>{const e=Error('refused');e.code='ECONNREFUSED';throw e;};`:'')+`const fs=require('fs');let removes=0;for(const method of ['rmSync','unlinkSync'])fs[method]=()=>{removes++;throw Error('MUST NOT UNLINK');};(async()=>{const c=new PtyHostClient('/unused');try{const result=await c.paneState('saved');console.log(JSON.stringify({result,starts,removes}));}finally{c.dispose();c.dropSocket();}})();`);
  assert.equal(result.starts,0);assert.equal(result.removes,0);assert.equal(result.result.state,'unknown');assert.equal(result.result.hold,'terminal host not running');
  for(const path of ['pty-owner','pty-host-auth','pty-host.sock'])assert.equal(existsSync(join(home,path)),false);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('cold state observation ignores unsolicited spawn/snapshot/exit and sends only one snapshot RPC',async()=>{
 const home=mkdtempSync(join(tmpdir(),'aya-state-observe-')),requests=[];
 const snapshot={generation:'g',agent:'claude',shell:false,composerSeen:false,openedAt:0,lastOutputAt:0,cols:80,rows:['❯ '],cells:[[[0,'❯',0,0],[1,' ',0,0]]]};
 const sockets=new Set(),server=net.createServer(socket=>{
  sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));
  socket.write(JSON.stringify({type:'snapshot',ptyId:'p',snapshot,replay:true})+'\n');
  socket.write(JSON.stringify({type:'event',event:{type:'exit',ptyId:'p',exitCode:23,ownerExit:{generation:1,event:1}}})+'\n');
  let data='';socket.on('data',chunk=>{data+=chunk;while(data.includes('\n')){const end=data.indexOf('\n'),r=JSON.parse(data.slice(0,end));data=data.slice(end+1);requests.push(r);socket.write(JSON.stringify({id:r.id,ok:true,result:snapshot})+'\n');}});
 });
 await new Promise((done,fail)=>{server.once('error',fail);server.listen(join(home,'pty-host.sock'),done);});
 try{
  const r=await child(home,preamble+`(async()=>{const c=new PtyHostClient('/unused');try{const result=await c.paneState('p');console.log(JSON.stringify({result,starts}));}finally{c.dispose();c.dropSocket();}})();`);
  assert.equal(r.starts,0);assert.equal(r.result.state,'idle');assert.deepEqual(requests.map(r=>r.type),['snapshot']);assert.equal(requests[0].ptyId,'p');
  assert.equal(existsSync(join(home,'pty-owner')),false);assert.equal(existsSync(join(home,'pty-host-auth')),false);
 }finally{for(const s of sockets)s.destroy();await new Promise(done=>server.close(done));rmSync(home,{recursive:true,force:true});}
});
