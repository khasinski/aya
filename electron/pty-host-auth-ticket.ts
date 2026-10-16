// Nonce/identity only. No authentication or owner credential belongs on disk.
import * as fs from "node:fs/promises";
import {constants} from "node:fs";
import type {Stats} from "node:fs";
import {randomBytes} from "node:crypto";
import {performance} from "node:perf_hooks";
import * as path from "node:path";
import {parseCheckpointJson} from "./vt-checkpoint-schema";
import {AUTH_TRANSFER_WINDOW_MS,AUTH_QUIT_PUBLICATION_MS,type AuthTransferReservation} from "./pty-host-auth-transfer";
export interface AuthTransferTicket extends AuthTransferReservation {format:2;nonce:string;hostPid:number;hostStartIdentity:string}
export const AUTH_TRANSFER_TICKET_BYTES=1024;
/** Unique per-attempt paths keep late cleanup away from every successor's
 * ticket. The startup locator will scan this fixed filename grammar only. */
export function authTransferTicketPath(home:string,attempt:string):string{
 if(!/^[a-f0-9]{64}$/.test(attempt))throw new AuthTransferTicketError();
 return path.join(home,`pty-handover.${attempt}.json`);
}
export class AuthTransferTicketError extends Error {constructor(){super("Terminal host transfer ticket is unavailable");}}
type TicketIO=Pick<typeof fs,"open"|"lstat"|"rename"|"unlink">;
export interface AuthTransferTicketBudget {deadline:number;now?:()=>number;signal?:AbortSignal;io?:TicketIO;scanIO?:Pick<typeof fs,"opendir"|"lstat">}
const same=(a:Stats,b:Stats):boolean=>a.dev===b.dev&&a.ino===b.ino;
function safe(stat:Stats):boolean{return stat.isFile()&&stat.uid===process.getuid?.()&&(stat.mode&0o7777)===0o600&&stat.nlink===1&&stat.size>0&&stat.size<=AUTH_TRANSFER_TICKET_BYTES;}
function valid(value:unknown,now:number):value is AuthTransferTicket{
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const t=value as AuthTransferTicket;
 return Object.keys(t).sort().join(",")==="attempt,deadline,format,hostPid,hostStartIdentity,nonce,purpose"&&t.format===2&&
  (t.purpose==="ordinary-quit"||t.purpose==="planned-update")&&typeof t.attempt==="string"&&/^[a-f0-9]{64}$/.test(t.attempt)&&typeof t.nonce==="string"&&/^[a-f0-9]{64}$/.test(t.nonce)&&
  Number.isSafeInteger(t.deadline)&&t.deadline>now&&t.deadline-now<=AUTH_TRANSFER_WINDOW_MS&&Number.isSafeInteger(t.hostPid)&&t.hostPid>1&&typeof t.hostStartIdentity==="string"&&/^\d+:\d+$/.test(t.hostStartIdentity)&&t.hostStartIdentity.length<=63;
}
/** The caller's one monotonic budget starts before reservation. Async I/O may
 * finish late, but no later phase may run and no caller may activate it. */
export async function withinAuthTransferBudget<T>(budget:AuthTransferTicketBudget,operation:(check:()=>void)=>Promise<T>):Promise<T>{
 const now=budget.now??(()=>performance.now());let expired=false,timer:ReturnType<typeof setTimeout>|undefined;
 const check=()=>{if(expired||budget.signal?.aborted||now()>=budget.deadline)throw new AuthTransferTicketError();};
 let cancel=()=>{};
 const timeout=new Promise<never>((_resolve,reject)=>{
  cancel=()=>{expired=true;reject(new AuthTransferTicketError());};
  timer=setTimeout(cancel,Math.max(0,budget.deadline-now()));budget.signal?.addEventListener("abort",cancel,{once:true});
 });
 try{check();const result=await Promise.race([operation(check),timeout]);check();return result;}
 finally{if(timer)clearTimeout(timer);budget.signal?.removeEventListener("abort",cancel);}
}
async function unlinkOwned(io:TicketIO,file:string,owned:Stats):Promise<void>{
 try{const current=await io.lstat(file);if(current.isFile()&&same(current,owned))await io.unlink(file);}
 catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
}
/** Publication does not activate host authority. The caller must reserve a
 * non-redeemable slot first and activate only after in-budget success. */
export async function writeAuthTransferTicket(file:string,ticket:AuthTransferTicket,budget:AuthTransferTicketBudget):Promise<void>{
 if(!valid(ticket,Date.now())||path.basename(file)!==path.basename(authTransferTicketPath(".",ticket.attempt)))throw new AuthTransferTicketError();
 const io=budget.io??fs,temporary=`${file}.${randomBytes(8).toString("hex")}.tmp`,data=Buffer.from(JSON.stringify(ticket));
 if(data.length>AUTH_TRANSFER_TICKET_BYTES)throw new AuthTransferTicketError();
 await withinAuthTransferBudget(budget,async check=>{
  let handle:Awaited<ReturnType<typeof fs.open>>|undefined,owned:Stats|undefined,published=false;
  try{
   check();handle=await io.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
   // Record the exclusively created inode even if opening finished late, so
   // asynchronous cleanup can remove only this attempt's own temporary file.
   owned=await handle.stat();check();
   if(!owned.isFile()||owned.uid!==process.getuid?.()||(owned.mode&0o7777)!==0o600||owned.nlink!==1)throw new AuthTransferTicketError();
   await handle.writeFile(data);check();await handle.sync();check();await handle.close();handle=undefined;check();
   await io.rename(temporary,file);published=true;check();
  }catch(error){
   if(handle)await handle.close().catch(()=>{});
   if(owned)await unlinkOwned(io,published?file:temporary,owned).catch(()=>{});
   throw error;
  }
 }).catch(()=>{throw new AuthTransferTicketError();});
}
/** Consume only the opened inode. The payload is nonce/identity data, bounded
 * before JSON parse; an unsafe type is refused without waiting on a FIFO. */
export async function readAuthTransferTicket(file:string,budget:AuthTransferTicketBudget={deadline:performance.now()+AUTH_QUIT_PUBLICATION_MS}):Promise<AuthTransferTicket|null>{
 const io=budget.io??fs;
 return withinAuthTransferBudget(budget,async check=>{
  let handle:Awaited<ReturnType<typeof fs.open>>;
  try{check();handle=await io.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw new AuthTransferTicketError();}
  try{
   const before=await handle.stat();check();if(!safe(before))throw new AuthTransferTicketError();
   const data=Buffer.alloc(AUTH_TRANSFER_TICKET_BYTES+1);let size=0;
   for(;;){check();const {bytesRead}=await handle.read(data,size,data.length-size,null);size+=bytesRead;check();if(!bytesRead||size===data.length)break;}
   const after=await handle.stat(),named=await io.lstat(file);check();
   if(size!==before.size||!safe(after)||!safe(named)||!same(before,after)||!same(after,named)||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new AuthTransferTicketError();
   await io.unlink(file);check();
   const ticket=parseCheckpointJson(data.subarray(0,size),AUTH_TRANSFER_TICKET_BYTES);
   if(!valid(ticket,Date.now())||path.basename(file)!==path.basename(authTransferTicketPath(".",ticket.attempt)))throw new AuthTransferTicketError();return ticket;
  }finally{await handle.close();}
 }).catch(()=>{throw new AuthTransferTicketError();});
}

/** Startup discovery reads only fixed attempt names, with bounded directory
 * iteration and a single parent deadline. AYA_HOME may be0755: filenames
 * contain attempts, not nonces, and every payload remains owner-only0600.
 * Group/world-writable or symlink roots refuse. Ambiguity never chooses a winner. */
export async function findAuthTransferTicket(home:string,budget:AuthTransferTicketBudget={deadline:performance.now()+AUTH_QUIT_PUBLICATION_MS}):Promise<AuthTransferTicket|null>{
 const io=budget.scanIO??fs;
 return withinAuthTransferBudget(budget,async check=>{
  let directory:Awaited<ReturnType<typeof fs.opendir>>|undefined;
  try{
   check();const before=await io.lstat(home);check();
   if(!before.isDirectory()||before.uid!==process.getuid?.()||(before.mode&0o022)!==0)throw new AuthTransferTicketError();
   directory=await io.opendir(home);check();
   let candidate:string|undefined,count=0;
   for(;;){
    const entry=await directory.read();check();if(!entry)break;
    if(++count>256)throw new AuthTransferTicketError();
    if(!/^pty-handover\.[a-f0-9]{64}\.json$/.test(entry.name))continue;
    if(candidate)throw new AuthTransferTicketError();
    candidate=path.join(home,entry.name);
   }
   await directory.close();directory=undefined;check();
   const after=await io.lstat(home);check();
   if(!after.isDirectory()||!same(before,after)||after.uid!==process.getuid?.()||(after.mode&0o022)!==0)throw new AuthTransferTicketError();
   return candidate?await readAuthTransferTicket(candidate,budget):null;
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
  finally{if(directory)await directory.close();}
 }).catch(()=>{throw new AuthTransferTicketError();});
}

/** Cancellation is nonce- and inode-bound. It may remove an expired attempt,
 * but never a different nonce or an unsafe file. Unlink, once submitted, is
 * irreversible; callers must also cancel the host's independent slot. */
export async function cancelAuthTransferTicket(file:string,attempt:string,nonce:string,budget:AuthTransferTicketBudget={deadline:performance.now()+AUTH_QUIT_PUBLICATION_MS}):Promise<void>{
 if(!/^[a-f0-9]{64}$/.test(attempt)||!/^[a-f0-9]{64}$/.test(nonce)||path.basename(file)!==path.basename(authTransferTicketPath(".",attempt)))throw new AuthTransferTicketError();
 const io=budget.io??fs;
 return withinAuthTransferBudget(budget,async check=>{
  let handle:Awaited<ReturnType<typeof fs.open>>;
  try{check();handle=await io.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
  try{
   const before=await handle.stat();check();if(!safe(before))throw new AuthTransferTicketError();
   const data=Buffer.alloc(AUTH_TRANSFER_TICKET_BYTES+1);let size=0;
   for(;;){check();const {bytesRead}=await handle.read(data,size,data.length-size,null);size+=bytesRead;check();if(!bytesRead||size===data.length)break;}
   const after=await handle.stat(),named=await io.lstat(file);check();
   if(size!==before.size||!safe(after)||!safe(named)||!same(before,after)||!same(after,named)||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new AuthTransferTicketError();
   const ticket=parseCheckpointJson(data.subarray(0,size),AUTH_TRANSFER_TICKET_BYTES) as Partial<AuthTransferTicket>|null;
   if(!ticket||ticket.attempt!==attempt||ticket.nonce!==nonce)return;
   check();await io.unlink(file);check();
  }finally{await handle.close();}
 }).catch(()=>{throw new AuthTransferTicketError();});
}
