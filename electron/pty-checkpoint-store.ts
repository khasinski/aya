// Private bounded escrow for planned handover state. The owner credential is
// never part of this channel. Read one pane at a time; no aggregate JSON body
// crosses pty-host.sock and no restored pane is exposed before validation.
import { constants } from "node:fs";
import { mkdir, open, lstat, rmdir, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { MAX_CHECKPOINT_BYTES, MAX_CHECKPOINT_PANES, MAX_VT_SNAPSHOT_BYTES, validateCheckpointJson } from "./vt-checkpoint-schema";

const MANIFEST_LIMIT = 64 * 1024;
const CHUNK = 64 * 1024;
const TTL = 120_000;
interface PartRecord { id: string; generation: string; bytes: number; sha256: string }
interface Manifest { format: 1; nonce: string; createdAt: number; parts: PartRecord[] }
export interface CheckpointReceipt { nonce: string; bytes: number; sha256: string }
export interface CheckpointPart { id: string; generation: string; data: Buffer }
const hash = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 128;
function refused(reason: string): never { throw new Error(`Checkpoint escrow refused: ${reason}`); }
function keys(value: object, expected: string[]): boolean { return Object.keys(value).sort().join(",") === expected.sort().join(","); }
function receiptOk(receipt: CheckpointReceipt): void {
  if (!receipt || !keys(receipt, ["nonce", "bytes", "sha256"]) || !hex(receipt.nonce) || !hex(receipt.sha256) ||
      !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || receipt.bytes > MANIFEST_LIMIT) refused("receipt");
}
async function privateDirectory(path: string, create = false): Promise<void> {
  if (create) await mkdir(path, {mode: 0o700}).catch(error => { if (error.code !== "EEXIST") throw error; });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) refused("directory permissions");
}
async function privateFile(path: string, maxBytes: number): Promise<{handle: FileHandle; size: number}> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) refused("file type, permissions or length");
    return {handle, size: stat.size};
  } catch (error) { await handle.close(); throw error; }
}
async function writePrivate(path: string, data: Buffer): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    for (let offset = 0; offset < data.length;) {
      const {bytesWritten} = await handle.write(data, offset, Math.min(CHUNK, data.length - offset), offset);
      if (!bytesWritten) refused("short write");
      offset += bytesWritten;
    }
    await handle.sync();
  } finally { await handle.close(); }
}
async function readPrivate(path: string, maxBytes: number, expectedSize?: number, expectedHash?: string): Promise<Buffer> {
  const {handle, size} = await privateFile(path, maxBytes);
  try {
    if (expectedSize !== undefined && size !== expectedSize) refused("length mismatch");
    const data = Buffer.allocUnsafe(size), checksum = createHash("sha256");
    for (let offset = 0; offset < size;) {
      const {bytesRead} = await handle.read(data, offset, Math.min(CHUNK, size - offset), offset);
      if (!bytesRead) refused("truncated file");
      checksum.update(data.subarray(offset, offset + bytesRead)); offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== size || after.nlink !== 1 || (expectedHash && checksum.digest("hex") !== expectedHash)) refused("checksum or changed file");
    return data;
  } finally { await handle.close(); }
}

export async function writeCheckpoint(root: string, parts: AsyncIterable<CheckpointPart> | Iterable<CheckpointPart>, now = Date.now()): Promise<CheckpointReceipt> {
  await privateDirectory(root, true);
  const nonce = randomBytes(32).toString("hex"), directory = join(root, nonce);
  await mkdir(directory, {mode: 0o700});
  const records: PartRecord[] = [], ids = new Set<string>(); let total = 0;
  try {
    for await (const part of parts) {
      if (records.length >= MAX_CHECKPOINT_PANES || !identity(part.id) || !identity(part.generation) || ids.has(part.id) ||
          !Buffer.isBuffer(part.data) || !part.data.length || part.data.length > MAX_VT_SNAPSHOT_BYTES) refused("pane part");
      total += part.data.length;
      if (total > MAX_CHECKPOINT_BYTES) refused("aggregate bytes");
      ids.add(part.id);
      // Record before writing so a failed partial write is also removed.
      const index = records.length;
      records.push({id: part.id, generation: part.generation, bytes: part.data.length, sha256: hash(part.data)});
      await writePrivate(join(directory, `${index}.json`), part.data);
    }
    const manifest: Manifest = {format: 1, nonce, createdAt: now, parts: records};
    const data = Buffer.from(JSON.stringify(manifest));
    if (data.length > MANIFEST_LIMIT) refused("manifest bytes");
    await writePrivate(join(directory, "manifest.json"), data);
    return {nonce, bytes: data.length, sha256: hash(data)};
  } catch (error) {
    await Promise.allSettled([...records.map((_, n) => unlink(join(directory, `${n}.json`))), unlink(join(directory, "manifest.json"))]);
    await rmdir(directory).catch(() => {}); throw error;
  }
}

async function manifestFor(root: string, receipt: CheckpointReceipt, now: number): Promise<Manifest> {
  receiptOk(receipt);
  await privateDirectory(root); await privateDirectory(join(root, receipt.nonce));
  const data = await readPrivate(join(root, receipt.nonce, "manifest.json"), MANIFEST_LIMIT, receipt.bytes, receipt.sha256);
  const value = JSON.parse(data.toString("utf8")); validateCheckpointJson(value, MANIFEST_LIMIT);
  if (!value || !keys(value, ["format", "nonce", "createdAt", "parts"]) || value.format !== 1 || value.nonce !== receipt.nonce ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt > now || now - value.createdAt > TTL || !Array.isArray(value.parts) || value.parts.length > MAX_CHECKPOINT_PANES) refused("manifest identity or expiry");
  const ids = new Set<string>(); let total = 0;
  for (const part of value.parts) {
    if (!part || !keys(part, ["id", "generation", "bytes", "sha256"]) || !identity(part.id) || !identity(part.generation) || ids.has(part.id) ||
        !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > MAX_VT_SNAPSHOT_BYTES || !hex(part.sha256)) refused("manifest part");
    ids.add(part.id); total += part.bytes;
    if (total > MAX_CHECKPOINT_BYTES) refused("aggregate bytes");
  }
  return value as Manifest;
}

/** Each yielded part has already passed length and checksum checks. Restoring
 * consumers additionally validate their schema before installing any state. */
export async function* readCheckpoint(root: string, receipt: CheckpointReceipt, now = Date.now()): AsyncGenerator<CheckpointPart> {
  const manifest = await manifestFor(root, receipt, now);
  for (const [n, part] of manifest.parts.entries()) {
    yield {id: part.id, generation: part.generation, data: await readPrivate(join(root, receipt.nonce, `${n}.json`), MAX_VT_SNAPSHOT_BYTES, part.bytes, part.sha256)};
  }
}

/** Only the successor's explicit restore acknowledgement releases the files. */
export async function acknowledgeCheckpoint(root: string, receipt: CheckpointReceipt, now = Date.now()): Promise<void> {
  const manifest = await manifestFor(root, receipt, now);
  for (let n = 0; n < manifest.parts.length; n++) await unlink(join(root, receipt.nonce, `${n}.json`));
  await unlink(join(root, receipt.nonce, "manifest.json"));
  await rmdir(join(root, receipt.nonce));
}
