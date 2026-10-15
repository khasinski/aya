// Bounded compressed part framing. Escrow SHA-256 binds these exact bytes;
// gzip's output limit and declared raw length bound decompression separately.
import { gzipSync, gunzipSync } from "node:zlib";
import { MAX_VT_SNAPSHOT_BYTES } from "./vt-checkpoint-schema";
const MAGIC = Buffer.from("AYA-CP1Z");
const HEADER = MAGIC.length + 4;
export function checkpointPayloadSize(data: Buffer): number {
  if (!Buffer.isBuffer(data) || data.length <= HEADER || data.length > MAX_VT_SNAPSHOT_BYTES || !data.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Invalid compressed checkpoint part");
  const size = data.readUInt32BE(MAGIC.length);
  if (size < 1 || size > MAX_VT_SNAPSHOT_BYTES) throw new Error("Checkpoint decoded-byte limit");
  return size;
}
export function encodeCheckpointPayload(raw: Buffer): Buffer {
  if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > MAX_VT_SNAPSHOT_BYTES) throw new Error("Checkpoint decoded-byte limit");
  const compressed = gzipSync(raw, {level: 6});
  const header = Buffer.alloc(HEADER); MAGIC.copy(header); header.writeUInt32BE(raw.length, MAGIC.length);
  const data = Buffer.concat([header, compressed]);
  checkpointPayloadSize(data);
  return data;
}
export function decodeCheckpointPayload(data: Buffer): Buffer {
  const size = checkpointPayloadSize(data);
  const raw = gunzipSync(data.subarray(HEADER), {maxOutputLength: size});
  if (raw.length !== size) throw new Error("Checkpoint decoded length mismatch");
  return raw;
}
