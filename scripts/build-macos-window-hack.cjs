#!/usr/bin/env node

const { existsSync, mkdirSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform !== "darwin") process.exit(0);

const root = join(__dirname, "..");
const source = join(root, "electron", "native", "macos-window-hack.mm");
const outDir = join(root, "dist-electron");
const out = join(outDir, "macos-window-hack.node");

const includeCandidates = [
  join(dirname(process.execPath), "..", "include", "node"),
  join(process.env.HOME ?? "", "Library", "Caches", "node-gyp", process.versions.node, "include", "node"),
  join(process.env.HOME ?? "", "Library", "Caches", "node-gyp", "26.0.0", "include", "node"),
  join(process.env.HOME ?? "", "Library", "Caches", "node-gyp", "24.12.0", "include", "node"),
];

const includeDir = includeCandidates.find((dir) =>
  existsSync(join(dir, "node_api.h")),
);

if (!includeDir) {
  console.error("Could not find node_api.h for macOS window hack build.");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const args = [
  "-std=c++17",
  "-ObjC++",
  "-fobjc-arc",
  "-dynamiclib",
  "-undefined",
  "dynamic_lookup",
  "-framework",
  "Cocoa",
  "-I",
  includeDir,
  source,
  "-o",
  out,
];

const result = spawnSync("clang++", args, { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
