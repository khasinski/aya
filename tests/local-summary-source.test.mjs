// The Swift summary helper is generated from a template; its length cap must be
// the main process's SUMMARY_TEXT_MAX_CHARS, not a second literal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SUMMARY_TEXT_MAX_CHARS } from "../dist-electron/local-summary-errors.js";

const require = createRequire(import.meta.url);
const { renderLocalSummarySource } = require("../scripts/local-summary-source.cjs");
const templatePath = new URL("../electron/native/aya-local-summary.swift.in", import.meta.url);
const builtPath = new URL("../dist-electron/aya-local-summary.swift", import.meta.url);
const template = readFileSync(templatePath, "utf8");

test("the rendered helper caps, trims and prompts with the main-process limit", () => {
  const source = renderLocalSummarySource(template, 123);
  assert.match(source, /^let summaryMaxChars = 123$/m);
  assert.match(source, /cleaned\.count <= summaryMaxChars\b/);
  assert.match(source, /cleaned\.prefix\(summaryMaxChars - 3\)/);
  assert.match(source, /Keep summary under \\\(summaryMaxChars\) characters/);
  assert.doesNotMatch(source, /@SUMMARY_MAX_CHARS@/);
});

test("the template holds no other length literal", () => {
  assert.doesNotMatch(template, /\b1[0-9]{2}\b/);
});

test("rendering refuses a template without the placeholder", () => {
  assert.throws(() => renderLocalSummarySource("let x = 1\n", 160), /@SUMMARY_MAX_CHARS@/);
});

test("the built helper source is the template rendered with SUMMARY_TEXT_MAX_CHARS", {
  skip: !existsSync(builtPath) && "helper source is built on macOS only",
}, () => {
  assert.equal(
    readFileSync(builtPath, "utf8"),
    renderLocalSummarySource(template, SUMMARY_TEXT_MAX_CHARS),
  );
});
