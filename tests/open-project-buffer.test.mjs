// Opens main sends between the page's load and the renderer subscribing must
// wait for it: the CLI was already told they landed.

import { test } from "node:test";
import assert from "node:assert/strict";

const { createOpenProjectBuffer } = await import("../dist-electron/open-project-buffer.js");

test("opens before the first subscriber are handed to it, in order", () => {
  const buffer = createOpenProjectBuffer();
  buffer.push("/a");
  buffer.push("/b");
  const got = [];
  buffer.subscribe((dir) => got.push(dir));
  assert.deepEqual(got, ["/a", "/b"]);
  buffer.push("/c");
  assert.deepEqual(got, ["/a", "/b", "/c"]);
});

test("a StrictMode mount, unmount, mount neither loses nor repeats an open", () => {
  const buffer = createOpenProjectBuffer();
  buffer.push("/early");
  const got = [];
  const unsubscribe = buffer.subscribe((dir) => got.push(dir));
  unsubscribe();
  buffer.subscribe((dir) => got.push(dir));
  buffer.push("/late");
  assert.deepEqual(got, ["/early", "/late"]);
});

test("after the last unsubscribe, opens are held for the next subscriber", () => {
  const buffer = createOpenProjectBuffer();
  const first = [];
  buffer.subscribe((dir) => first.push(dir))();
  buffer.push("/held");
  assert.deepEqual(first, []);
  const second = [];
  buffer.subscribe((dir) => second.push(dir));
  assert.deepEqual(second, ["/held"]);
});

test("every live subscriber hears a live open; unsubscribing one leaves the other", () => {
  const buffer = createOpenProjectBuffer();
  const a = [];
  const b = [];
  const offA = buffer.subscribe((dir) => a.push(dir));
  buffer.subscribe((dir) => b.push(dir));
  buffer.push("/both");
  offA();
  buffer.push("/b-only");
  assert.deepEqual(a, ["/both"]);
  assert.deepEqual(b, ["/both", "/b-only"]);
});
