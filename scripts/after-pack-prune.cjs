const fs = require("node:fs");
const path = require("node:path");

const KEEP_LOCALES = new Set(["en.lproj", "en_GB.lproj", "pl.lproj"]);

function findApp(appOutDir) {
  const entries = fs.readdirSync(appOutDir, { withFileTypes: true });
  const app = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  return app ? path.join(appOutDir, app.name) : null;
}

function rm(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function pruneElectronLocales(appPath) {
  const resources = path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Versions",
    "A",
    "Resources",
  );
  if (!fs.existsSync(resources)) return;
  for (const entry of fs.readdirSync(resources, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".lproj")) continue;
    if (KEEP_LOCALES.has(entry.name)) continue;
    rm(path.join(resources, entry.name));
  }
}

function pruneNodePtyPrebuilds(appPath) {
  const prebuilds = path.join(
    appPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
  );
  if (!fs.existsSync(prebuilds)) return;
  for (const entry of fs.readdirSync(prebuilds, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "darwin-arm64") continue;
    rm(path.join(prebuilds, entry.name));
  }
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = findApp(context.appOutDir);
  if (!appPath) return;
  pruneElectronLocales(appPath);
  pruneNodePtyPrebuilds(appPath);

  // electron-builder calls this hook before applying fuses and signing. If no
  // certificate is available, ask its normal later signing phase to use the
  // ad-hoc identity. This keeps signing after fuses and still runs our normal
  // per-file entitlements hook.
  const packager = context.packager;
  const options = packager.platformSpecificBuildOptions;
  const identity = options.identity;
  let identityFound = identity === "-";
  if (identity !== null && identity !== "-") {
    const signingInfo = await packager.codeSigningInfo.value;
    const found = await packager.helper.findSigningIdentity(
      false,
      options.type === "development",
      identity,
      signingInfo.keychainFile,
      options,
    );
    identityFound = Boolean(found);
  }
  const { macSigningMode } = require("./macos-signing-policy.cjs");
  const mode = macSigningMode({ platform: context.electronPlatformName, identity, identityFound });
  if (mode === "ad-hoc-fallback") {
    options.identity = "-";
    console.info("No macOS signing identity was found; signing the local app ad hoc after fuses.");
  }
};
