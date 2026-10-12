// printable.ts: what a terminal would act on shows as "?" (text) or a \uXXXX escape (JSON); everything else,
// any script included, passes unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";

const { printableJson, printableText } = await import("../dist-electron/printable.js");

const ACTING = [
  ["NUL", "\x00"], ["BEL", "\x07"], ["BS", "\x08"], ["VT", "\x0b"], ["FF", "\x0c"], ["CR", "\r"], ["ESC", "\x1b"],
  ["US", "\x1f"], ["DEL", "\x7f"], ["C1 first", "\x80"], ["C1 CSI", "\x9b"], ["C1 OSC", "\x9d"], ["C1 last", "\x9f"],
  ["LRM", "‎"], ["RLM", "‏"], ["LRE", "‪"], ["RLO", "‮"], ["LRI", "⁦"], ["PDI", "⁩"],
];

test("each character a terminal would act on shows as ?", () => {
  for (const [name, c] of ACTING) assert.equal(printableText(`a${c}b`), "a?b", name);
});

test("tab, newline and any script pass unchanged", () => {
  const text = "zażółć gęślą jaźń\tok\nשלום مرحبا 你好 🚀 —   ÿ ‍";
  assert.equal(printableText(text), text);
});

test("printableJson: no acting character in the output, and the same data after JSON.parse", () => {
  const value = { text: ACTING.map(([, c]) => c).join("|"), plain: "zażółć\tok\n" };
  const json = printableJson(value);
  for (const [name, c] of ACTING) assert.equal(json.includes(c), false, name);
  assert.deepEqual(JSON.parse(json), value);
  assert.equal(json, JSON.stringify(value, null, 2).replace(/[\x7f-\x9f‎‏‪-‮⁦-⁩]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
});
