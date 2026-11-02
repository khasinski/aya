import { promises as fs } from 'node:fs';
/** Enforce limits before allocation and while reading, even if a file grows.
 * Small metadata files do not allocate the full conversation/asset budget. */
export async function readStoredText(file: string, limit: number): Promise<string> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid stored file byte limit');
  const handle = await fs.open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw Error('Stored JSON file is too large or is not a regular file');
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw Error('Stored JSON file is too large');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally { await handle.close(); }
}
export async function readStoredJson(file: string, limit: number): Promise<unknown> {
  return JSON.parse(await readStoredText(file, limit));
}
