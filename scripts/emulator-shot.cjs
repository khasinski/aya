#!/usr/bin/env node
// Screenshot the Aya emulator in one or more scenarios.
//
// The emulator (emulator.html → src/emulator/) runs the REAL Aya renderer with
// a fully mocked window.aya, so these shots are pixel-identical to the desktop
// app in whatever state a scenario scripts. See src/emulator/scenarios.ts.
//
// Usage:
//   node scripts/emulator-shot.cjs [scenario ...] [--out DIR] [--width N] [--height N]
//   npm run emulator:shot -- default busy --out screenshots/emulator
//
// With no scenario names it shoots "default" and "busy". It spawns its own Vite
// dev server on an ephemeral port and tears it down when done, so nothing needs
// to be running first.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");

const repoRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const scenarios = [];
  const opts = { out: "screenshots/emulator", width: 1440, height: 900, scale: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") opts.out = argv[++i];
    else if (a === "--width") opts.width = Number(argv[++i]);
    else if (a === "--height") opts.height = Number(argv[++i]);
    else if (a === "--scale") opts.scale = Number(argv[++i]);
    else scenarios.push(a);
  }
  if (scenarios.length === 0) scenarios.push("default", "busy");
  return { scenarios, opts };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = require("node:http").get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error("dev server did not start"));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

// Playwright's bundled browser can lag the installed browser build number, so
// resolve a Chromium executable ourselves: prefer a full Chromium, fall back to
// the headless shell, then to whatever chromium.launch() finds on its own.
function findChromium() {
  const base = path.join(
    require("node:os").homedir(),
    "Library/Caches/ms-playwright",
  );
  let dirs = [];
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return undefined;
  }
  const candidates = [];
  for (const d of dirs) {
    if (d.startsWith("chromium-")) {
      for (const sub of ["chrome-mac-arm64", "chrome-mac"]) {
        candidates.push(
          path.join(base, d, sub, "Chromium.app/Contents/MacOS/Chromium"),
        );
      }
    }
    if (d.startsWith("chromium_headless_shell-")) {
      for (const sub of [
        "chrome-headless-shell-mac-arm64",
        "chrome-headless-shell-mac-x64",
      ]) {
        candidates.push(path.join(base, d, sub, "chrome-headless-shell"));
      }
    }
  }
  return candidates.find((p) => fs.existsSync(p));
}

async function main() {
  const { scenarios, opts } = parseArgs(process.argv.slice(2));
  const port = await freePort();
  const outDir = path.resolve(repoRoot, opts.out);
  fs.mkdirSync(outDir, { recursive: true });

  const vite = spawn(
    path.join(repoRoot, "node_modules/.bin/vite"),
    ["--port", String(port), "--strictPort"],
    { cwd: repoRoot, stdio: "ignore" },
  );
  const cleanup = () => {
    try {
      vite.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  try {
    await waitForHttp(`http://localhost:${port}/emulator.html`, 30000);

    const { chromium } = require("playwright-core");
    const executablePath = findChromium();
    const browser = await chromium.launch({ headless: true, executablePath });

    for (const name of scenarios) {
      const page = await browser.newPage({
        viewport: { width: opts.width, height: opts.height },
        deviceScaleFactor: opts.scale,
      });
      const url = `http://localhost:${port}/emulator.html?scenario=${encodeURIComponent(name)}`;
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForSelector(".aya-pane", { timeout: 15000 });
      // Let terminal content + web fonts settle before the shot.
      await page.waitForTimeout(1800);
      const file = path.join(outDir, `${name}.png`);
      await page.screenshot({ path: file });
      console.log(`✔ ${name} → ${path.relative(repoRoot, file)}`);
      await page.close();
    }

    await browser.close();
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
