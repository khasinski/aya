import { scryptSync } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { test, expect } from "./fixtures";

// Aya Web listens on this computer only unless the user picks a network in Settings. A web.json written by an
// older Aya holds 0.0.0.0 though nobody chose it; while Aya Web is off it moves to 127.0.0.1. Neither test listens
// on a network address: "All networks" is not clicked here, only loopback ones.

const SALT = "00112233445566778899aabbccddeeff";
// A high port nobody else in the suite binds; Aya Web's own default (7683) may be taken by a running Aya.
const PORT = 40_000 + Math.floor(Math.random() * 20_000);

function webJson(extra: Record<string, unknown>): string {
  return JSON.stringify({
    enabled: false,
    port: PORT,
    user: "tester",
    passwordHash: scryptSync("pw", Buffer.from(SALT, "hex"), 32).toString("hex"),
    passwordSalt: SALT,
    ...extra,
  });
}

/** This computer's first non-internal IPv4 address, if it has one. Connecting to it stays on this computer. */
function ownNetworkAddress(): string | undefined {
  for (const infos of Object.values(networkInterfaces())) {
    for (const info of infos ?? []) if (info.family === "IPv4" && !info.internal) return info.address;
  }
  return undefined;
}

async function openAyaWeb(window: import("@playwright/test").Page) {
  await window.locator('button[title="Settings"]').click();
  await window.locator(".aya-settings-tab", { hasText: "General" }).click();
  return window.locator(".aya-settings-general-row", {
    has: window.locator(".aya-settings-general-title", { hasText: "Aya Web" }),
  });
}

test.describe("an old default 0.0.0.0 config that is off", () => {
  test.use({ seedOptions: { ayaHomeFiles: { "web.json": webJson({ host: "0.0.0.0" }) } } });

  test("turning Aya Web on serves 127.0.0.1 only", async ({ window, seeded }) => {
    const row = await openAyaWeb(window);
    // The address can be chosen before Aya Web is turned on, as the help text says.
    await expect(row.getByLabel("Aya Web listen address")).toHaveValue("127.0.0.1");
    await row.getByRole("button", { name: "On", exact: true }).click();
    await expect(row).toContainText(`Running at http://127.0.0.1:${PORT}`);
    await expect(row.getByLabel("Aya Web listen address")).toHaveValue("127.0.0.1");
    const saved = JSON.parse(readFileSync(join(seeded.ayaHome, "web.json"), "utf-8"));
    expect(saved.host).toBe("127.0.0.1");
    expect(saved.hostChosen).toBeUndefined();
    // It answers on loopback, and not on this computer's network address.
    expect((await fetch(`http://127.0.0.1:${PORT}/api/me`)).status).toBe(401);
    const lan = ownNetworkAddress();
    if (lan) await expect(fetch(`http://${lan}:${PORT}/api/me`)).rejects.toThrow();
  });
});

test.describe("a listen address picked in Settings", () => {
  test.use({ seedOptions: { ayaHomeFiles: { "web.json": webJson({ enabled: true, host: "::1" }) } } });

  test("is applied, shown and saved as the user's choice", async ({ window, seeded }) => {
    const row = await openAyaWeb(window);
    const select = row.getByLabel("Aya Web listen address");
    // An address no option covers is shown as it is, not as a choice that is not in use.
    await expect(select).toHaveValue("::1");
    await expect(row).toContainText(`Running at http://[::1]:${PORT}`);

    // A choice that cannot be saved changes nothing: Aya keeps serving and reporting ::1.
    chmodSync(seeded.ayaHome, 0o500);
    try {
      await select.selectOption("127.0.0.1");
      await expect(row.locator("div", { hasText: /EACCES|permission denied/i }).first()).toBeVisible();
    } finally {
      chmodSync(seeded.ayaHome, 0o700);
    }
    await window.keyboard.press("Escape");
    const reopened = await openAyaWeb(window);
    await expect(reopened.getByLabel("Aya Web listen address")).toHaveValue("::1");
    await expect(reopened).toContainText(`Running at http://[::1]:${PORT}`);

    await reopened.getByLabel("Aya Web listen address").selectOption("127.0.0.1");
    await expect(reopened).toContainText(`Running at http://127.0.0.1:${PORT}`);
    const saved = JSON.parse(readFileSync(join(seeded.ayaHome, "web.json"), "utf-8"));
    expect(saved.host).toBe("127.0.0.1");
    expect(saved.hostChosen).toBe(true);
    expect((await fetch(`http://127.0.0.1:${PORT}/api/me`)).status).toBe(401);
  });
});
