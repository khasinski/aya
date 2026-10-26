import { promises as fs } from "node:fs";

export const JSONL_TAIL_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_JSONL_TAIL_MAX_BYTES = 16 * 1024 * 1024;

export interface JsonlTailOptions {
  /** Maximum number of bytes read from the end of the file. */
  maxBytes?: number;
  /** Read chunk size; exported options make boundary cases testable. */
  chunkBytes?: number;
}

export interface JsonlTailResult {
  bytesRead: number;
  /** True when older file bytes were intentionally outside the read budget. */
  truncated: boolean;
}

/** Visit complete JSONL lines newest-first without loading the file into memory.
 * A line larger than one chunk is carried across chunks, but the whole carry
 * can never exceed maxBytes. If the byte budget starts in the middle of a line,
 * that partial line is discarded. Returning true from visit stops the scan. */
export async function scanJsonlTail(
  file: string,
  visit: (line: string) => boolean | void,
  options: JsonlTailOptions = {},
): Promise<JsonlTailResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_JSONL_TAIL_MAX_BYTES;
  const chunkBytes = options.chunkBytes ?? JSONL_TAIL_CHUNK_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new RangeError("chunkBytes must be a positive safe integer");
  }
  if (maxBytes === 0) return { bytesRead: 0, truncated: false };

  const handle = await fs.open(file, "r");
  let bytesRead = 0;
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - maxBytes);
    let offset = size;
    let carry = Buffer.alloc(0);
    let firstChunk = true;
    let stopped = false;

    while (offset > start && !stopped) {
      const length = Math.min(chunkBytes, offset - start);
      const chunkStart = offset - length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead: count } = await handle.read(chunk, 0, length, chunkStart);
      if (count <= 0) break;
      bytesRead += count;
      const combined = carry.length === 0
        ? chunk.subarray(0, count)
        : Buffer.concat([chunk.subarray(0, count), carry]);
      let end = combined.length;

      // The final line may not end in LF. It is complete at EOF, unless this
      // first chunk begins mid-line, in which case carry it until its prefix
      // arrives or the hard byte budget is exhausted.
      if (firstChunk) {
        const newline = combined.lastIndexOf(0x0a, end - 1);
        if (newline >= 0) {
          const lastLine = combined.subarray(newline + 1, end);
          if (lastLine.length && visit(lastLine.toString("utf8")) === true) {
            stopped = true;
          }
          end = newline;
        } else if (chunkStart === 0) {
          if (end && visit(combined.toString("utf8")) === true) stopped = true;
          end = 0;
        }
        firstChunk = false;
      }

      while (!stopped && end > 0) {
        const newline = combined.lastIndexOf(0x0a, end - 1);
        if (newline < 0) break;
        const line = combined.subarray(newline + 1, end);
        if (line.length && visit(line.toString("utf8")) === true) {
          stopped = true;
          break;
        }
        end = newline;
      }
      // Keep the delimiter that ends the oldest completed line in carry. The
      // next earlier chunk then supplies that line's beginning, allowing it
      // to be emitted once the preceding delimiter (or byte zero) is found.
      carry = stopped ? Buffer.alloc(0) : Buffer.from(combined.subarray(0, Math.min(combined.length, end + 1)));
      offset = chunkStart;
    }

    // The remaining prefix is a complete first line only if scanning reached
    // byte zero. A prefix at the cap boundary is intentionally ignored.
    if (!stopped && offset === 0 && carry.length) {
      const firstLine = carry.toString("utf8");
      const withoutTrailingLf = firstLine.endsWith("\n")
        ? firstLine.slice(0, -1)
        : firstLine;
      if (withoutTrailingLf && visit(withoutTrailingLf) === true) stopped = true;
    }
    return { bytesRead, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}

/** Read a small non-JSONL control file without trusting its reported size or
 * assuming it cannot grow between stat and read. Returns null over the cap. */
export async function readFileAtMost(
  file: string,
  maxBytes: number,
): Promise<string | null> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return null;
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}
