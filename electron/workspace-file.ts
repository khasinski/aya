import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { workspaceLink } from '../shared/workspace-link.cjs';

/** Read-only preview: clicking agent output must never execute a local file. */
export async function readWorkspaceFile(root: string, href: unknown) {
  const link = workspaceLink(href);
  if (!link) throw Error('Invalid workspace file link');
  const base = await fs.realpath(root);
  const file = await fs.realpath(path.resolve(base, link.path));
  const relative = path.relative(base, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('File must be inside the selected workspace');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    const limit = 2 * 1024 * 1024;
    if (!info.isFile() || info.size > limit) throw Error('Preview supports regular text files up to 2 MiB');
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > limit) throw Error('File grew beyond the 2 MiB preview limit');
    if (bytes.subarray(0, size).includes(0)) throw Error('This file is not a text file');
    const lines = bytes.subarray(0, size).toString('utf8').split('\n');
    const line = Math.min(link.line, lines.length);
    const start = Math.max(0, line - 61);
    return { path: relative, line, firstLine: start + 1, totalLines: lines.length, lines: lines.slice(start, start + 121) };
  } finally { await handle.close(); }
}
