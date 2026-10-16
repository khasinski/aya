import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {newHostAuthCapability}=require('../dist-electron/pty-host-auth-transfer.js');
const {HostSocketAuthenticator}=require('../dist-electron/pty-host-auth-transport.js');
const {ownerProcessStartIdentity}=require('../dist-electron/pty-owner-client.js');
import {envWithoutAya} from './helpers/env.mjs';
async function child(home,source,key){
 const c=spawn(process.execPath,['-e',source],{env:{...envWithoutAya(),AYA_HOME:home,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','pipe','pipe','ignore','ignore','pipe']});
 let out='',error='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>error+=b);c.stdio[5].on('error',()=>{});c.stdio[5].end(key?Buffer.from(key):Buffer.alloc(0));
 const timer=setTimeout(()=>c.kill('SIGKILL'),8000);
 try{return await new Promise((resolve,reject)=>{c.on('error',reject);c.on('exit',code=>{if(code!==0)return reject(Error('observer child failed: '+error));try{resolve(JSON.parse(out));}catch(e){reject(e);}});});}finally{clearTimeout(timer);}
}
const preamble=`const {PtyHostClient}=require('./dist-electron/pty-host-client');let starts=0;PtyHostClient.prototype.startHost=()=>{starts++;throw Error('MUST NOT START');};`;
for(const code of ['ENOENT','ECONNREFUSED'])test(`public cold paneState ${code} never starts/unlinks/creates a key or owner`,async()=>{
 const home=mkdtempSync(join(tmpdir(),'aya-state-missing-'));
 try{
  const result=await child(home,preamble+(code==='ECONNREFUSED'?`PtyHostClient.prototype.openSocket=async()=>{const e=Error('refused');e.code='ECONNREFUSED';throw e;};`:'')+`const fs=require('fs');let removes=0;for(const method of ['rmSync','unlinkSync'])fs[method]=()=>{removes++;throw Error('MUST NOT UNLINK');};(async()=>{const c=new PtyHostClient('/unused');try{const result=await c.paneState('saved');console.log(JSON.stringify({result,starts,removes}));}finally{c.dispose();c.dropSocket();}})();`);
  assert.equal(result.starts,0);assert.equal(result.removes,0);assert.equal(result.result.state,'unknown');assert.equal(result.result.hold,'terminal host not running');
  for(const path of ['pty-owner','pty-host-auth','pty-host.sock'])assert.equal(existsSync(join(home,path)),false);
 }finally{rmSync(home,{recursive:true,force:true});}
});

async function observingHost(snapshot,run){
 const home=mkdtempSync(join(tmpdir(),'aya-state-observe-')),requests=[],sockets=new Set();
 const key=newHostAuthCapability(),startIdentity=ownerProcessStartIdentity(process.pid);
 assert.ok(startIdentity);
 const authenticator=new HostSocketAuthenticator(key,{pid:process.pid,startIdentity},()=>{});
 const server=net.createServer(socket=>{
  sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));
  void authenticator.accept(socket).then(authenticated=>{
   socket.write(JSON.stringify({type:'snapshot',ptyId:'p',snapshot,replay:true})+'\n');
   socket.write(JSON.stringify({type:'event',event:{type:'exit',ptyId:'p',exitCode:23,ownerExit:{generation:1,event:1}}})+'\n');
   let data=authenticated.buffered;
   const consume=chunk=>{data+=String(chunk);while(data.includes('\n')){const end=data.indexOf('\n'),r=JSON.parse(data.slice(0,end));data=data.slice(end+1);requests.push(r);socket.write(JSON.stringify({id:r.id,ok:true,result:snapshot})+'\n');}};
   socket.on('data',consume);consume('');socket.resume();
  }).catch(()=>{});
 });
 await new Promise((done,fail)=>{server.once('error',fail);server.listen(join(home,'pty-host.sock'),done);});
 try{await run({home,requests,key});}
 finally{for(const s of sockets)s.destroy();await new Promise(done=>server.close(done));rmSync(home,{recursive:true,force:true});}
}
const observedSnapshot=(rows,extra={})=>({generation:'g',agent:'claude',shell:false,composerSeen:true,openedAt:0,lastOutputAt:0,cols:80,rows,cells:rows.map(r=>[...r].map((c,x)=>[x,c,0,0])),...extra});
const observe=(home,key)=>child(home,preamble+`(async()=>{const c=new PtyHostClient('/unused');const key=require('fs').readFileSync(5);if(key.length)c.hostAuthKey=key;try{const result=await c.paneState('p');console.log(JSON.stringify({result,starts}));}finally{c.dispose();c.dropSocket();}})();`,key);
for(const [label,snapshot,state] of [
 ['idle',observedSnapshot(['❯ ']),'idle'],
 ['busy',observedSnapshot(['esc to interrupt']),'busy'],
 ['unknown screen',observedSnapshot(['fragment'],{recoveryUnknown:true}),'unknown'],
 ['no screen evidence',observedSnapshot([]),'unknown'],
])test(`cold authenticated state observation: ${label}, only snapshot RPC and no metadata ACK`,()=>observingHost(snapshot,async({home,requests,key})=>{
 const r=await observe(home,key);
 assert.equal(r.starts,0);assert.equal(r.result.state,state);assert.deepEqual(requests.map(r=>r.type),['snapshot']);assert.equal(requests[0].ptyId,'p');
 assert.equal(existsSync(join(home,'pty-owner')),false);assert.equal(existsSync(join(home,'pty-host-auth')),false);
}));
for(const failure of ['missing','wrong'])test(`cold observer refuses ${failure} capability without sending snapshot or creating a host`,()=>observingHost(observedSnapshot(['esc to interrupt']),async({home,requests})=>{
 const keyPath=join(home,'pty-host-auth','key');
 if(failure==='wrong'){mkdirSync(join(home,'pty-host-auth'));writeFileSync(keyPath,Buffer.alloc(32,7));}
 const r=await observe(home,failure==='wrong'?Buffer.alloc(32,7):undefined);
 assert.equal(r.result.state,'unknown');assert.equal(r.result.busy,false);assert.equal(r.starts,0);assert.deepEqual(requests,[]);assert.equal(existsSync(join(home,'pty-owner')),false);
 if(failure==='missing')assert.equal(existsSync(keyPath),false);else assert.deepEqual(readFileSync(keyPath),Buffer.alloc(32,7));
}));
