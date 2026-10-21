const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { signAsync } = require("@electron/osx-sign");
function ownerOptions(file, fallback) {
  return path.basename(file) === "aya-pty-owner"
    ? { ...fallback, hardenedRuntime: true, entitlements: path.resolve(__dirname, "../build/entitlements.pty-owner.mac.plist") }
    : fallback;
}
exports.default = async function sign(options) {
  const previous = options.optionsForFile;
  await signAsync({ ...options, optionsForFile: (file) => ownerOptions(file, previous?.(file) || {}) });
  exports.verifyStagedApp(options.app);
};
exports.signStagedAdHoc = (app) => exports.default({ app, identity: "-", identityValidation: false,
  platform: "darwin", preAutoEntitlements: false, preEmbedProvisioningProfile: false,
  optionsForFile: () => ({ hardenedRuntime: true, timestamp: "none", entitlements: path.resolve(__dirname, "../build/entitlements.mac.plist") }) });

exports.verifyStagedApp = (app, run = spawnSync) => {
  const result = run("codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`codesign verification failed for ${app}: ${result.stderr || result.stdout || result.error || `exit ${result.status}`}`);
  }
};
