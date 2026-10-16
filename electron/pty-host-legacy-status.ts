// Main-only migration probe. New hosts never expose an unauthenticated RPC.
// Every fact below is labelled old-host-reported; stop identity is independent.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {AYA_HOME,PTY_HOST_SOCKET_PATH} from './pty-host-paths';
import {readProcInfo} from './pty-host-registry';
import {handoverPeer} from './pty-handover-window';
import {ownerProcessStartIdentity} from './pty-owner-client';
import {parseCheckpointJson} from './vt-checkpoint-schema';
import type {HostAuthPeer} from './pty-host-auth';
export interface LegacyInventory {reportedIds:string[];unknownCount:number;total:number}
const versions=new Set(['0.1.0','0.2.0','0.3.0','0.4.0','0.5.0','0.5.0-beta','0.6.0','0.7.0','0.7.1','0.7.2','0.7.3','0.7.4','0.7.5','0.7.6','0.7.7','0.7.8','0.7.9','0.8.0','0.9.0','0.10.0','0.11.0','0.12.0']);
const same=(a:fs.Stats,b:fs.Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.mode===b.mode&&a.uid===b.uid;
function legacyRecord(peer:HostAuthPeer):{version:string;scriptHash:string;startTime:string}|null{
 try{
  const dir=path.join(AYA_HOME,'pty-hosts'),parent=fs.lstatSync(dir);
  if(!parent.isDirectory()||parent.uid!==process.getuid?.()||(parent.mode&0o022))return null;
  const file=path.join(dir,`${peer.pid}.json`),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
   const stat=fs.fstatSync(fd);
   if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o7777)!==0o600||stat.nlink!==1||stat.size<1||stat.size>16384)return null;
   const bytes=Buffer.alloc(stat.size);let offset=0;while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)return null;offset+=count;}
   if(!same(stat,fs.fstatSync(fd))||!same(stat,fs.lstatSync(file))||parent.dev!==fs.lstatSync(dir).dev||parent.ino!==fs.lstatSync(dir).ino)return null;
   const value=parseCheckpointJson(bytes,16384) as Record<string,unknown>,info=readProcInfo(peer.pid);
   if(value.pid!==peer.pid||value.pgid!==peer.pid||value.authProtocol!==undefined||typeof value.version!=='string'||!versions.has(value.version)||typeof value.scriptHash!=='string'||!/^[a-f0-9]{64}$/.test(value.scriptHash)||typeof value.startTime!=='string'||info.probeFailed||!info.alive||info.startTime!==value.startTime||ownerProcessStartIdentity(peer.pid)!==peer.startIdentity)return null;
   return {version:value.version,scriptHash:value.scriptHash,startTime:value.startTime};
  }finally{fs.closeSync(fd);}
 }catch{return null;}
}
/** At most26 read-only requests,64KiB total input,16KiB/frame,1s total. */
export async function probeLegacyInventory(peer:HostAuthPeer,ids:readonly string[]):Promise<LegacyInventory|null>{
 const record=legacyRecord(peer);if(!record)return null;
 const candidates=[...new Set(ids.filter(id=>typeof id==='string'&&id.length>0&&id.length<=256))].slice(0,25);
 return new Promise(resolve=>{
  let settled=false,buffer='',received=0,nextId=710000,index=-1,total=0;const reportedIds:string[]=[];
  const finish=(result:LegacyInventory|null)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();resolve(result);};
  const timer=setTimeout(()=>finish(null),1000);
  const socket=net.createConnection(PTY_HOST_SOCKET_PATH,()=>{
   try{const actual=handoverPeer(socket);if(actual.pid!==peer.pid||actual.startIdentity!==peer.startIdentity)return finish(null);socket.write(JSON.stringify({id:nextId,type:'version'})+'\n');}catch{finish(null);}
  });
  const complete=()=>{const after=legacyRecord(peer);if(!after||after.version!==record.version||after.scriptHash!==record.scriptHash||after.startTime!==record.startTime||reportedIds.length>total)return finish(null);finish({reportedIds,unknownCount:total-reportedIds.length,total});};
  socket.on('error',()=>finish(null));socket.on('close',()=>finish(null));
  socket.on('data',bytes=>{
   if(settled)return;received+=bytes.length;if(received>65536)return finish(null);buffer+=bytes.toString('utf8');
   try{
    let end;while((end=buffer.indexOf('\n'))>=0){
     const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(Buffer.byteLength(line)>16384)return finish(null);
     const reply=parseCheckpointJson(Buffer.from(line),16384) as Record<string,unknown>;
     // Broadcast terminal data is deliberately ignored, never fed to a sink.
     if(reply.type==='event')continue;
     if(reply.id!==nextId||reply.ok!==true)return finish(null);
     const value=reply.result as Record<string,unknown>|null;
     if(index===-1){
      if(!value||value.pid!==peer.pid||value.version!==record.version||value.scriptHash!==record.scriptHash||!Number.isSafeInteger(value.ptyCount)||Number(value.ptyCount)<0||Number(value.ptyCount)>25)return finish(null);
      total=Number(value.ptyCount);
     }else if(value!==null){
      if(!value||typeof value!=='object'||!Number.isInteger(value.cols)||!Number.isInteger(value.rows)||Number(value.cols)<1||Number(value.cols)>1000||Number(value.rows)<1||Number(value.rows)>500||(value.alt!==undefined&&typeof value.alt!=='boolean'))return finish(null);
      reportedIds.push(candidates[index]);
     }
     if(++index>=candidates.length)return complete();
     nextId++;socket.write(JSON.stringify({id:nextId,type:'size',ptyId:candidates[index]})+'\n');
    }
    if(Buffer.byteLength(buffer)>16384)finish(null);
   }catch{finish(null);}
  });
 });
}
