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
};
