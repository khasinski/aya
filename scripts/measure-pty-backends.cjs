// Run after offline builds of #224 and B2. No dependency preparation or network.
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const baseline = path.resolve(process.argv[2] || ""), current = path.resolve(__dirname, "..");
if (!process.argv[2]) throw new Error("Usage: node scripts/measure-pty-backends.cjs /path/to/built-224-checkout");
const electron = require("electron"), results = [];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] ?? null;
for (const [label, target] of [["224", baseline], ["B2", current]]) for (const mode of ["idle", "active"]) {
  const home = fs.mkdtempSync(path.join(current, "test-results", "bench-"));
  let completed = false;
  try {
    const run = spawnSync(electron, [path.join(__dirname, "measure-pty-backend-worker.cjs"), target, home, mode], {
      cwd: current, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    if (run.status !== 0) throw new Error(`${label}/${mode} failed: ${run.stderr || run.error}`);
    const raw = JSON.parse(run.stdout.trim().split("\n").at(-1));
    results.push({ label, ...raw, summary: { inputSamples: raw.roundTripMs.length, inputP50Ms: percentile(raw.roundTripMs, .5), inputP95Ms: percentile(raw.roundTripMs, .95),
      outputSamples: raw.outputMs.length, outputP50Ms: percentile(raw.outputMs, .5), outputP95Ms: percentile(raw.outputMs, .95) } });
    completed = true;
  } finally {
    if (completed) fs.rmSync(home, { recursive: true, force: true });
    else console.error(`Failed benchmark retained its private home for verified process cleanup: ${home}`);
  }
}
const file = path.join(current, "test-results/pty-backend-comparison.json"); fs.writeFileSync(file, JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results.map(({ label, mode, spawnReadyMs, samples, summary }) => ({ label, mode, spawnReadyMs, samples, ...summary })), null, 2));
