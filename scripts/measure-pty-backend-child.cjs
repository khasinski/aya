// Offline workload shared by #224 and the owner-backed adapter measurement.
const readline = require("node:readline");
const [id, mode] = process.argv.slice(2);
let sequence = 0;
console.log(`BENCH_READY:${id}`);
if (mode === "active") setInterval(() => {
  process.stdout.write("x".repeat(4096) + `\nBENCH_OUT:${id}:${++sequence}:${process.hrtime.bigint()}\n`);
}, 20);
readline.createInterface({ input: process.stdin }).on("line", line => {
  if (line.startsWith("BENCH_IN:")) console.log(`BENCH_PONG:${id}:${line.slice("BENCH_IN:".length)}`);
});
