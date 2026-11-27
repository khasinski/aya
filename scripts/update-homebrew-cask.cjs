#!/usr/bin/env node
// Points the Homebrew cask (aya-hq/homebrew-tap, Casks/aya.rb) at a published release:
//   node scripts/update-homebrew-cask.cjs <version> <tap checkout>
// The DMG's and AppImage's sha256 come from the release assets' digests on GitHub, so the cask names what users download.
// It writes the cask, commits it in the tap checkout and pushes.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO = "aya-hq/aya";

exports.caskSource = (version, { mac, linux }) => `cask "aya" do
  version "${version}"
  sha256 arm:          "${mac}",
         x86_64_linux: "${linux}"

  on_macos do
    url "https://github.com/${REPO}/releases/download/v#{version}/Aya-#{version}-arm64.dmg"

    depends_on arch: :arm64
    depends_on macos: :monterey

    app "Aya.app"
    binary "#{appdir}/Aya.app/Contents/Resources/app.asar.unpacked/bin/aya"

    zap trash: [
      "~/.aya",
      "~/Library/Application Support/Aya",
      "~/Library/Caches/aya-updater",
      "~/Library/Caches/com.aya.app",
      "~/Library/Caches/com.aya.app.ShipIt",
      "~/Library/HTTPStorages/com.aya.app",
      "~/Library/Preferences/com.aya.app.plist",
    ]
  end
  on_linux do
    url "https://github.com/${REPO}/releases/download/v#{version}/Aya-#{version}.AppImage"

    depends_on arch: :x86_64

    # Installs the AppImage's desktop entry and icon too. The name carries no version, so Aya's own update
    # replaces the same file.
    app_image "Aya-#{version}.AppImage", target: "Aya.AppImage"

    zap trash: [
      "~/.aya",
      "~/.cache/aya-updater",
      "~/.config/Aya",
    ]
  end

  name "Aya"
  desc "Terminal workspace for coding agents"
  homepage "https://aya.codes/"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Aya updates itself from its GitHub releases.
  auto_updates true
end
`;

if (require.main === module) {
  const [version, tap] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !tap) {
    console.error("Usage: node scripts/update-homebrew-cask.cjs <version> <tap checkout>");
    process.exit(2);
  }
  const digests = JSON.parse(execFileSync("gh", ["api", `repos/${REPO}/releases/tags/v${version}`, "--jq",
    "[.assets[] | {name, digest}]"], { encoding: "utf8" }));
  const sha256 = (asset) => {
    const found = /^sha256:([0-9a-f]{64})$/.exec(digests.find((a) => a.name === asset)?.digest ?? "")?.[1];
    if (!found) throw new Error(`No sha256 digest for ${asset} in release v${version}`);
    return found;
  };
  const sums = { mac: sha256(`Aya-${version}-arm64.dmg`), linux: sha256(`Aya-${version}.AppImage`) };
  const file = path.join(tap, "Casks", "aya.rb");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, exports.caskSource(version, sums));
  const git = (...args) => execFileSync("git", ["-C", tap, ...args], { stdio: "inherit" });
  git("add", "Casks/aya.rb");
  git("commit", "-m", `aya ${version}`);
  git("push");
  console.log(`Casks/aya.rb now installs Aya ${version} (macOS ${sums.mac}, Linux ${sums.linux})`);
}
