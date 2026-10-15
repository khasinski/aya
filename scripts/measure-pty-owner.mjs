import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { startOwner, sleep } from "../tests/helpers/pty-owner.mjs";

export function fdCount(pid) {
  if (process.platform === "linux") return fs.readdirSync(`/proc/${pid}/fd`).length;
  return execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-Ff"], { encoding: "utf8" }).split("\n").filter(line => /^f\d+$/.test(line)).length;
}
const root = fs.mkdtempSync(path.resolve("test-results/owner-builds-"));
const builds = [];
for (let i = 0; i < 2; i++) {
  const directory = path.join(root, String(i));
  execFileSync(process.execPath, ["scripts/build-pty-owner.cjs"], { env: { ...process.env, AYA_OWNER_BUILD_DIR: directory } });
  builds.push(JSON.parse(fs.readFileSync(path.join(directory, "pty-owner-build.json"))));
}
assert.equal(builds[0].buildId, builds[1].buildId);
assert.equal(builds[0].ownerHash, builds[1].ownerHash, "owner executable must reproduce byte for byte");
assert.equal(builds[0].bridgeHash, builds[1].bridgeHash, "bridge must reproduce byte for byte");
const samples = [];
for (const paneCount of [1, 25]) for (let repeat = 0; repeat < 3; repeat++) {
  const owner = await startOwner();
  try {
    const c = await owner.connect(), baselineFds = fdCount(owner.owner.pid), baselineClientFds = fdCount(process.pid), panes = [];
    assert.equal(c.buildId, builds[0].buildId, "measure the current native build, not stale artifacts");
    for (let i = 0; i < paneCount; i++) panes.push(await c.spawn({ id: `pane-${i}`, command: "/bin/sh", argv: ["sh", "-c", "read line"],
      cwd: owner.home, cols: 80, rows: 24, env: { PATH: "/usr/bin:/bin", HOME: owner.home } }));
    if (paneCount === 25) await assert.rejects(c.spawn({ id: "over-limit", command: "/bin/sleep", argv: ["sleep", "30"],
      cwd: owner.home, cols: 80, rows: 24, env: { PATH: "/usr/bin:/bin" } }), /Pane limit reached/);
    const activeFds = fdCount(owner.owner.pid);
    assert.equal(activeFds, baselineFds + paneCount);
    const rssKiB = Number(execFileSync("ps", ["-o", "rss=", "-p", String(owner.owner.pid)], { encoding: "utf8" }).trim());
    const before = await c.stats(), start = process.hrtime.bigint();
    await sleep(2000);
    const after = await c.stats(), wallMs = Number(process.hrtime.bigint() - start) / 1e6;
    const cpuUs = Number(after.userUs + after.systemUs - before.userUs - before.systemUs);
    for (const pane of panes) {
      await c.kill(pane, 9); const exit = await c.nextExit(); assert.equal(exit.signal, 9);
      await c.ackExit(exit); c.release(pane.fd);
    }
    const cleanedFds = fdCount(owner.owner.pid), cleanedClientFds = fdCount(process.pid);
    assert.equal(cleanedFds, baselineFds); assert.equal(cleanedClientFds, baselineClientFds);
    samples.push({ panes: paneCount, repeat, rssKiB, wallMs, cpuUs, cpuPercent: cpuUs / (wallMs * 10),
      fd: { baseline: baselineFds, active: activeFds, cleaned: cleanedFds, clientBaseline: baselineClientFds, clientCleaned: cleanedClientFds } });
    await c.shutdown(); assert.equal((await owner.closed).code, 0);
  } finally { await owner.close(); }
}
const result = { platform: process.platform, arch: process.arch, node: process.versions.node, builds, samples,
  limits: "Native owner RSS only; quiet live shells; three ~2s idle samples per size; unsigned local identity; no 25-pane throughput claim." };
fs.writeFileSync(path.resolve(`test-results/owner-measurements-${process.platform}-${process.arch}.json`), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
