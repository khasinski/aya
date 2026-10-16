// Non-secret discovery metadata. Authentication lives only in process memory.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { AYA_HOME } from "./pty-host-paths";
import { readProcInfo } from "./pty-host-registry";
import type { OwnerPane } from "./pty-owner-client";
export const OWNER_DIRECTORY = path.join(AYA_HOME, "pty-owner");
export const OWNER_SOCKET = path.join(OWNER_DIRECTORY, "o");
const RECORD = path.join(OWNER_DIRECTORY, "record.json");
export interface OwnerRecord {
  pid: number; startTime: string; startIdentity?:string; executable: string; binaryHash: string;
  instanceId: string; jsPid: number; jsStartTime: string; panes: OwnerPane[]; uncertain?: string[]; recoveryFailures?: string[];
  spawnIntents?: Array<{ id: string; generation: string }>;
}
export function ownerBinaryHash(file: string): string { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
export function prepareOwnerDirectory(): void {
  fs.mkdirSync(OWNER_DIRECTORY, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(OWNER_DIRECTORY);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("PTY owner directory is not private");
}
export function readOwnerRecord(): OwnerRecord | null {
  let fd:number|undefined;
  try {
    const parent=fs.lstatSync(OWNER_DIRECTORY);
    if(!parent.isDirectory()||parent.uid!==process.getuid?.()||(parent.mode&0o077))throw new Error("PTY owner directory is not private");
    fd=fs.openSync(RECORD,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (stat.size<1||stat.size > 65536 || !stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)||stat.nlink!==1) throw new Error("PTY owner record is not private");
    const bytes=Buffer.alloc(stat.size);let offset=0;
    while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)throw new Error("Truncated PTY owner record");offset+=count;}
    const after=fs.fstatSync(fd),current=fs.lstatSync(RECORD),directory=fs.lstatSync(OWNER_DIRECTORY);
    if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||current.ino!==stat.ino||current.dev!==stat.dev||directory.ino!==parent.ino||directory.dev!==parent.dev)throw new Error("PTY owner record changed while reading");
    let r:OwnerRecord;
    try{r=JSON.parse(bytes.toString("utf8")) as OwnerRecord;}catch{throw new Error("Invalid PTY owner record");}
    if (!Number.isSafeInteger(r.pid) || r.pid < 2 || r.pid > 0x7fffffff || typeof r.startTime !== "string" || !r.startTime ||
        (r.startIdentity!==undefined&&(typeof r.startIdentity!=="string"||r.startIdentity.length>63||!/^\d+:\d+$/.test(r.startIdentity))) ||
        typeof r.executable !== "string" || !path.isAbsolute(r.executable) || typeof r.binaryHash !== "string" ||
        !/^[a-f0-9]{32}$/.test(r.instanceId) || !Number.isSafeInteger(r.jsPid) || r.jsPid < 2 ||
        typeof r.jsStartTime !== "string" || !r.jsStartTime || !/^(?:[a-f0-9]{64}|unknown)$/.test(r.binaryHash) ||
        (r.uncertain !== undefined && (!Array.isArray(r.uncertain) || r.uncertain.length > 25 || !r.uncertain.every(id => typeof id === "string" && Buffer.byteLength(id) <= 128))) ||
        (r.spawnIntents !== undefined && (!Array.isArray(r.spawnIntents) || r.spawnIntents.length > 25 || !r.spawnIntents.every(intent => typeof intent.id === "string" && Buffer.byteLength(intent.id) <= 128 && /^[a-f0-9]{32}$/.test(intent.generation)))) ||
        (r.recoveryFailures !== undefined && (!Array.isArray(r.recoveryFailures) || r.recoveryFailures.length > 50 || !r.recoveryFailures.every(reason => typeof reason === "string" && Buffer.byteLength(reason) <= 512))) ||
        !Array.isArray(r.panes) || r.panes.length > 25 ||
        !r.panes.every(p => typeof p.id === "string" && Buffer.byteLength(p.id) <= 128 &&
          (p.startIdentity === undefined || p.startIdentity === null || (typeof p.startIdentity === "string" && /^\d+:\d+$/.test(p.startIdentity))) &&
          (p.recoveryMembers === undefined || (Array.isArray(p.recoveryMembers) && p.recoveryMembers.length <= 32 && p.recoveryMembers.every(m => Number.isSafeInteger(m.pid) && m.pid > 1 && m.pid <= 0x7fffffff && (m.startIdentity === null || (typeof m.startIdentity === "string" && /^\d+:\d+$/.test(m.startIdentity)))))) &&
          Number.isSafeInteger(p.pid) && p.pid > 1 && p.pid <= 0x7fffffff && Number.isInteger(p.generation) && p.generation > 0 && p.generation <= 0xffffffff &&
          Number.isInteger(p.cols) && p.cols >= 2 && p.cols <= 1000 && Number.isInteger(p.rows) && p.rows >= 1 && p.rows <= 1000 &&
          typeof p.exited === "boolean" && typeof p.acknowledged === "boolean" &&
          (p.exitCode === null || (Number.isInteger(p.exitCode) && p.exitCode >= 0 && p.exitCode <= 255)) &&
          Number.isInteger(p.signal) && p.signal >= 0 && p.signal <= 64 && Number.isInteger(p.event) && p.event >= 0))
      throw new Error("Invalid PTY owner record");
    return r;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function ownerRecordIsLive(r: OwnerRecord): boolean {
  const p = readProcInfo(r.pid);
  if (p.probeFailed) throw new Error("Cannot verify the PTY owner process; its terminals were kept");
  return p.alive && p.startTime === r.startTime && !!p.command?.includes(r.executable);
}
export function ownerReaderIsLive(r: OwnerRecord): boolean {
  const p = readProcInfo(r.jsPid);
  if (p.probeFailed) throw new Error("Cannot verify the previous PTY reader; its terminals were kept");
  return p.alive && p.startTime === r.jsStartTime;
}
export function writeOwnerRecord(r: OwnerRecord): void {
  const bytes=JSON.stringify(r);if(Buffer.byteLength(bytes)>65536)throw new Error("PTY owner record length limit");
  const temporary = `${RECORD}.${process.pid}.${randomBytes(6).toString("hex")}`;
  try { fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, RECORD); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export function removeOwnerRecord(r: OwnerRecord): void {
  const current = readOwnerRecord();
  if (current?.instanceId === r.instanceId) fs.rmSync(RECORD, { force: true });
}
