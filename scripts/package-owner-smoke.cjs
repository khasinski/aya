// Dependency preparation/build is separate; this stages and tests only local artifacts.
const fs = require("node:fs"), path = require("node:path"), { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."), target = process.env.AYA_OWNER_PACKAGE_PLATFORM || process.platform;
const output = path.join(root, "test-results", `owner-package-${target}`);
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: root, encoding: "utf8", timeout: 120000, ...options });
  if (result.status !== 0) throw new Error(`${file} failed: ${result.stderr || result.stdout || result.error}`);
  return result.stdout;
}
exports.verifyBuildReceipt = function verifyBuildReceipt(directory, receipt) {
  for (const [name, field] of [["aya-pty-owner", "ownerHash"], ["pty-owner-bridge.node", "bridgeHash"]]) {
    const actual = require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(directory, name))).digest("hex");
    if (actual !== receipt[field]) throw new Error(`Packaged ${name} does not match the build receipt`);
  }
};
exports.runStaged = function runStaged(outputDirectory, platform = process.platform) {
  const directory = path.resolve(outputDirectory), app = path.join(directory, "mac-arm64/Aya.app");
  const resources = platform === "darwin" ? path.join(app, "Contents/Resources") : path.join(directory, "linux-unpacked/resources");
  const executable = platform === "darwin" ? path.join(app, "Contents/MacOS/Aya") : path.join(directory, "linux-unpacked/aya");
  const home = fs.mkdtempSync(path.join(root, "test-results", "pkg-home-")); fs.chmodSync(home, 0o700);
  try {
    const env = { PATH: process.env.PATH, HOME: home, AYA_HOME: home, ELECTRON_RUN_AS_NODE: "1", LANG: "C" };
    const result = run(executable, [path.join(root, "scripts/owner-package-client.cjs"), resources, home], { env, timeout: 15000 });
    const runtime = run(executable, [path.join(root, "scripts/owner-package-runtime-client.cjs"), resources, home], { env, timeout: 20000 });
    console.log(result); console.log(runtime); return result + runtime;
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
};
if (require.main === module) (async () => {
  if (!["darwin", "linux"].includes(target)) throw new Error("Unsupported owner package platform");
  const { build, Platform, Arch } = require("electron-builder");
  // No certificate lookup, credentials, notarization, publishing or release/ output.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  const dist = process.env.AYA_OWNER_ELECTRON_DIST || path.join(path.dirname(require.resolve("electron/package.json")), "dist");
  const artifactDirectory = path.resolve(process.env.AYA_OWNER_PACKAGE_ARTIFACT_DIR || path.join(root, "dist-electron"));
  const receipt = JSON.parse(fs.readFileSync(path.join(artifactDirectory, "pty-owner-build.json")));
  if (receipt.platform !== target || receipt.arch !== (target === "darwin" ? "arm64" : "x64")) throw new Error("Wrong native artifacts for package target");
  const artifactNames = ["aya-pty-owner", "pty-owner-bridge.node", "pty-owner-build.json"];
  const extraArtifacts = process.env.AYA_OWNER_PACKAGE_ARTIFACT_DIR ? {
    files: [...require("../package.json").build.files, ...artifactNames.map(name => `!dist-electron/${name}`)],
    extraResources: [{ from: artifactDirectory, to: "app.asar.unpacked/dist-electron", filter: artifactNames }],
  } : {};
  await build({ targets: (target === "darwin" ? Platform.MAC : Platform.LINUX).createTarget("dir", target === "darwin" ? Arch.arm64 : Arch.x64),
    publish: "never", config: { directories: { output }, electronDist: dist, npmRebuild: false, ...extraArtifacts,
      mac: { identity: null, notarize: false } } });
  const app = path.join(output, "mac-arm64", "Aya.app");
  const resources = target === "darwin" ? path.join(app, "Contents/Resources") : path.join(output, "linux-unpacked/resources");
  const executable = target === "darwin" ? path.join(app, "Contents/MacOS/Aya") : path.join(output, "linux-unpacked/aya");
  // Compare the staged bytes before signing changes their content. Merely
  // recording a fresh hash would bless accidentally bundled stale binaries.
  exports.verifyBuildReceipt(path.join(resources, "app.asar.unpacked/dist-electron"), receipt);
  if (target === "darwin") {
    await require("./sign-macos.cjs").signStagedAdHoc(app);
    run("codesign", ["--verify", "--deep", "--strict", app]);
    const helper = path.join(resources, "app.asar.unpacked/dist-electron/aya-pty-owner");
    for (const binary of [helper, path.join(resources, "app.asar.unpacked/dist-electron/pty-owner-bridge.node")]) {
      const commands = run("otool", ["-l", binary]);
      if (!/minos 12\.0\b/.test(commands)) throw new Error("Owner component raised the macOS deployment floor");
    }
    run("codesign", ["--verify", "--strict", helper]);
    const entitlements = run("codesign", ["--display", "--entitlements", ":-", helper]);
    if (!entitlements.includes("audio-input") || entitlements.includes("allow-jit") || entitlements.includes("allow-unsigned-executable-memory") || entitlements.includes("disable-library-validation")) throw new Error("Wrong owner entitlements");
    const details = spawnSync("codesign", ["--display", "--verbose=4", helper], { encoding: "utf8" });
    if (!details.stderr.includes("runtime")) throw new Error("Owner missing hardened runtime");
    fs.writeFileSync(path.join(output, "owner-entitlements.plist"), entitlements);
  }
  const hash = (file) => require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const native = path.join(resources, "app.asar.unpacked/dist-electron");
  fs.writeFileSync(path.join(output, "owner-package-identity.json"), JSON.stringify({ target, notarization: "not-run",
    signing: target === "darwin" ? "ad-hoc; deep/strict verified; hardened runtime" : "not-applicable",
    ownerHash: hash(path.join(native, "aya-pty-owner")), bridgeHash: hash(path.join(native, "pty-owner-bridge.node")) }, null, 2) + "\n");
  if (target !== process.platform) { console.log(JSON.stringify({ stagedPackage: output, resources, executable, execution: "run on target OS" })); return; }
  exports.runStaged(output, target);
})().catch(error => { console.error(error); process.exitCode = 1; });
