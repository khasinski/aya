import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";
import { GITHUB_LINK_CODEC } from "../src/app-preferences";
import {
  LOCAL_SUMMARIES_STORAGE_KEY,
  STATUSBAR_GITHUB_LINK_STORAGE_KEY,
  TERMINAL_SOUNDS_STORAGE_KEY,
  USAGE_HARNESS_NAME_STORAGE_KEY,
} from "../src/storage-keys";

// Two-way switches in Settings that no other spec drives. Each pin checks the
// switch's buttons and their order, which one starts active, and that a click
// moves the active state and stores the choice (every boolean preference is
// stored as the same "1"/"0", so one codec serializes them all).
const stored = (on: boolean) => GITHUB_LINK_CODEC.serialize(on);
const ACTIVE = /aya-settings-segment--active/;

const SWITCHES = [
  { tab: "General", label: "Terminal sounds", key: TERMINAL_SOUNDS_STORAGE_KEY, on: "On", off: "Off", startsOn: true },
  { tab: "General", label: "Usage icons", key: USAGE_HARNESS_NAME_STORAGE_KEY, on: "Show names", off: "Compact rings", startsOn: true },
  { tab: "General", label: "GitHub link", key: STATUSBAR_GITHUB_LINK_STORAGE_KEY, on: "Show", off: "Hide", startsOn: false },
  { tab: "Intelligence", label: "Aya Intelligence", key: LOCAL_SUMMARIES_STORAGE_KEY, on: "On", off: "Off", startsOn: false },
] as const;

const readStored = (window: Page, key: string) => window.evaluate((k) => localStorage.getItem(k), key);

for (const s of SWITCHES) {
  test(`Settings > ${s.tab} > ${s.label}: ${s.on}/${s.off} switch shows and stores the choice`, async ({ window, app }) => {
    await fireShortcut(app, "open-settings");
    const settings = window.locator(".aya-modal--settings");
    await expect(settings).toBeVisible();
    await settings.getByTestId("settings-tab").filter({ hasText: s.tab }).click();

    const group = settings.getByLabel(s.label, { exact: true });
    await expect(group).toHaveClass("aya-settings-segmented");
    await expect(group.getByRole("button")).toHaveText([s.on, s.off]);
    const onButton = group.getByRole("button", { name: s.on, exact: true });
    const offButton = group.getByRole("button", { name: s.off, exact: true });
    const [first, second] = s.startsOn ? [onButton, offButton] : [offButton, onButton];
    await expect(first).toHaveClass(ACTIVE);
    await expect(second).not.toHaveClass(ACTIVE);
    await expect(first).toBeEnabled();
    await expect(second).toBeEnabled();

    await second.click();
    await expect(second).toHaveClass(ACTIVE);
    await expect(first).not.toHaveClass(ACTIVE);
    await expect.poll(() => readStored(window, s.key)).toBe(stored(!s.startsOn));

    await first.click();
    await expect(first).toHaveClass(ACTIVE);
    await expect(second).not.toHaveClass(ACTIVE);
    await expect.poll(() => readStored(window, s.key)).toBe(stored(s.startsOn));
  });
}

test("Terminal sounds: the sound files show only while the switch is On", async ({ window, app }) => {
  await fireShortcut(app, "open-settings");
  const settings = window.locator(".aya-modal--settings");
  const group = settings.getByLabel("Terminal sounds", { exact: true });
  const files = settings.locator(".aya-sound-settings");
  await expect(files).toBeVisible();
  await group.getByRole("button", { name: "Off", exact: true }).click();
  await expect(files).toHaveCount(0);
  await group.getByRole("button", { name: "On", exact: true }).click();
  await expect(files).toBeVisible();
});
