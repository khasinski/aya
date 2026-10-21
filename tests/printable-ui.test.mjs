import { test } from "node:test";
import assert from "node:assert/strict";

const { printable } = await import("../dist-test/printable.js");

test("printable makes bidi controls visible without changing surrounding filename text", () => {
  assert.equal(printable("report\u202Etxt"), "report\\u202etxt");
});
