import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface AsyncPtyLogWriter {
  append(event: string, fields?: Record<string, unknown>): void;
  flush(): Promise<void>;
}

/** Bounded, ordered async I/O. A slow log must not block the PTY event loop. */
export function createAsyncPtyLog(file: string, maxBytes = 1_000_000): AsyncPtyLogWriter {
  let pending = Promise.resolve();
  let queuedBytes = 0;
  const write = async (line: string, bytes: number) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    let info;
    try { info = await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (info && !info.isFile()) return;
    if (info && info.size + bytes > maxBytes) {
      await fs.rename(file, `${file}.1`);
      await fs.chmod(`${file}.1`, 0o600);
    }
    const handle = await fs.open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!(await handle.stat()).isFile()) return;
      await handle.chmod(0o600);
      await handle.writeFile(line);
    } finally { await handle.close(); }
  };
  return {
    append(event, fields) {
      try {
        const line = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ev: event, ...fields }) + '\n';
        const bytes = Buffer.byteLength(line);
        // Includes the currently-writing line, bounding memory even on hung storage.
        if (bytes > maxBytes || queuedBytes + bytes > maxBytes) return;
        queuedBytes += bytes;
        pending = pending.then(() => write(line, bytes)).catch(() => {}).finally(() => { queuedBytes -= bytes; });
      } catch { /* Logging must never break the caller, including circular fields. */ }
    },
    flush() { return pending; },
  };
}
