// A detached host is compatible when its PTY core and runtime bytes match.
// App version is diagnostic only: renderer/main/rule changes do not stop its panes.
// A missing actual hash is legacy/stale; unreadable expected bytes are indeterminate.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { builtinModules, createRequire } from "node:module";

// The host's entry script, as the client launches it and the sweep recognises it.
export const PTY_HOST_SCRIPT_NAME = "pty-host.js";
// The client runs the host with ELECTRON_RUN_AS_NODE=1; the sweep checks for it.
export const RUN_AS_NODE_VAR = "ELECTRON_RUN_AS_NODE";
export const RUN_AS_NODE_VALUE = "1";
// A scriptHash that could not be read. The reaper never kills on it.
export const UNKNOWN_SCRIPT_HASH = "unknown";

/** The build a host was launched from, from the `version` handshake; a host predating it errors, which the
 *  client maps to null (stale). */
export interface HostIdentity {
  /** App version from the host build's package.json. */
  version: string;
  /** sha256 of all built host modules, external runtime bytes and Node/Electron versions, captured at startup. */
  scriptHash: string;
  /** Diagnostic runtime versions; also included in scriptHash. Older identities omit them. */
  runtime?: { node: string; electron: string };
}

/** Compare the PTY content identity, independently of the app version. */
export function classifyIdentity(
  expected: { version: string; scriptHash: string },
  actual: { version: string; scriptHash: string },
): "compatible" | "stale" | "indeterminate" {
  if (!expected.scriptHash || expected.scriptHash === UNKNOWN_SCRIPT_HASH) {
    return "indeterminate";
  }
  if (!actual.scriptHash || actual.scriptHash === UNKNOWN_SCRIPT_HASH) return "stale";
  return actual.scriptHash === expected.scriptHash ? "compatible" : "stale";
}

/** True when the running host is stale; `actual === null` (failed handshake) is the strongest signal.
 *  An indeterminate identity is not stale: restarting the host kills every agent in it. */
export function isHostStale(
  expected: HostIdentity,
  actual: HostIdentity | null,
): boolean {
  if (!expected.scriptHash || expected.scriptHash === UNKNOWN_SCRIPT_HASH) return false;
  return actual === null || classifyIdentity(expected, actual) === "stale";
}

/** Every file the host runs from `dir`: its entry and the relative modules it
 *  requires inside `dir`, followed through, sorted. Read from the built CommonJS. */
export function hostModuleFiles(dir: string, entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(path.join(dir, file), "utf-8");
    for (const m of source.matchAll(/require\(["'](\.\.?\/[\w./-]+?)(?:\.js)?["']\)/g)) {
      // Resolved against the requiring file; a module outside `dir` is not the host's.
      const rel = path.relative(dir, path.resolve(dir, path.dirname(file), m[1]));
      if (rel.split(path.sep)[0] !== "..") visit(`${rel}.js`);
    }
  };
  visit(entry);
  return [...seen].sort();
}

/** One hash over the host's own files, so a change in any module it runs
 *  (not only its entry) marks a running host as another build. */
export function hostBuildHash(
  dir: string, entry: string,
  runtime = hostRuntimeIdentity(),
): string {
  const hash = crypto.createHash("sha256");
  // Format and runtime are content inputs: an old partial hash cannot accidentally compare equal.
  hash.update("aya-pty-core-v2\0").update(JSON.stringify(runtime)).update("\0");
  for (const file of hostModuleFiles(dir, entry)) {
    hash.update(file).update("\0").update(fs.readFileSync(path.join(dir, file))).update("\0");
  }
  for (const { name, file } of hostRuntimeFiles(dir, entry)) {
    hash.update(name).update("\0").update(fs.readFileSync(file)).update("\0");
  }
  return hash.digest("hex");
}

/** External runtime bytes, including node-pty's dynamically loaded native code.
 * Package metadata selects the entry but app package.json (including its version) is deliberately absent.
 * Runtime directories are covered conservatively: no docs, tests, source maps or C++ build intermediates. */
export function hostRuntimeFiles(dir: string, entry: string): { name: string; file: string }[] {
  const result = new Map<string, string>();
  const builtin = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  const packages = new Set<string>();
  for (const file of hostModuleFiles(dir, entry)) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    for (const m of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
      if (!m[1].startsWith(".") && !builtin.has(m[1])) packages.add(m[1]);
    }
  }
  if (hostModuleFiles(dir, entry).includes("pty-owner-client.js")) {
    const unpacked = dir.replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2");
    for (const name of ["pty-owner-bridge.node", "aya-pty-owner"]) {
      // The bridge runs in JS; owner byte changes require the confirmed native
      // restart in B2. Neither is allowed to disappear from the content check.
      const file = path.join(unpacked, name);
      if (!fs.statSync(file).isFile()) throw new Error(`Missing PTY owner runtime: ${name}`);
      result.set(name, file);
    }
  }
  const requireFromHost = createRequire(path.resolve(dir, entry));
  function tree(root: string, rel: string, label: string): void {
    const target = path.join(root, rel);
    if (!fs.existsSync(target)) return;
    for (const child of fs.readdirSync(target, { withFileTypes: true })) {
      const next = path.join(rel, child.name);
      if (child.isDirectory()) tree(root, next, label);
      else if (!/\.(?:map|pdb)$|\.test\.js$/.test(child.name) &&
        (/\.(?:js|mjs|cjs|json|node|dll|exe)$/.test(child.name) || child.name === "spawn-helper"))
        result.set(`${label}/${next.split(path.sep).join("/")}`, path.join(root, next));
    }
  }
  for (const name of [...packages].sort()) {
    if (name !== "node-pty" && name !== "@xterm/headless") throw new Error(`Unpinned PTY runtime dependency: ${name}`);
    const pkgFile = requireFromHost.resolve(`${name}/package.json`);
    const root = path.dirname(pkgFile);
    result.set(`${name}/package.json`, pkgFile);
    if (name === "@xterm/headless") tree(root, "lib-headless", name);
    else {
      tree(root, "lib", name);
      // loadNativeModule tries these in this order. Hash all available candidates, including the spawn helper;
      // an unreadable candidate fails the whole hash instead of blessing a partially measured build.
      tree(root, "build/Release", name);
      tree(root, "build/Debug", name);
      tree(root, `prebuilds/${process.platform}-${process.arch}`, name);
      if (![...result.keys()].some((f) => f.startsWith("node-pty/") && f.endsWith(".node")))
        throw new Error("PTY native runtime is missing");
    }
  }
  return [...result].sort(([a], [b]) => a.localeCompare(b)).map(([name, file]) => ({ name, file }));
}

export function hostRuntimeIdentity(): { node: string; electron: string } {
  return { node: process.versions.node, electron: process.versions.electron ?? "" };
}
