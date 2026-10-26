import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  truncateSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBufferAtMost, readFileAtMost, scanJsonlLinesReverse, scanJsonlTail } from "../dist-electron/bounded-file-read.js";

const MIB = 1024 * 1024;
const MAX_BYTES = 256 * 1024;
const CHUNK_BYTES = 4096;
const TARGET = "bounded-reader-target";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "aya-bounded-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sparseFile(file, size, writes) {
  const fd = openSync(file, "w+");
  try {
    ftruncateSync(fd, size);
    for (const [offset, text] of writes) {
      const bytes = Buffer.from(text);
      writeSync(fd, bytes, 0, bytes.length, offset);
    }
  } finally {
    closeSync(fd);
  }
}

const cases = [
  {
    name: "empty file / missing entry",
    size: "empty",
    placement: "missing",
    make: (file) => writeFileSync(file, ""),
    expected: false,
  },
  {
    name: "small file / last line",
    size: "small",
    placement: "last",
    make: (file) => writeFileSync(file, `older\n${TARGET}\n`),
    expected: true,
  },
  {
    name: "small file / middle line",
    size: "small",
    placement: "middle",
    make: (file) => writeFileSync(file, `older\n${TARGET}\nnewer\n`),
    expected: true,
  },
  {
    name: "small file / missing entry",
    size: "small",
    placement: "missing",
    make: (file) => writeFileSync(file, "older\nnewer\n"),
    expected: false,
  },
  {
    name: "line larger than a read chunk / last line",
    size: "oversized-line",
    placement: "last",
    make: (file) => writeFileSync(file, `${"x".repeat(CHUNK_BYTES * 3)}${TARGET}\n`),
    expected: true,
  },
  {
    name: "line larger than a read chunk / middle line",
    size: "oversized-line",
    placement: "middle",
    make: (file) => writeFileSync(file, `older\n${"x".repeat(CHUNK_BYTES * 3)}${TARGET}\nnewer\n`),
    expected: true,
  },
  {
    name: "line larger than a read chunk / missing entry",
    size: "oversized-line",
    placement: "missing",
    make: (file) => writeFileSync(file, `${"x".repeat(CHUNK_BYTES * 3)}\nnewer\n`),
    expected: false,
  },
  {
    name: "1 GiB sparse file / last line",
    size: "1gb-sparse",
    placement: "last",
    make: (file) => sparseFile(file, MIB * 1024, [[MIB * 1024 - 100, `\n${TARGET}\n`]]),
    expected: true,
  },
  {
    name: "1 GiB sparse file / middle of bounded tail",
    size: "1gb-sparse",
    placement: "middle",
    make: (file) => sparseFile(file, MIB * 1024, [[MIB * 1024 - MAX_BYTES / 2, `\n${TARGET}\n`]]),
    expected: true,
  },
  {
    name: "1 GiB sparse file / entry outside the hard tail cap",
    size: "1gb-sparse",
    placement: "missing",
    make: (file) => sparseFile(file, MIB * 1024, [[64, `${TARGET}\n`]]),
    expected: false,
  },
];

test("session JSONL tail reads stay byte- and memory-bounded across file shapes", async (t) => {
  const dir = tempDir(t);
  for (const scenario of cases) {
    await t.test(`${scenario.size} / ${scenario.placement}`, async () => {
      const file = join(dir, `${scenario.size}-${scenario.placement}.jsonl`);
      scenario.make(file);
      const before = process.memoryUsage();
      const found = [];
      const result = await scanJsonlTail(
        file,
        (line) => {
          if (line.includes(TARGET)) found.push(line);
        },
        { maxBytes: MAX_BYTES, chunkBytes: CHUNK_BYTES },
      );
      const after = process.memoryUsage();
      assert.equal(found.length > 0, scenario.expected, scenario.name);
      assert.ok(result.bytesRead <= MAX_BYTES, `${result.bytesRead} bytes read`);
      assert.ok(after.heapUsed - before.heapUsed < 64 * MIB, `heap grew by ${after.heapUsed - before.heapUsed} bytes`);
      assert.ok(after.rss - before.rss < 128 * MIB, `RSS grew by ${after.rss - before.rss} bytes`);
      if (scenario.size === "1gb-sparse") assert.equal(result.truncated, true);
    });
  }
});

test("a UTF-8 character split across reverse-read chunks is decoded intact", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "utf8.jsonl");
  const expected = "a€z";
  writeFileSync(file, `${expected}\n`); // 6 bytes; 4-byte reverse chunks split the euro sign.
  const lines = [];
  await scanJsonlTail(file, (line) => lines.push(line), { maxBytes: 64, chunkBytes: 4 });
  assert.deepEqual(lines, [expected]);
});

test("a single line longer than the complete budget is discarded without excess copying", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "over-budget-line.jsonl");
  writeFileSync(file, "x".repeat(MAX_BYTES * 2));
  let copied = 0;
  const lines = [];
  const result = await scanJsonlTail(file, (line) => lines.push(line), {
    maxBytes: MAX_BYTES,
    chunkBytes: CHUNK_BYTES,
    onCarryBytesCopied: (bytes) => { copied += bytes; },
  });
  assert.deepEqual(lines, []);
  assert.equal(result.bytesRead, MAX_BYTES);
  assert.equal(result.truncated, true);
  assert.ok(copied <= MAX_BYTES, `copied ${copied} bytes for a ${MAX_BYTES}-byte budget`);
});

test("a maximum-budget newline-free line is assembled with linear copying", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "linear-line.jsonl");
  writeFileSync(file, "x".repeat(MAX_BYTES));
  let copied = 0;
  const lines = [];
  const result = await scanJsonlTail(file, (line) => lines.push(line), {
    maxBytes: MAX_BYTES,
    chunkBytes: CHUNK_BYTES,
    onCarryBytesCopied: (bytes) => { copied += bytes; },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, MAX_BYTES);
  assert.equal(result.bytesRead, MAX_BYTES);
  assert.ok(copied <= MAX_BYTES, `copied ${copied} bytes for a ${MAX_BYTES}-byte line`);
});

test("the file handle closes when the visitor throws", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "visitor-error.jsonl");
  const moved = join(dir, "visitor-error-moved.jsonl");
  writeFileSync(file, "line\n");
  await assert.rejects(scanJsonlTail(file, () => { throw new Error("visitor failed"); }));
  renameSync(file, moved);
});

test("short positional reads are looped until the requested prefix is filled", async () => {
  const source = Buffer.from("abcdefgh");
  const target = Buffer.alloc(8);
  const positions = [];
  const result = await readBufferAtMost(async (buffer, offset, length, position) => {
    positions.push(position);
    const count = Math.min(2, length, source.length - position);
    source.copy(buffer, offset, position, position + count);
    return { bytesRead: count };
  }, target, target.length, 0);
  assert.deepEqual(result, { bytesRead: 8, complete: true });
  assert.deepEqual(positions, [0, 2, 4, 6]);
  assert.equal(target.toString(), "abcdefgh");
});

test("a file truncated after stat stops cleanly without parsing a partial chunk", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "shrinks.jsonl");
  writeFileSync(file, "complete-old-line\ncomplete-new-line\n");
  const lines = [];
  let truncated = false;
  const result = await scanJsonlTail(file, (line) => lines.push(line), {
    maxBytes: 128,
    chunkBytes: 128,
    beforeChunkRead: () => {
      if (truncated) return;
      truncated = true;
      truncateSync(file, 3);
    },
  });
  assert.equal(truncated, true);
  assert.deepEqual(lines, []);
  assert.equal(result.truncated, true);
  assert.equal(result.bytesRead, 3);
});

test("reverse JSONL scan preserves newest-first order across chunk boundaries", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "reverse.jsonl");
  writeFileSync(file, "old\n123456789\nnewest\n");
  const lines = [];
  const result = await scanJsonlLinesReverse(file, (line, info) => lines.push([line, info]), {
    chunkBytes: 5,
    maxLineBytes: 32,
  });
  assert.deepEqual(lines.map(([line]) => line), ["newest", "123456789", "old"]);
  assert.deepEqual(lines.map(([, info]) => [info.startOffset, info.endOffset]), [
    [14, 20], [4, 13], [0, 3],
  ]);
  assert.equal(result.truncated, false);
});

test("reverse JSONL scan skips oversized rows with bounded carry and continues older", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "oversized-reverse.jsonl");
  writeFileSync(file, `oldest\n${"x".repeat(100)}\nnewest\n`);
  const lines = [];
  let maxCarry = 0;
  const result = await scanJsonlLinesReverse(file, (line) => lines.push(line), {
    chunkBytes: 7,
    maxLineBytes: 16,
    onMaxCarryBytes: (bytes) => { maxCarry = Math.max(maxCarry, bytes); },
  });
  assert.deepEqual(lines, ["newest", "oldest"]);
  assert.equal(result.truncated, true);
  assert.ok(maxCarry <= 16, `carry reached ${maxCarry} bytes`);
});

test("reverse JSONL scan reports deadline stops as partial", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "deadline.jsonl");
  writeFileSync(file, "old\nmiddle\nnew\n");
  const lines = [];
  let checks = 0;
  const result = await scanJsonlLinesReverse(file, (line) => lines.push(line), {
    chunkBytes: 4,
    shouldStop: () => ++checks > 2,
  });
  assert.deepEqual(lines, ["new"]);
  assert.equal(result.truncated, true);
});

test("readFileAtMost returns a bounded file prefix", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "control.json");
  writeFileSync(file, "bounded-content");
  assert.equal(await readFileAtMost(file, 64), "bounded-content");
  assert.equal(await readFileAtMost(file, 4), null);
});
