// Window creation for an outside open and for macOS `activate` share one
// in-flight promise, so interleaved callers never create two windows.

import { test } from "node:test";
import assert from "node:assert/strict";

const { singleFlight } = await import("../dist-electron/single-flight.js");

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

test("callers that arrive while a run is in flight share it", async () => {
  const runs = [];
  const create = singleFlight(() => {
    const d = deferred();
    runs.push(d);
    return d.promise;
  });
  const fromOpen = create();
  const fromActivate = create();
  assert.equal(runs.length, 1);
  runs[0].resolve("window-1");
  assert.deepEqual(await Promise.all([fromOpen, fromActivate]), ["window-1", "window-1"]);
});

test("a call after the run settled starts a new run", async () => {
  let count = 0;
  const create = singleFlight(async () => `window-${++count}`);
  assert.equal(await create(), "window-1");
  assert.equal(await create(), "window-2");
});

test("a failed run is shared, then cleared so the next call retries", async () => {
  let count = 0;
  const create = singleFlight(async () => {
    count += 1;
    if (count === 1) throw new Error("no window state");
    return "window";
  });
  const results = await Promise.allSettled([create(), create()]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  assert.equal(count, 1);
  assert.equal(await create(), "window");
});
