// Why PtyOwnerRuntime.stop() calls child.ref() before awaiting the owner's exit: awaiting the 'exit' of an unref'd child
// (with nothing else keeping the loop alive) lets Node exit 0 in the middle of the async function, silently. This pins
// that Node behavior, so a change to it (or to the ref) is noticed.
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

for (const [ref, expected] of [[false, ""], [true, "after-await\n"]]) {
  test(`awaiting an unref'd child's exit ${ref ? "with ref() reaches the code after the await" : "silently ends the process before it"}`, () => {
    const run = spawnSync(process.execPath, ["-e", script(ref)], { encoding: "utf8", timeout: 10_000 });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, expected);
  });
}
