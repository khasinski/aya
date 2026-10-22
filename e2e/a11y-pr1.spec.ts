import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { reloadInProjectsLeftLayout } from "./helpers/layout";

const SETTINGS_SHOT = "/tmp/a11y-pr1-after-settings.png";
const focusDescription = (page: Page) => page.evaluate(() => {
  const item = document.activeElement as HTMLElement;
  return {
    tag: item.tagName,
    id: item.id,
    testId: item.getAttribute("data-testid"),
    ariaLabel: item.getAttribute("aria-label"),
    text: item.textContent?.trim(),
  };
});

test("Settings is labelled and keeps keyboard focus until it closes", async ({ window }) => {
  const opener = window.getByRole("button", { name: "Settings" });
  await opener.click();

  const dialog = window.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.screenshot({ path: SETTINGS_SHOT });
  const font = window.getByRole("textbox", { name: "Terminal font" });
  await expect(font).toBeVisible();
  await expect(font).toHaveAttribute("id", "aya-terminal-font-family");
  await expect
    .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);

  const endpoints = await dialog.evaluate((element) => {
    const selector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled]):not([type=hidden])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      '[tabindex]:not([tabindex="-1"])',
    ].join(",");
    const focusable = [...element.querySelectorAll<HTMLElement>(selector)].filter(
      (item) => item.getAttribute("aria-hidden") !== "true" && item.getClientRects().length > 0,
    );
    const describe = (item: HTMLElement) => ({
      tag: item.tagName,
      id: item.id,
      testId: item.getAttribute("data-testid"),
      ariaLabel: item.getAttribute("aria-label"),
      text: item.textContent?.trim(),
    });
    focusable[focusable.length - 1]?.focus();
    return {
      first: describe(focusable[0]),
      last: describe(focusable[focusable.length - 1]),
      count: focusable.length,
    };
  });
  expect(endpoints.count).toBeGreaterThan(1);
  await window.keyboard.press("Tab");
  await expect.poll(() => focusDescription(window)).toEqual(endpoints.first);
  await window.keyboard.press("Shift+Tab");
  await expect.poll(() => focusDescription(window)).toEqual(endpoints.last);

  await window.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("Settings consent prompts contain focus and Escape closes only the top dialog", async ({ window }) => {
  const settingsOpener = window.getByRole("button", { name: "Settings" });
  await settingsOpener.click();
  const settings = window.getByRole("dialog", { name: "Settings" });

  for (const prompt of [
    { row: "Claude usage chip", name: "Enable the usage chip?" },
    { row: "Automatic status", name: "Enable automatic status?" },
  ]) {
    const row = window.locator(".aya-settings-general-row").filter({ hasText: prompt.row });
    const consentOpener = row.getByRole("button", { name: "Enable" });
    await expect(consentOpener).toBeEnabled();
    await consentOpener.click();

    const consent = window.getByRole("dialog", { name: prompt.name });
    await expect(consent).toBeVisible();
    await expect.poll(() => consent.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expect(settings.locator(".aya-settings-chrome")).toHaveAttribute("inert", "");

    const cancel = consent.getByRole("button", { name: "Cancel" });
    const enable = consent.getByRole("button", { name: "Enable" });
    await cancel.focus();
    await window.keyboard.press("Shift+Tab");
    await expect(enable).toBeFocused();
    await window.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    await window.keyboard.press("Escape");

    await expect(consent).toHaveCount(0);
    await expect(settings).toBeVisible();
    await expect(consentOpener).toBeFocused();

    await consentOpener.focus();
    await window.keyboard.press("Enter");
    await expect(consent).toBeVisible();
    await window.locator(".aya-modal-backdrop").last().click({ position: { x: 5, y: 5 } });
    await expect(consent).toHaveCount(0);
    await expect(settings).toBeVisible();
    await expect(consentOpener).toBeFocused();
  }

  await window.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(settingsOpener).toBeFocused();
});

test("New project is a named native button and status dots name their state", async ({ window }) => {
  const newProject = window.getByRole("button", { name: "New project" });
  await expect(newProject).toBeEnabled();
  expect(await newProject.evaluate((element) => element.tagName)).toBe("BUTTON");
  await newProject.click();
  await expect(newProject).toBeDisabled();
  await window.keyboard.press("Escape");
  await expect(newProject).toBeEnabled();

  await expect.poll(() => window.locator(".aya-sidebar-statusdot").count()).toBeGreaterThan(0);
  const dot = window.locator(".aya-sidebar-statusdot").first();
  await expect(dot).toHaveAttribute("role", "img");
  await expect(dot).toHaveAttribute("aria-label", /.+: Terminal is (running|idle|stopped)\./);
  await expect(dot).toHaveAttribute("title", /Terminal is (running|idle|stopped)\./);

  await reloadInProjectsLeftLayout(window);
  await expect(window.locator(".aya-topbar--alt")).toBeVisible();
  await expect(window.getByRole("navigation", { name: "Projects and terminals" })).toBeVisible();
  const altDot = window.locator(".aya-termtab .aya-sidebar-statusdot").first();
  await expect(altDot).toHaveAttribute("role", "img");
  await expect(altDot).toHaveAttribute("aria-label", /.+: Terminal is (running|idle|stopped)\./);
  await expect(altDot).toHaveAttribute("title", /Terminal is (running|idle|stopped)\./);
});

test("workspace exposes named main and terminal navigation landmarks", async ({ window }) => {
  await expect(window.getByRole("heading", { name: "Aya", exact: true, level: 1 })).toBeAttached();
  await expect(window.getByRole("main", { name: "Terminal workspace" })).toBeAttached();
  await expect(window.getByRole("navigation", { name: "Terminals" })).toBeAttached();
});

test("empty workspace keeps one main landmark in projects-left layout", async ({ window }) => {
  await reloadInProjectsLeftLayout(window);
  await expect(window.locator(".aya-main--alt")).toBeVisible();
  await window.locator(".aya-railtab-close").first().click();
  await expect(window.getByText("Open directory")).toBeVisible();
  await expect(window.getByRole("main")).toHaveCount(1);
  await expect(window.getByRole("navigation", { name: "Projects and terminals" })).toBeVisible();
});
