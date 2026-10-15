// Nonce only. A same-account process can read this file during the short
// announced window; it never contains the native owner's credential.
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { parseCheckpointJson } from "./vt-checkpoint-schema";
import { HANDOVER_WINDOW_MS } from "./pty-handover-window";

export interface HandoverTicket { nonce: string; deadline: number; hostPid: number; hostStartIdentity: string }
const MAX_TICKET_BYTES = 1024;
function valid(value: unknown, now: number): value is HandoverTicket {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as HandoverTicket;
  return Object.keys(v).sort().join(",") === "deadline,hostPid,hostStartIdentity,nonce" &&
    typeof v.nonce === "string" && /^[a-f0-9]{64}$/.test(v.nonce) && Number.isSafeInteger(v.deadline) && v.deadline > now && v.deadline - now <= HANDOVER_WINDOW_MS &&
    Number.isSafeInteger(v.hostPid) && v.hostPid > 1 && typeof v.hostStartIdentity === "string" && /^\d+:\d+$/.test(v.hostStartIdentity) && v.hostStartIdentity.length <= 63;
}
export function writeHandoverTicket(file: string, ticket: HandoverTicket, now = Date.now()): void {
  if (!valid(ticket, now)) throw new Error("Invalid planned handover ticket");
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(ticket)); fs.fsyncSync(fd); fs.closeSync(fd);
    fs.renameSync(temporary, file);
  } catch (error) { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(temporary); } catch {} throw error; }
}
/** Consume exactly once before validating the payload. Only unlink the inode
 * opened here, never a path a later announcement replaced. */
export function readHandoverTicket(file: string, now = Date.now()): HandoverTicket | null {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_TICKET_BYTES) throw new Error("Unsafe planned handover ticket");
    const data = Buffer.alloc(stat.size); let offset = 0;
    while (offset < data.length) {
      const read = fs.readSync(fd, data, offset, data.length - offset, offset);
      if (!read) throw new Error("Truncated planned handover ticket"); offset += read;
    }
    const current = fs.lstatSync(file), after = fs.fstatSync(fd);
    if (current.ino !== stat.ino || current.dev !== stat.dev || after.size !== stat.size) throw new Error("Planned handover ticket changed");
    fs.unlinkSync(file);
    const ticket = parseCheckpointJson(data, MAX_TICKET_BYTES);
    if (!valid(ticket, now)) throw new Error("Expired or invalid planned handover ticket");
    return ticket;
  } finally { fs.closeSync(fd); }
}
