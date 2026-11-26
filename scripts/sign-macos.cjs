const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { signAsync } = require("@electron/osx-sign");
function ownerOptions(file, fallback) {
  return path.basename(file) === "aya-pty-owner"
    ? { ...fallback, hardenedRuntime: true, entitlements: path.resolve(__dirname, "../build/entitlements.pty-owner.mac.plist") }
    : fallback;
}
const OWNER_IN_APP = "Contents/Resources/app.asar.unpacked/dist-electron/aya-pty-owner";
// The signed owner of the previous release. An updated Aya adopts the running owner only when its file hash equals the
// new owner file's, and every signature carries a fresh timestamp: identical code signed again never matches.
exports.PINNED_OWNER = path.resolve(__dirname, "../build/pty-owner-pinned/aya-pty-owner-darwin-arm64");

exports.signature = (file, run = spawnSync) => {
  const result = run("codesign", ["--display", "--verbose=4", file], { encoding: "utf8" });
  const text = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  const cdHash = /^CDHash=([0-9a-f]{40})$/m.exec(text)?.[1];
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(text)?.[1] ?? null;
  return result.status === 0 && cdHash ? { cdHash, team } : null;
};

/** After a normal signing pass: the pinned owner replaces the fresh one only when both code directories are the same
 * (code pages, entitlements, flags, identifier and team). Returns whether the app must be signed again around it. */
exports.pinOwner = (app, { pinned = exports.PINNED_OWNER, identity, run = spawnSync, log = console.log } = {}) => {
  const owner = path.join(app, OWNER_IN_APP);
  if (!fs.existsSync(owner) || identity === "-") return false;
  const signed = exports.signature(owner, run);
  if (!signed) throw new Error(`Cannot read the code directory of ${owner}`);
  // An ad-hoc or unsigned local package neither uses nor replaces the release pin.
  if (!signed.team) return false;
  const fresh = signed.cdHash;
  if (fs.existsSync(pinned)) {
    const verified = run("codesign", ["--verify", "--strict", pinned], { encoding: "utf8" }).status === 0;
    if (verified && exports.signature(pinned, run)?.cdHash === fresh) {
      fs.copyFileSync(pinned, owner);
      fs.chmodSync(owner, 0o755);
      log(`  • kept the previous release's signed aya-pty-owner (code directory ${fresh}): running terminals move to this update`);
      return true;
    }
  }
  fs.mkdirSync(path.dirname(pinned), { recursive: true });
  fs.copyFileSync(owner, pinned);
  log(`  • aya-pty-owner changed (code directory ${fresh}): an update to this build restarts terminals. Commit ${path.relative(process.cwd(), pinned)}.`);
  return false;
};

exports.default = async function sign(options) {
  const previous = options.optionsForFile;
  const signOptions = { ...options, optionsForFile: (file) => ownerOptions(file, previous?.(file) || {}) };
  await signAsync(signOptions);
  if (exports.pinOwner(options.app, { identity: options.identity })) {
    // osx-sign walks absolute paths, while electron-builder may hand over a relative app path.
    const owner = path.resolve(options.app, OWNER_IN_APP);
    const ignore = [...(options.ignore ? [options.ignore].flat() : []), (file) => path.resolve(file) === owner];
    await signAsync({ ...signOptions, ignore });
  }
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
