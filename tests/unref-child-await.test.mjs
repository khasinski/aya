// Why PtyOwnerRuntime.stop() calls child.ref() before awaiting the owner's exit: awaiting the 'exit' of an unref'd child
// (with nothing else keeping the loop alive) can let Node exit 0 in the middle of the async function, silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const script = (ref) => `
const { spawn } = require("node:child_process");
(async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 200)"], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.unref();
  ${ref ? "child.ref();" : ""}
  await exited;
  console.log("after-await");
})();
`;

// Only the ref() side is pinned: whether the unref'd case exits silently depends on the OS and its child reaping
// (it did not on the macOS runner), which is the nondeterminism that made PtyOwnerRuntime.stop() flaky in the first place.
test("awaiting an unref'd child's exit after ref() reaches the code after the await", () => {
  const run = spawnSync(process.execPath, ["-e", script(true)], { encoding: "utf8", timeout: 10_000 });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "after-await\n");
});
