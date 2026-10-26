import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanJsonlTail } from "../dist-electron/bounded-file-read.js";

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
