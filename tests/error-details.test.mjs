// The error screen's details: the error first, then the few components it happened in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { errorDetails } from "../dist-test/error-details.js";

test("an Error shows its name and message, then the first lines of the component stack", () => {
  const stack = "\n    at SettingsModal (http://x/a.js:1:2)\n    at div\n    at App\n    at ErrorBoundary\n    at A\n    at B\n    at C\n";
  assert.equal(
    errorDetails(new TypeError("x is undefined"), stack),
    ["TypeError: x is undefined", "at SettingsModal (http://x/a.js:1:2)", "at div", "at App", "at ErrorBoundary", "at A", "at B"].join("\n"),
  );
});

test("a thrown non-Error and a missing stack still give one readable line", () => {
  assert.equal(errorDetails("boom", null), "boom");
  assert.equal(errorDetails(null), "null");
});

test("a thrown plain object with a message shows the message, not [object Object]", () => {
  assert.equal(errorDetails({ message: "request failed" }), "request failed");
});
