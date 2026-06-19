const { _electron: electron } = require("@playwright/test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const APP_ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(APP_ROOT, "docs", "assets");

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function seedEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aya-site-shot-"));
  const ayaHome = path.join(root, "aya-home");
  const userDataDir = path.join(root, "electron-data");
  const projectDir = path.join(root, "project");
  mkdirp(path.join(ayaHome, "projects"));
  mkdirp(userDataDir);
  mkdirp(projectDir);

  writeJson(path.join(ayaHome, "presets.json"), {
    presets: [
      { id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" },
      { id: "claude", name: "Claude", icon: "C", color: "#d97757", command: "$SHELL" },
      { id: "codex", name: "Codex", icon: "O", color: "#24a47f", command: "$SHELL" },
    ],
  });

  writeJson(path.join(ayaHome, "projects", "aya-site.json"), {
    name: "aya",
    directory: projectDir,
    tabs: [
      { id: "tab-claude", presetId: "claude", name: "Claude review" },
      { id: "tab-codex", presetId: "codex", name: "Codex patch" },
    ],
    splitLayout: {
      rows: 1,
      cols: 2,
      rowFr: [1],
      colFr: [1, 1],
      cells: ["tab-claude", "tab-codex"],
      activeCell: 0,
    },
  });
  writeJson(path.join(ayaHome, "projects-state.json"), {
    version: 1,
    order: ["aya-site"],
    open: ["aya-site"],
    recent: ["aya-site"],
  });

  const now = new Date().toISOString();
  writeJson(path.join(ayaHome, "usage.json"), {
    accounts: [
      {
        id: "work",
        label: "Work",
        usage: {
          fiveHour: { pct: 36, resetsAt: "2026-06-19T21:30:00.000Z" },
          sevenDay: { pct: 58, resetsAt: "2026-06-23T09:00:00.000Z" },
          updatedAt: now,
        },
      },
      {
        id: "personal",
        label: "Personal",
        usage: {
          fiveHour: { pct: 14, resetsAt: "2026-06-19T23:10:00.000Z" },
          sevenDay: { pct: 28, resetsAt: "2026-06-24T16:00:00.000Z" },
          updatedAt: now,
        },
      },
    ],
  });

  const codexSessions = path.join(root, "codex-home", "sessions", "2026", "06", "19");
  mkdirp(codexSessions);
  fs.writeFileSync(
    path.join(codexSessions, "rollout-2026-06-19T18-00-00-site.jsonl"),
    `${JSON.stringify({
      timestamp: now,
      payload: {
        type: "token_count",
        rate_limits: {
          primary: { used_percent: 22, window_minutes: 300, resets_at: 1780523078 },
          secondary: { used_percent: 47, window_minutes: 10080, resets_at: 1780851308 },
          account_id: "codex-pro",
          plan_type: "plus",
        },
      },
    })}\n`,
  );

  fs.writeFileSync(
    path.join(projectDir, "package.json"),
    '{\n  "name": "aya-site-demo",\n  "version": "0.6.0"\n}\n',
  );
  fs.writeFileSync(
    path.join(projectDir, "README.md"),
    "# Aya site demo\n\nOld copy for the screenshot.\n",
  );
  execFileSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "site@example.test"], { cwd: projectDir });
  execFileSync("git", ["config", "user.name", "Aya Site"], { cwd: projectDir });
  execFileSync("git", ["add", "."], { cwd: projectDir });
  execFileSync("git", ["commit", "-m", "Initial demo"], { cwd: projectDir, stdio: "ignore" });
  fs.writeFileSync(
    path.join(projectDir, "README.md"),
    "# Aya site demo\n\nUpdated copy for the screenshot.\n\n- capture usage plans\n- show snippets\n- review the diff\n",
  );
  fs.writeFileSync(
    path.join(projectDir, "src.ts"),
    "export function label() {\n  return 'Aya 0.6';\n}\n",
  );

  return { root, ayaHome, userDataDir, projectDir };
}

async function waitForApp(page) {
  await page.waitForSelector(".aya-app", { timeout: 20_000 });
  await page.waitForSelector(".aya-statusbar", { timeout: 20_000 });
  await page.waitForTimeout(700);
}

async function setDarkTheme(page) {
  await page.evaluate(() => localStorage.setItem("aya:app-theme", "dark"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForApp(page);
  await page.waitForSelector('.aya-app[data-theme="dark"]', { timeout: 10_000 });
}

async function screenshotUnion(page, locators, out, padding = 18) {
  const boxes = [];
  for (const locator of locators) {
    const box = await locator.boundingBox();
    if (box) boxes.push(box);
  }
  if (boxes.length === 0) throw new Error(`No boxes for ${out}`);
  const left = Math.max(0, Math.min(...boxes.map((b) => b.x)) - padding);
  const top = Math.max(0, Math.min(...boxes.map((b) => b.y)) - padding);
  const right = Math.min(1440, Math.max(...boxes.map((b) => b.x + b.width)) + padding);
  const bottom = Math.min(920, Math.max(...boxes.map((b) => b.y + b.height)) + padding);
  await page.screenshot({
    path: out,
    clip: { x: left, y: top, width: right - left, height: bottom - top },
  });
}

async function main() {
  mkdirp(OUT_DIR);
  const seeded = seedEnv();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.AYA_DEV;
  env.AYA_HOME = seeded.ayaHome;
  env.AYA_E2E_PTY_SHUTDOWN = "1";
  env.AYA_E2E_HEADLESS = "1";
  env.CODEX_HOME = path.join(seeded.root, "codex-home");

  const app = await electron.launch({
    cwd: APP_ROOT,
    env,
    args: [
      path.join(APP_ROOT, "dist-electron", "main.js"),
      `--user-data-dir=${seeded.userDataDir}`,
    ],
  });

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 920 });
    await page.waitForLoadState("domcontentloaded");
    await waitForApp(page);
    await setDarkTheme(page);

    const claudeChip = page.getByRole("button", { name: /claude usage, account-wide/i });
    await claudeChip.click();
    const usageMenu = page.locator(".aya-recent-menu").filter({ hasText: "Claude" }).first();
    await usageMenu.waitFor({ state: "visible", timeout: 10_000 });
    await screenshotUnion(
      page,
      [page.locator(".aya-topbar").first(), usageMenu],
      path.join(OUT_DIR, "aya-usage-chips.png"),
      10,
    );

    await page.keyboard.press("Escape").catch(() => undefined);
    await page.locator('[data-testid="snippet-toggle"]').first().click();
    const drawer = page.locator('[data-testid="snippet-drawer"].aya-snippetbar--open').first();
    await drawer.waitFor({ state: "visible", timeout: 10_000 });
    await drawer.screenshot({ path: path.join(OUT_DIR, "aya-snippets-drawer.png") });

    await page.locator(".aya-statusbar-item--warn", { hasText: "dirty" }).first().click();
    await page.getByRole("button", { name: "Show diff" }).click();
    const diffPopover = page.locator(".aya-statusbar-popover--diff").first();
    await diffPopover.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForSelector(".aya-diff-view-line--add", { timeout: 10_000 });
    await diffPopover.screenshot({ path: path.join(OUT_DIR, "aya-diff.png") });
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(seeded.root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
