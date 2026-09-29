import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSummaryResponse, summaryPrompt } from "../dist-electron/summary-prompt.js";

const promptLimit = () =>
  Number(summaryPrompt({ kind: "terminal", lines: ["a", "b"] }).match(/Max (\d+) words/)[1]);

test("the prompt asks for at most 6 words", () => {
  assert.equal(promptLimit(), 6);
  assert.match(summaryPrompt({ kind: "project", lines: ["a"] }), /"2-6 word label"/);
});

for (const [shape, content] of [
  ["JSON", '{"useful":true,"summary":"one two three four five six seven eight"}'],
  ["plain-text fallback", "one two three four five six seven eight"],
]) {
  test(`a ${shape} summary longer than the prompt's limit is cut to that limit`, () => {
    assert.equal(parseSummaryResponse(content).summary, "one two three four five six");
  });
}

test("a summary within the limit is kept whole", () => {
  const r = parseSummaryResponse('{"useful":true,"summary":"Fixed flaky pty host test"}');
  assert.deepEqual(r, { available: true, useful: true, summary: "Fixed flaky pty host test" });
});
