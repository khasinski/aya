// Reorder whole specs into CI shards using measured test time, keeping serial
// groups and file hooks together. Discover files from Playwright's current
// inventory so a new spec is included even before it has a timing sample.
const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const [inventoryPath, shardArg, outputDir] = process.argv.slice(2);
const [current, total] = (shardArg || "").split("/").map(Number);
if (!Number.isInteger(current) || !Number.isInteger(total) || current < 1 || current > total) {
  throw new Error("Usage: node .github/e2e-shards.cjs inventory.json current/total output-dir");
}
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
if (inventory.errors?.length) throw new Error("Playwright inventory has load errors");
const timings = require("./e2e-shard-times.json").files;
const files = new Map();
function collect(suites) {
  for (const suite of suites) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests) {
        const project = test.projectName;
        if (!["isolated", "shared-resources"].includes(project)) {
          throw new Error(`Unknown E2E project: ${project}`);
        }
        const key = `${project}:${spec.file}`;
        if (!files.has(key)) files.set(key, { project, file: spec.file, tests: 0 });
        files.get(key).tests++;
      }
    }
    collect(suite.suites || []);
  }
}
collect(inventory.suites);
if (!files.size) throw new Error("Empty Playwright inventory");

const samples = Object.values(timings);
const defaultMs = samples.reduce((sum, sample) => sum + sample.ms, 0) /
  samples.reduce((sum, sample) => sum + sample.tests, 0);
for (const file of files.values()) {
  const sample = timings[`${file.project}:${file.file}`];
  const ms = file.tests * (sample ? sample.ms / sample.tests : defaultMs);
  // The isolated stage has two workers; the shared stage has one and follows it.
  file.cost = Math.max(1, ms) / (file.project === "isolated" ? 2 : 1);
}
const shards = Array.from({ length: total }, () => ({ cost: 0, files: [] }));
for (const project of ["shared-resources", "isolated"]) {
  const ordered = [...files.values()].filter((file) => file.project === project)
    .sort((a, b) => b.cost - a.cost || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (const file of ordered) {
    const shard = shards.reduce((least, candidate) => candidate.cost < least.cost ? candidate : least);
    shard.files.push(file);
    shard.cost += file.cost;
  }
}
mkdirSync(outputDir, { recursive: true });
for (const project of ["isolated", "shared-resources"]) {
  const selected = shards[current - 1].files.filter((file) => file.project === project);
  if (project === "isolated" && !selected.length) throw new Error("Empty isolated shard");
  const lines = selected.map((file) => `[${project}] > ${file.file}`).sort();
  writeFileSync(join(outputDir, `${project}.list`), lines.length ? lines.join("\n") + "\n" : "");
}
writeFileSync(join(outputDir, "plan.json"), JSON.stringify(shards, null, 2) + "\n");
console.log(`Shard ${current}/${total}: ${shards[current - 1].files.reduce((sum, file) => sum + file.tests, 0)} tests, estimated ${(shards[current - 1].cost / 1000).toFixed(1)} seconds`);
