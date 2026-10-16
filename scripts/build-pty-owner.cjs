// Build only. No owner is launched by Aya startup or normal terminal paths in B1.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const out = path.resolve(process.env.AYA_OWNER_BUILD_DIR || path.join(root, "dist-electron"));
if (!["darwin", "linux"].includes(process.platform)) throw new Error("PTY owner supports macOS and Linux");
const compiler = process.env.CC || "cc";
function run(args) {
  const result = spawnSync(compiler, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${compiler} failed: ${result.stderr || result.error}`);
  return result.stdout;
}
const source = "electron/native/pty-owner";
const paneLimit = JSON.parse(fs.readFileSync(path.join(root, "electron/pty-pane-limit.json"), "utf8")).maxPanes;
if (!Number.isSafeInteger(paneLimit) || paneLimit < 1 || paneLimit > 512) throw new Error("Invalid shared PTY pane limit");
const flags = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", `-ffile-prefix-map=${root}=.`,
  `-DOWNER_MAX_PANES=${paneLimit}`,
  ...(process.platform === "linux" ? ["-U_FORTIFY_SOURCE", "-D_FORTIFY_SOURCE=2"] : []),
  ...(process.platform === "darwin" ? ["-mmacosx-version-min=12.0"] : [])];
const compilerVersion = run(["--version"]);
const buildId = crypto.createHash("sha256").update(JSON.stringify({ platform: process.platform, arch: process.arch, flags: flags.map((f) => f.replace(root, ".")), compilerVersion }))
  .update(fs.readFileSync(path.join(root, "electron/pty-pane-limit.json"))).update(fs.readFileSync(path.join(root, source, "owner.c"))).update(fs.readFileSync(path.join(root, source, "protocol.h"))).update(fs.readFileSync(path.join(root, source, "process-identity.h"))).digest("hex");
const candidates = [process.env.AYA_NODE_HEADERS, path.resolve(path.dirname(process.execPath), "../include/node"),
  "/usr/local/include/node", "/usr/include/node", "/opt/homebrew/include/node"];
const headers = candidates.find((dir) => dir && fs.existsSync(path.join(dir, "node_api.h")));
if (!headers) throw new Error("Node-API headers missing; set AYA_NODE_HEADERS to prepared headers (build never downloads them)");
fs.mkdirSync(out, { recursive: true });
run([...flags, `-DOWNER_BUILD_ID="${buildId}"`, `${source}/owner.c`, "-o", path.join(out, "aya-pty-owner"), ...(process.platform === "linux" ? ["-lutil"] : [])]);
run([...flags, "-I", headers, ...(process.platform === "darwin" ? ["-bundle", "-undefined", "dynamic_lookup"] : ["-shared", "-fPIC"]),
  `${source}/bridge.c`, "-o", path.join(out, "pty-owner-bridge.node")]);
const hash = (name) => crypto.createHash("sha256").update(fs.readFileSync(path.join(out, name))).digest("hex");
fs.writeFileSync(path.join(out, "pty-owner-build.json"), JSON.stringify({ protocol: 2, buildId, platform: process.platform, arch: process.arch,
  maxPanes: paneLimit, compilerVersion: compilerVersion.trim(), ownerHash: hash("aya-pty-owner"), bridgeHash: hash("pty-owner-bridge.node") }, null, 2) + "\n");
