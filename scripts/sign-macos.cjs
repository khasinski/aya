const path = require("node:path");
const { signAsync } = require("@electron/osx-sign");
function ownerOptions(file, fallback) {
  return path.basename(file) === "aya-pty-owner"
    ? { ...fallback, hardenedRuntime: true, entitlements: path.resolve(__dirname, "../build/entitlements.pty-owner.mac.plist") }
    : fallback;
}
exports.default = async function sign(options) {
  const previous = options.optionsForFile;
  return signAsync({ ...options, optionsForFile: (file) => ownerOptions(file, previous?.(file) || {}) });
};
exports.signStagedAdHoc = (app) => exports.default({ app, identity: "-", identityValidation: false,
  platform: "darwin", preAutoEntitlements: false, preEmbedProvisioningProfile: false,
  optionsForFile: () => ({ hardenedRuntime: true, timestamp: "none", entitlements: path.resolve(__dirname, "../build/entitlements.mac.plist") }) });
