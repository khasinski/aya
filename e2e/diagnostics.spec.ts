import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import type { ElectronApplication, Page } from "@playwright/test";

// Settings > Diagnostics. The support report is copy-pasted into bug reports, so
// it must be complete and the at-a-glance grid must not drift from the JSON it
// summarizes. Refresh must actually re-fetch and produce parseable JSON.

async function openDiagnostics(app: ElectronApplication, window: Page) {
  // Let the renderer finish its initial load before firing a main-process
  // shortcut, else app.evaluate can race a startup navigation.
  await window.waitForLoadState("load");
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  await expect(settings).toBeVisible();
  await settings.getByTestId("settings-tab").filter({ hasText: "Diagnostics" }).click();
  return settings;
}

test("Refresh produces a complete diagnostics report and the grid matches it", async ({
  window,
  app,
}) => {
  const settings = await openDiagnostics(app, window);
  await settings.locator(".aya-modal-btn", { hasText: "Refresh" }).click();
  await settings.locator(".aya-modal-btn", { hasText: "Copy JSON" }).click();
  await expect(settings.locator(".aya-modal-btn", { hasText: "Copied" })).toBeVisible();
  const json = JSON.parse((await app.evaluate(({ clipboard }) => clipboard.readText())).trim());

  // Completeness: the fields a support report relies on must all be present.
  expect(json.app?.version, "app.version").toBeTruthy();
  expect(["development", "production"], "app.mode").toContain(json.app?.mode);
  expect(typeof json.ptyHost?.ptyCount, "ptyHost.ptyCount").toBe("number");
  expect(typeof json.ptyHost?.stale, "ptyHost.stale").toBe("boolean");
  expect(Array.isArray(json.presets), "presets[]").toBe(true);
  expect(json.projects, "projects").toBeTruthy();
  expect(typeof json.projects.remote, "projects.remote").toBe("number");

  // The summary grid must reflect the same values (no display drift). Scope to
  // each labeled cell's <strong> and assert EXACT text - a plain grid-wide
  // substring match would false-pass (a wrong single-digit count still matches
  // a digit in the version string).
  const grid = settings.locator(".aya-settings-diagnostics-grid");
  const cell = (label: string) =>
    grid
      .locator("div")
      .filter({ has: window.getByText(label, { exact: true }) })
      .locator("strong");
  await expect(cell("Mode")).toHaveText(json.app.mode);
  await expect(cell("Version")).toHaveText(json.app.version);
  await expect(cell("PTYs")).toHaveText(String(json.ptyHost.ptyCount));
  await expect(cell("PTY host")).toHaveText(json.ptyHost.stale ? "stale" : "current");
  await expect(cell("Presets")).toHaveText(String(json.presets.length));
  await expect(cell("Remote projects")).toHaveText(String(json.projects.remote));
  const ruleSummary = settings.getByRole("region", { name: "User screen rules" });
  await expect(ruleSummary.locator("li")).toHaveText(["All agents: built-in rules only"]);
});

test("Copy JSON writes the exact report to the clipboard", async ({ window, app }) => {
  const settings = await openDiagnostics(app, window);
  await settings.locator(".aya-modal-btn", { hasText: "Refresh" }).click();
  await settings.locator(".aya-modal-btn", { hasText: "Copy JSON" }).click();
  await expect(
    settings.locator(".aya-modal-btn", { hasText: "Copied" }),
  ).toBeVisible();

  // Read the real OS clipboard via Electron: a no-op writeClipboard that still
  // flips the label to "Copied" must NOT pass.
  const clip = (await app.evaluate(({ clipboard }) => clipboard.readText())).trim();
  expect(() => JSON.parse(clip)).not.toThrow();
});

test.describe("local user-rule diagnostics", () => {
  const valid = JSON.stringify({ schemaVersion: 1, ruleSetVersion: "local-e2e-1", agent: "claude", rules: [
    { id: "local-prompt", kind: "prompt", region: "screen", pattern: "LOCAL_PROMPT", flags: "" },
    { id: "local-confirm", kind: "dialog", region: "tail", pattern: "LOCAL_CONFIRM", flags: "" },
    { id: "local-busy", kind: "busy", region: "lastLine", pattern: "LOCAL_BUSY", flags: "" },
  ] });
  test.use({ seedOptions: { ayaHomeFiles: { "screen-rules/claude.json": valid } } });

  test("shows a plain-language user-rule summary without technical metadata", async ({ window, app }) => {
    const settings = await openDiagnostics(app, window);
    await settings.locator(".aya-modal-btn", { hasText: "Refresh" }).click();
    const section = settings.getByRole("region", { name: "User screen rules" });
    await expect(section).toContainText("Files are in");
    await expect(section.locator("li")).toHaveText([
      "Claude: built-in rules + 3 of your rules (claude.json)",
      "Other agents: built-in rules only",
    ]);
    await expect(section.locator("li").first()).not.toContainText(/digest|version|source|user\/claude/);
    await settings.locator(".aya-modal-btn", { hasText: "Copy JSON" }).click();
    const report = JSON.parse((await app.evaluate(({ clipboard }) => clipboard.readText())).trim());
    const claude = report.userScreenRules.sets.find((set: { agent: string }) => set.agent === "claude");
    expect(claude.version).toBe("user/claude.json@local-e2e-1");
    expect(claude.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(claude.sources).toEqual(["user/claude.json"]);
  });
});

test.describe("invalid local user-rule diagnostics", () => {
  test.use({ seedOptions: { ayaHomeFiles: { "screen-rules/claude.json": JSON.stringify({
    schemaVersion: 1, ruleSetVersion: "broken", agent: "claude",
    rules: [{ id: "broken-pattern", kind: "prompt", region: "screen", pattern: 42, flags: "" }],
  }) } } });

  test("explains one invalid file and confirms built-in detection remains active", async ({ window, app }) => {
    const settings = await openDiagnostics(app, window);
    await settings.locator(".aya-modal-btn", { hasText: "Refresh" }).click();
    const section = settings.getByRole("region", { name: "User screen rules" });
    await expect(section).toContainText(/claude\.json: rule 1 pattern is not text/);
    await expect(section).toContainText("Aya continues to use built-in rules, so prompts are still detected.");
    await expect(section.locator("li")).toHaveCount(0);
    await expect(section.locator("p")).toHaveCount(2);
  });
});
