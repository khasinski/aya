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
  pid: number; startTime: string; executable: string; binaryHash: string;
  instanceId: string; jsPid: number; jsStartTime: string; panes: OwnerPane[]; uncertain?: string[];
}
export function ownerBinaryHash(file: string): string { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
export function prepareOwnerDirectory(): void {
  fs.mkdirSync(OWNER_DIRECTORY, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(OWNER_DIRECTORY);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("PTY owner directory is not private");
}
export function readOwnerRecord(): OwnerRecord | null {
  try {
    const stat = fs.lstatSync(RECORD);
    if (stat.size > 65536 || !stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("PTY owner record is not private");
    const r = JSON.parse(fs.readFileSync(RECORD, "utf8")) as OwnerRecord;
    if (!Number.isSafeInteger(r.pid) || r.pid < 2 || typeof r.startTime !== "string" || !r.startTime ||
        typeof r.executable !== "string" || !path.isAbsolute(r.executable) || typeof r.binaryHash !== "string" ||
        !/^[a-f0-9]{32}$/.test(r.instanceId) || !Number.isSafeInteger(r.jsPid) || r.jsPid < 2 ||
        typeof r.jsStartTime !== "string" || !r.jsStartTime || !/^(?:[a-f0-9]{64}|unknown)$/.test(r.binaryHash) ||
        (r.uncertain !== undefined && (!Array.isArray(r.uncertain) || r.uncertain.length > 25 || !r.uncertain.every(id => typeof id === "string" && Buffer.byteLength(id) <= 128))) ||
        !Array.isArray(r.panes) || r.panes.length > 25 ||
        !r.panes.every(p => typeof p.id === "string" && Buffer.byteLength(p.id) <= 128 &&
          Number.isSafeInteger(p.pid) && p.pid > 1 && Number.isInteger(p.generation) && p.generation > 0 && p.generation <= 0xffffffff &&
          Number.isInteger(p.cols) && p.cols >= 2 && p.cols <= 1000 && Number.isInteger(p.rows) && p.rows >= 1 && p.rows <= 1000 &&
          typeof p.exited === "boolean" && typeof p.acknowledged === "boolean" &&
          (p.exitCode === null || (Number.isInteger(p.exitCode) && p.exitCode >= 0 && p.exitCode <= 255)) &&
          Number.isInteger(p.signal) && p.signal >= 0 && p.signal <= 64 && Number.isInteger(p.event) && p.event >= 0))
      throw new Error("Invalid PTY owner record");
    return r;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
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
  const temporary = `${RECORD}.${process.pid}.${randomBytes(6).toString("hex")}`;
  try { fs.writeFileSync(temporary, JSON.stringify(r), { mode: 0o600, flag: "wx" }); fs.renameSync(temporary, RECORD); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export function removeOwnerRecord(r: OwnerRecord): void {
  const current = readOwnerRecord();
  if (current?.instanceId === r.instanceId) fs.rmSync(RECORD, { force: true });
}
