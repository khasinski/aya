import { promises as fs } from "node:fs";

export const JSONL_TAIL_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_JSONL_TAIL_MAX_BYTES = 16 * 1024 * 1024;
/** Usage records are small; avoid parsing attacker/corruption-sized JSONL rows. */
export const MAX_USAGE_JSONL_LINE_BYTES = 1024 * 1024;

export function isOversizedUsageJsonlLine(line: string): boolean {
  return line.length > MAX_USAGE_JSONL_LINE_BYTES ||
    Buffer.byteLength(line, "utf8") > MAX_USAGE_JSONL_LINE_BYTES;
}

export interface JsonlTailOptions {
  /** Maximum number of bytes read from the end of the file. */
  maxBytes?: number;
  /** Read chunk size; exported options make boundary cases testable. */
  chunkBytes?: number;
  /** Test instrumentation for bytes copied while assembling carried lines. */
  onCarryBytesCopied?: (bytes: number) => void;
  /** Test hook used to simulate a file shrinking after its initial stat. */
  beforeChunkRead?: (fileSize: number, position: number, length: number) => void | Promise<void>;
}

export interface ReverseJsonlOptions {
  /** Maximum bytes to visit, starting at EOF. Defaults to the whole file. */
  maxBytes?: number;
  /** Read chunk size; exported for deterministic boundary tests. */
  chunkBytes?: number;
  /** Stop before reading another chunk (for a search-wide deadline). */
  shouldStop?: () => boolean;
  /** Maximum JSONL line size. Larger lines are skipped without retaining them. */
  maxLineBytes?: number;
  /** Test instrumentation for the largest line carry retained by the scanner. */
  onMaxCarryBytes?: (bytes: number) => void;
  /** Test instrumentation for cancellation/progress without exposing file data. */
  onBytesRead?: (bytes: number) => void;
}

/** Fill a buffer despite short positional reads; stop only when it is full or
 *  the underlying source reports EOF. Exported so the short-read behavior is
 *  pinned with a deterministic fake reader. */
export async function readBufferAtMost(
  read: (
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesRead: number }>,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<{ bytesRead: number; complete: boolean }> {
  let bytesRead = 0;
  while (bytesRead < length) {
    const result = await read(buffer, bytesRead, length - bytesRead, position + bytesRead);
    if (result.bytesRead <= 0) return { bytesRead, complete: false };
    bytesRead += result.bytesRead;
  }
  return { bytesRead, complete: true };
}

export interface JsonlTailResult {
  bytesRead: number;
  /** True when the scan did not cover all eligible file content. */
  truncated: boolean;
  /** True when a complete or continued line exceeded the configured line cap. */
  skippedOversizedLines?: boolean;
}

export interface JsonlLineInfo {
  /** Inclusive byte offset of the line in the source file. */
  startOffset: number;
  /** Exclusive byte offset of the line in the source file, excluding LF. */
  endOffset: number;
}

/** Visit complete JSONL lines newest-first without loading the file into memory.
 * A line larger than one chunk is carried across chunks, but the whole carry
 * can never exceed maxBytes. If the byte budget starts in the middle of a line,
 * that partial line is discarded. Returning true from visit stops the scan. */
export async function scanJsonlTail(
  file: string,
  visit: (line: string, info: JsonlLineInfo) => boolean | void,
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
    // Keep partial lines as views into the chunks already read. A long line
    // can span the entire budget; concatenating its growing prefix on every
    // iteration turns one scan into quadratic copying.
    let carryChunks: Buffer[] = [];
    let firstChunk = true;
    let stopped = false;
    let earlyEof = false;

    while (offset > start && !stopped) {
      const length = Math.min(chunkBytes, offset - start);
      const chunkStart = offset - length;
      const chunk = Buffer.allocUnsafe(length);
      await options.beforeChunkRead?.(size, chunkStart, length);
      const result = await readBufferAtMost(
        (buffer, bufferOffset, readLength, position) => handle.read(buffer, bufferOffset, readLength, position),
        chunk,
        length,
        chunkStart,
      );
      const count = result.bytesRead;
      if (!result.complete) {
        bytesRead += count;
        earlyEof = true;
        break;
      }
      if (count <= 0) break;
      bytesRead += count;
      const current = chunk.subarray(0, count);
      const hasNewline = current.includes(0x0a);
      let combined = current;
      let completedAtByteZero = false;
      if (hasNewline && carryChunks.length > 0) {
        const totalBytes = carryChunks.reduce((sum, part) => sum + part.length, current.length);
        options.onCarryBytesCopied?.(totalBytes);
        combined = Buffer.concat([current, ...carryChunks], totalBytes);
      }
      let end = combined.length;

      // The final line may not end in LF. It is complete at EOF, unless this
      // first chunk begins mid-line, in which case carry it until its prefix
      // arrives or the hard byte budget is exhausted.
      if (firstChunk) {
        const newline = combined.lastIndexOf(0x0a, end - 1);
        if (newline >= 0) {
          const lastLine = combined.subarray(newline + 1, end);
          if (lastLine.length && visit(lastLine.toString("utf8"), {
            startOffset: chunkStart + newline + 1,
            endOffset: chunkStart + end,
          }) === true) {
            stopped = true;
          }
          end = newline;
        } else if (chunkStart === 0) {
          if (end && visit(combined.toString("utf8"), {
            startOffset: chunkStart,
            endOffset: chunkStart + end,
          }) === true) stopped = true;
          completedAtByteZero = true;
          end = 0;
        }
        firstChunk = false;
      }

      while (!stopped && end > 0) {
        const newline = combined.lastIndexOf(0x0a, end - 1);
        if (newline < 0) break;
        const line = combined.subarray(newline + 1, end);
        if (line.length && visit(line.toString("utf8"), {
          startOffset: chunkStart + newline + 1,
          endOffset: chunkStart + end,
        }) === true) {
          stopped = true;
          break;
        }
        end = newline;
      }
      if (stopped) {
        carryChunks = [];
      } else if (completedAtByteZero) {
        carryChunks = [];
      } else if (hasNewline) {
        // Keep a view through the oldest delimiter. Earlier chunks can extend
        // that one unfinished line without copying it on every read.
        carryChunks = [combined.subarray(0, Math.min(combined.length, end + 1))];
      } else {
        carryChunks.unshift(current);
      }
      offset = chunkStart;
    }

    // The remaining prefix is a complete first line only if scanning reached
    // byte zero. A prefix at the cap boundary is intentionally ignored.
    if (!stopped && offset === 0 && carryChunks.length) {
      const firstLine = carryChunks.length === 1
        ? carryChunks[0].toString("utf8")
        : (() => {
          const totalBytes = carryChunks.reduce((sum, part) => sum + part.length, 0);
          options.onCarryBytesCopied?.(totalBytes);
          return Buffer.concat(carryChunks, totalBytes).toString("utf8");
        })();
      const withoutTrailingLf = firstLine.endsWith("\n")
        ? firstLine.slice(0, -1)
        : firstLine;
      if (withoutTrailingLf && visit(withoutTrailingLf, {
        startOffset: 0,
        endOffset: Buffer.byteLength(withoutTrailingLf, "utf8"),
      }) === true) stopped = true;
    }
    return { bytesRead, truncated: start > 0 || earlyEof };
  } finally {
    await handle.close();
  }
}

/** Visit JSONL lines newest-first with bounded chunk and line memory. Unlike
 * scanJsonlTail this can walk the whole file; callers can stop it with
 * shouldStop. An oversized line is skipped and marks the result truncated. */
export async function scanJsonlLinesReverse(
  file: string,
  visit: (line: string, info: JsonlLineInfo) => boolean | void,
  options: ReverseJsonlOptions = {},
): Promise<JsonlTailResult> {
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  const chunkBytes = options.chunkBytes ?? JSONL_TAIL_CHUNK_BYTES;
  const maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new RangeError("chunkBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
    throw new RangeError("maxLineBytes must be a positive safe integer");
  }
  const handle = await fs.open(file, "r");
  let bytesRead = 0;
  try {
    const size = (await handle.stat()).size;
    const start = Math.max(0, size - maxBytes);
    let offset = size;
    let carry: Buffer[] = [];
    let carryBytes = 0;
    // True when the suffix being carried belongs to a line whose beginning
    // has already exceeded maxLineBytes. Drop it when its preceding LF arrives.
    let skippingOversizedLine = false;
    let stopped = false;
    let partial = start > 0;
    let skippedOversizedLines = false;
    while (offset > start) {
      if (options.shouldStop?.()) {
        stopped = true;
        partial = true;
        break;
      }
      const length = Math.min(chunkBytes, offset - start);
      const chunkStart = offset - length;
      const chunk = Buffer.allocUnsafe(length);
      const result = await readBufferAtMost(
        (buffer, bufferOffset, readLength, position) => handle.read(buffer, bufferOffset, readLength, position),
        chunk,
        length,
        chunkStart,
      );
      bytesRead += result.bytesRead;
      options.onBytesRead?.(bytesRead);
      if (!result.complete) {
        partial = true;
        break;
      }
      let end = chunk.length;
      while (!stopped) {
        const newline = chunk.lastIndexOf(0x0a, end - 1);
        if (newline < 0) break;
        const segment = chunk.subarray(newline + 1, end);
        const lineBytes = segment.length + carryBytes;
        if (skippingOversizedLine) {
          partial = true;
          skippedOversizedLines = true;
        } else if (lineBytes > maxLineBytes) {
          partial = true;
          skippedOversizedLines = true;
        } else if (lineBytes > 0) {
          const lineBuffer = carryBytes === 0
            ? segment
            : Buffer.concat([segment, ...carry], lineBytes);
          const lineEndOffset = chunkStart + end + carryBytes;
          if (visit(lineBuffer.toString("utf8"), {
            startOffset: chunkStart + newline + 1,
            endOffset: lineEndOffset,
          }) === true) {
            stopped = true;
          }
        }
        carry = [];
        carryBytes = 0;
        skippingOversizedLine = false;
        end = newline;
      }
      if (!stopped && end > 0) {
        if (skippingOversizedLine) {
          // Continue seeking the start delimiter without retaining bytes.
        } else if (end + carryBytes > maxLineBytes) {
          skippingOversizedLine = true;
          carry = [];
          carryBytes = 0;
          partial = true;
          skippedOversizedLines = true;
        } else {
          carry.unshift(chunk.subarray(0, end));
          carryBytes += end;
          options.onMaxCarryBytes?.(carryBytes);
        }
      }
      offset = chunkStart;

      // Once byte zero is reached the remaining carry is a complete first
      // line. At a bounded start it is only a prefix and is intentionally lost.
      if (!stopped && offset === 0) {
        if (skippingOversizedLine) {
          partial = true;
          skippedOversizedLines = true;
        } else if (carryBytes > maxLineBytes) {
          partial = true;
          skippedOversizedLines = true;
        } else if (carryBytes > 0) {
          const lineBuffer = carry.length === 1 ? carry[0] : Buffer.concat(carry, carryBytes);
          const firstLine = lineBuffer.toString("utf8");
          if (visit(firstLine, {
            startOffset: 0,
            endOffset: carryBytes,
          }) === true) {
            stopped = true;
          }
        }
        carry = [];
        carryBytes = 0;
      }
    }
    return {
      bytesRead,
      truncated: partial || stopped,
      ...(skippedOversizedLines ? { skippedOversizedLines: true } : {}),
    };
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
    const { bytesRead } = await readBufferAtMost(
      (target, offset, length, position) => handle.read(target, offset, length, position),
      buffer,
      buffer.length,
      0,
    );
    if (bytesRead > maxBytes) return null;
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}
