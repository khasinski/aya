// Main-only persistent capability. The host receives a copy over an inherited
// pipe and must never create, repair or rotate this file.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export const HOST_AUTH_KEY_BYTES = 32;
export const HOST_AUTH_KEY_DIRECTORY = "pty-host-auth";
export class HostAuthKeyError extends Error {
  readonly code = "PTY_HOST_AUTH_UNAVAILABLE";
  constructor() { super("Terminal host authentication is unavailable; the existing host was left running."); }
}
const sameFile = (a: fs.Stats, b: fs.Stats): boolean => a.dev === b.dev && a.ino === b.ino;
function directory(home: string, create: boolean): {name: string; stat: fs.Stats} {
  const name = path.join(home, HOST_AUTH_KEY_DIRECTORY);
  if (create) {
    try { fs.mkdirSync(name, {mode: 0o700}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = fs.lstatSync(name);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) throw new HostAuthKeyError();
  return {name, stat};
}
function read(home: string): Buffer {
  const dir = directory(home, false), file = path.join(dir.name, "key");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1 || stat.size !== HOST_AUTH_KEY_BYTES) throw new HostAuthKeyError();
    const bytes = Buffer.alloc(HOST_AUTH_KEY_BYTES);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new HostAuthKeyError();
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs ||
        !sameFile(stat, fs.lstatSync(file)) || !sameFile(dir.stat, fs.lstatSync(dir.name))) throw new HostAuthKeyError();
    return bytes;
  } finally { fs.closeSync(fd); }
}
/** A failed read never creates, changes permissions or replaces anything. */
export function readHostAuthKey(home: string): Buffer {
  try { return read(home); } catch { throw new HostAuthKeyError(); }
}
/** Main may call this only after establishing that no surviving host needs
 * the existing capability. Existing unsafe files are never repaired here. */
export function createHostAuthKey(home: string): Buffer {
  let fd: number | undefined, created: fs.Stats | undefined;
  let file: string | undefined;
  try {
    const dir = directory(home, true);
    file = path.join(dir.name, "key");
    try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return read(home);
      throw error;
    }
    created = fs.fstatSync(fd);
    fs.writeFileSync(fd, randomBytes(HOST_AUTH_KEY_BYTES)); fs.fsyncSync(fd);
    if (!sameFile(dir.stat, fs.lstatSync(dir.name))) throw new HostAuthKeyError();
    fs.closeSync(fd); fd = undefined;
    return read(home);
  } catch {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* preserve the refusal */ } }
    if (created && file) {
      try { if (sameFile(created, fs.lstatSync(file))) fs.unlinkSync(file); } catch { /* never remove a successor */ }
    }
    throw new HostAuthKeyError();
  }
}
