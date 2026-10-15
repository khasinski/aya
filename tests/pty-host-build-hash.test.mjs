// The pty host is stale when any module it runs changed, not only its entry
// script: a change in vt-state went unnoticed until a full restart (2026-09-28).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { hostBuildHash, hostModuleFiles } from "../dist-electron/pty-host-staleness.js";

function build(files) {
  const dir = mkdtempSync(join(tmpdir(), "aya-host-hash-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test("the host's modules are what its entry script requires, followed through", () => {
  const dir = build({
    "host.js": 'require("./a"); const x = require("./b"); require("node:fs"); require("some-package");',
    "a.js": 'require("./c");',
    "b.js": 'require("./a");',
    "c.js": "",
    "unrelated.js": 'require("./a");',
  });
  try {
    assert.deepEqual(hostModuleFiles(dir, "host.js"), ["a.js", "b.js", "c.js", "host.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a change in a required module changes the hash; a change elsewhere does not", () => {
  const dir = build({ "host.js": 'require("./a");', "a.js": 'require("./c");', "c.js": "1", "main.js": "1" });
  try {
    const before = hostBuildHash(dir, "host.js");
    writeFileSync(join(dir, "main.js"), "2");
    assert.equal(hostBuildHash(dir, "host.js"), before);
    writeFileSync(join(dir, "c.js"), "2");
    assert.notEqual(hostBuildHash(dir, "host.js"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requires into a subfolder and back up are followed, relative to the requiring file", () => {
  const dir = build({ "host.js": 'require("./sub/a.js");', "sub/a.js": 'require("../c");', "c.js": "1", "sub/c.js": "1" });
  try {
    assert.deepEqual(hostModuleFiles(dir, "host.js"), ["c.js", "host.js", "sub/a.js"]);
    const before = hostBuildHash(dir, "host.js");
    writeFileSync(join(dir, "sub/a.js"), 'require("../c"); // 2');
    assert.notEqual(hostBuildHash(dir, "host.js"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a require that resolves outside the host's dir is ignored", () => {
  const root = build({ "outside.js": "", "host/host.js": 'require("../outside"); require("./sub/../../outside");' });
  try {
    assert.deepEqual(hostModuleFiles(join(root, "host"), "host.js"), ["host.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the host's exact value-import graph contains only the PTY core", () => {
  const files = hostModuleFiles(new URL("../dist-electron", import.meta.url).pathname, "pty-host.js");
  assert.deepEqual(files, [
    "atomic-temp.js", "osc-extractor.js", "owner-socket.js", "pty-checkpoint-payload.js", "pty-checkpoint-store.js", "pty-core-checkpoint.js", "pty-core-constants.js", "pty-core.js",
    "pty-event-coalescer.js", "pty-handover-bootstrap.js", "pty-handover-window.js", "pty-host-guard.js", "pty-host-handover.js", "pty-host-paths.js", "pty-host-protocol.js",
    "pty-host-registry.js", "pty-host-staleness.js", "pty-host.js", "pty-log.js",
    "pty-owner-adapter.js", "pty-owner-client.js", "pty-owner-registry.js", "pty-owner-runtime.js",
    "vt-checkpoint-binding.js", "vt-checkpoint-schema.js", "vt-checkpoint.js", "vt-mirror.js", "vt-recovery-screen.js",
  ]);
});

test("modules that require each other are listed once, and the walk ends", () => {
  const dir = build({ "host.js": 'require("./a");', "a.js": 'require("./b");', "b.js": 'require("./a"); require("./host");' });
  try {
    assert.deepEqual(hostModuleFiles(dir, "host.js"), ["a.js", "b.js", "host.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the hash covers each file's name, not only its bytes", () => {
  const dir = build({ "host.js": "same", "main.js": "same" });
  try {
    assert.notEqual(hostBuildHash(dir, "host.js"), hostBuildHash(dir, "main.js"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime identity changes for Node or Electron, independent of app version", () => {
  const dir = build({ "host.js": "" });
  try {
    const runtime = { node: "24.0.0", electron: "43.0.0" };
    const hash = hostBuildHash(dir, "host.js", runtime);
    assert.notEqual(hostBuildHash(dir, "host.js", { ...runtime, node: "26.0.0" }), hash);
    assert.notEqual(hostBuildHash(dir, "host.js", { ...runtime, electron: "44.0.0" }), hash);
    writeFileSync(join(dir, "package.json"), '{"version":"99.0.0"}');
    assert.equal(hostBuildHash(dir, "host.js", runtime), hash);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the hash covers dependency JS, native binaries and helpers, but excludes docs and unrelated app files", () => {
  const dir = build({
    "host.js": 'require("node-pty"); require("@xterm/headless");',
    "node_modules/node-pty/package.json": '{"main":"lib/index.js"}',
    "node_modules/node-pty/lib/index.js": "runtime",
    "node_modules/node-pty/build/Release/pty.node": "native",
    "node_modules/node-pty/build/Release/spawn-helper": "helper",
    "node_modules/@xterm/headless/package.json": '{"main":"lib-headless/xterm-headless.js"}',
    "node_modules/@xterm/headless/lib-headless/xterm-headless.js": "mirror",
    "node_modules/node-pty/README.md": "docs",
  });
  try {
    const before = hostBuildHash(dir, "host.js");
    writeFileSync(join(dir, "node_modules/node-pty/README.md"), "changed docs");
    writeFileSync(join(dir, "package.json"), '{"version":"42.0.0"}');
    assert.equal(hostBuildHash(dir, "host.js"), before);
    for (const file of ["node-pty/lib/index.js", "node-pty/build/Release/pty.node",
      "node-pty/build/Release/spawn-helper", "@xterm/headless/lib-headless/xterm-headless.js"]) {
      const before = hostBuildHash(dir, "host.js");
      writeFileSync(join(dir, "node_modules", file), "changed runtime");
      assert.notEqual(hostBuildHash(dir, "host.js"), before, file);
    }
    rmSync(join(dir, "node_modules/node-pty/build/Release/pty.node"));
    assert.throws(() => hostBuildHash(dir, "host.js"), /native runtime is missing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("real host graph ignores changes to rules, main, renderer and app version", () => {
  const built = new URL("../dist-electron", import.meta.url).pathname;
  const modules = Object.fromEntries(hostModuleFiles(built, "pty-host.js").map((name) => [name, readFileSync(join(built, name), "utf8")]));
  const dir = build({
    ...modules,
    "aya-pty-owner": "native owner", "pty-owner-bridge.node": "native bridge",
    "node_modules/node-pty/package.json": '{"main":"lib/index.js"}',
    "node_modules/node-pty/lib/index.js": "runtime",
    "node_modules/node-pty/build/Release/pty.node": "native",
    "node_modules/@xterm/headless/package.json": '{"main":"lib-headless/xterm-headless.js"}',
    "node_modules/@xterm/headless/lib-headless/xterm-headless.js": "mirror",
  });
  try {
    const before = hostBuildHash(dir, "pty-host.js");
    for (const name of ["agent-screen-rules.js", "vt-state.js", "pty-prepare.js", "main.js", "renderer.js", "package.json"]) {
      writeFileSync(join(dir, name), "changed outside PTY core");
      assert.equal(hostBuildHash(dir, "pty-host.js"), before, name);
    }
    writeFileSync(join(dir, "vt-mirror.js"), modules["vt-mirror.js"] + "\n// PTY mirror changed");
    assert.notEqual(hostBuildHash(dir, "pty-host.js"), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
