import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLocalSummaryError } from "../dist-electron/local-summary-errors.js";

test("Foundation Models assetsUnavailable is mapped to a stable error code", () => {
  assert.equal(
    normalizeLocalSummaryError(
      'assetsUnavailable(FoundationModels.LanguageModelSession.GenerationError.Context(debugDescription: "Model is unavailable", underlyingErrors: []))',
    ),
    "apple-model-unavailable",
  );
});

test("spawn ENOTDIR is mapped to a helper launch error", () => {
  assert.equal(
    normalizeLocalSummaryError("spawn ENOTDIR"),
    "helper-not-executable",
  );
});

test("unknown local summary errors are compacted", () => {
  const normalized = normalizeLocalSummaryError(`x ${"very ".repeat(80)}long`);
  assert.equal(normalized?.length, 160);
  assert.ok(normalized?.startsWith("x very very"));
});
