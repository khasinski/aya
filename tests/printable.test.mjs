// printable.ts: what a terminal would act on shows as "?" (text) or a \uXXXX escape (JSON); everything else,
// any script included, passes unchanged. Code points are built from numbers, so this file holds none of them raw.

import { test } from "node:test";
import assert from "node:assert/strict";

const { printableJson, printableText } = await import("../dist-electron/printable.js");

// Every code point the filter covers, range by range, named for the failure message.
const RANGES = [
  ["C0 before tab", 0x00, 0x08], ["C0 after newline", 0x0b, 0x1f], ["DEL and C1", 0x7f, 0x9f], ["Arabic letter mark", 0x61c, 0x61c],
  ["LRM, RLM", 0x200e, 0x200f], ["line and paragraph separators", 0x2028, 0x2029], ["embeddings and overrides", 0x202a, 0x202e],
  ["isolates and deprecated format controls", 0x2066, 0x206f],
];
const ACTING = RANGES.flatMap(([name, from, to]) =>
  Array.from({ length: to - from + 1 }, (_, i) => [`${name} U+${(from + i).toString(16).padStart(4, "0")}`, String.fromCharCode(from + i)]),
);

test("each character a terminal would act on shows as ?", () => {
  assert.equal(ACTING.length, 9 + 21 + 33 + 1 + 2 + 2 + 5 + 10);
  for (const [name, c] of ACTING) assert.equal(printableText(`a${c}b`), "a?b", name);
});

test("tab, newline, the neighbours of each range and any script pass unchanged", () => {
  const neighbours = [0x09, 0x0a, 0x20, 0x7e, 0xa0, 0x61b, 0x61d, 0x200b, 0x200d, 0x2027, 0x2030, 0x2065, 0x2070].map((n) => String.fromCharCode(n));
  const text = `zażółć gęślą jaźń ${neighbours.join("|")} שלום مرحبا 你好 🚀 €`;
  assert.equal(printableText(text), text);
});

test("printableJson: no acting character in the output, and the same data after JSON.parse", () => {
  const value = { text: ACTING.map(([, c]) => c).join("|"), plain: "zażółć\tok\n" };
  const json = printableJson(value);
  for (const [name, c] of ACTING) assert.equal(json.includes(c), false, name);
  assert.deepEqual(JSON.parse(json), value);
});
