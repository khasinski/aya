import { test } from "node:test";
import assert from "node:assert/strict";

const { registerGitStatusQuitGuard } = await import("../dist-electron/git-status-quit.js");

function appStub() {
  let listener;
  return {
    on: (_event, fn) => { listener = fn; },
    removeListener: (_event, fn) => { if (listener === fn) listener = undefined; },
    quitCalls: 0,
    quit() { this.quitCalls++; },
    emit(event) { listener?.(event); },
  };
}

test("a before-quit notification with no Git child does not defeat another quit veto", () => {
  const app = appStub();
  let teardownCalls = 0;
  let preventCalls = 0;
  registerGitStatusQuitGuard(app, {
    hasPendingChildren: () => false,
    teardown: async () => { teardownCalls++; },
  });

  // The notification can be synthetic (or another listener can veto the real
  // quit). The status hook must neither prevent it nor schedule a second quit.
  app.emit({ preventDefault() { preventCalls++; } });
  assert.equal(preventCalls, 0);
  assert.equal(teardownCalls, 0);
  assert.equal(app.quitCalls, 0);
});

test("a quit with a pending Git child is held until teardown completes", async () => {
  const app = appStub();
  let pending = true;
  let release;
  const teardown = new Promise((resolve) => { release = resolve; });
  let preventCalls = 0;
  registerGitStatusQuitGuard(app, {
    hasPendingChildren: () => pending,
    teardown: () => teardown,
  });

  app.emit({ preventDefault() { preventCalls++; } });
  assert.equal(preventCalls, 1);
  assert.equal(app.quitCalls, 0);
  pending = false;
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.quitCalls, 1);
});
