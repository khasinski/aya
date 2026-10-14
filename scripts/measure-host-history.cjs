// Same built-value import walk for tagged sources, plus a conservative pre-split core projection.
// Run after build:electron. No checkout, installs, network or runtime processes.
const ts = require("typescript");
const { execFileSync } = require("node:child_process");
const { hostModuleFiles } = require("../dist-electron/pty-host-staleness");
const { join, posix } = require("node:path");
const read = (ref, file) => {
  try { return execFileSync("git", ["show", `${ref}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }
};
function walk(ref) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    const source = read(ref, file);
    if (source === null) return;
    seen.add(file);
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const m of js.matchAll(/require\(["'](\.\.?\/[^"']+)["']\)/g)) {
      const target = posix.normalize(posix.join(posix.dirname(file), m[1].replace(/\.js$/, "") + ".ts"));
      if (target.startsWith("electron/")) visit(target);
    }
  };
  visit("electron/pty-host.ts");
  return [...seen].sort();
}
const tags = ["v0.7.9", "v0.8.0", "v0.9.0", "v0.10.0", "v0.11.0", "v0.12.0", "origin/main"];
const changes = (before, after, files) => files.filter((f) => read(before, f) !== read(after, f));
const oldNames = {
  "pty-core.ts": "pty.ts", "vt-mirror.ts": "vt-state.ts", "pty-host-paths.ts": "paths.ts",
  "pty-core-constants.ts": "constants.ts", "atomic-temp.ts": "atomic-write.ts",
};
const core = [...new Set(hostModuleFiles(join(__dirname, "../dist-electron"), "pty-host.js")
  .map((f) => f.replace(/\.js$/, ".ts")).map((f) => "electron/" + (oldNames[f] ?? f)))].sort();
function versions(ref) {
  const pkg = JSON.parse(read(ref, "package-lock.json"));
  const runtime = {};
  for (const dep of ["electron", "node-pty", "@xterm/headless"]) {
    const entry = pkg.packages?.[`node_modules/${dep}`];
    runtime[dep] = entry ? { version: entry.version, integrity: entry.integrity ?? null } : null;
  }
  return runtime;
}
const rows = tags.slice(1).map((after, i) => {
  const before = tags[i], graph = walk(after), changed = changes(before, after, graph);
  const coreChanged = changes(before, after, core);
  const oldRuntime = versions(before), newRuntime = versions(after);
  const runtimeChanged = Object.keys(newRuntime).filter((k) => JSON.stringify(oldRuntime[k]) !== JSON.stringify(newRuntime[k]));
  return { before, after, hostModules: graph.length, changedModules: changed.length,
    projectedCoreChanged: coreChanged.length, coreFilesChanged: coreChanged, runtimeChanged,
    conservativeKept: coreChanged.length === 0 && runtimeChanged.length === 0 };
});
console.log(JSON.stringify({ sourceWalk: "TypeScript transpiled CommonJS value imports; entry included",
  projection: "New core graph mapped to pre-split source modules. Whole predecessor files are compared, so excluded code in those old files can cause false restarts. This is a conservative lower bound, not a replay of historical native binaries.",
  runtime: "Electron/node-pty/@xterm lock versions and integrity. Historical embedded Node/native bytes unavailable; Electron changes already force restart.",
  currentCoreModules: hostModuleFiles(join(__dirname, "../dist-electron"), "pty-host.js"),
  predecessorCoreFiles: core, rows, conservativelyKept: rows.filter((r) => r.conservativeKept).length, transitions: rows.length,
}, null, 2));
