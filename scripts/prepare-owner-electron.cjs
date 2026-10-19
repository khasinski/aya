// Online dependency preparation, deliberately separate from offline test/smoke execution.
const fs = require("node:fs"), path = require("node:path");
(async () => {
  const platform = process.env.AYA_OWNER_PACKAGE_PLATFORM || process.platform;
  const arch = platform === "darwin" ? "arm64" : "x64";
  const version = require("electron/package.json").version;
  const output = path.resolve("test-results/owner-electron");
  const stamp = path.join(output, ".prepared.json");
  const identity = JSON.stringify({ platform, arch, version });
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === identity) return;
  const archive = await require("@electron/get").downloadArtifact({ platform, arch, version,
    artifactName: "electron", cacheRoot: path.resolve("test-results/owner-electron-cache") });
  fs.rmSync(output, { recursive: true, force: true }); fs.mkdirSync(output, { recursive: true });
  const extraction = require("node:child_process").spawnSync("unzip", ["-q", archive, "-d", output], { encoding: "utf8" });
  if (extraction.status !== 0) throw new Error(`Electron extraction failed: ${extraction.stderr || extraction.error}`); fs.writeFileSync(stamp, identity);
  console.log(`Prepared Electron ${version} ${platform}/${arch} at ${output}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
