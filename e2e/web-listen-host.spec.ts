import { scryptSync } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { test, expect } from "./fixtures";

// A new Aya Web setup listens on this computer only until the user picks a network in Settings. A saved web.json keeps
// its address, 0.0.0.0 included, and Settings warns while it listens on every network. No test here listens on a
// network address: a 0.0.0.0 config is only ever seen while Aya Web is off.

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

test.describe("a new setup", () => {
  test("listens on this computer only, with no warning", async ({ window, seeded }) => {
    const row = await openAyaWeb(window);
    await expect(row.getByLabel("Aya Web listen address")).toHaveValue("127.0.0.1");
    await expect(row).not.toContainText("Warning:");
    const saved = JSON.parse(readFileSync(join(seeded.ayaHome, "web.json"), "utf-8"));
    expect(saved).toMatchObject({ enabled: false, host: "127.0.0.1" });
  });
});

test.describe("a saved 0.0.0.0 config that is off", () => {
  test.use({ seedOptions: { ayaHomeFiles: { "web.json": webJson({ host: "0.0.0.0" }) } } });

  test("keeps its address with a warning, and one click moves it to this computer", async ({ window, seeded }) => {
    const savedConfig = () => JSON.parse(readFileSync(join(seeded.ayaHome, "web.json"), "utf-8"));
    const row = await openAyaWeb(window);
    // An update does not move it: whoever reaches Aya Web from another device keeps doing so.
    await expect(row.getByLabel("Aya Web listen address")).toHaveValue("0.0.0.0");
    // A status region, so a screen reader reads it out when it appears after a change.
    const warning = row.getByRole("status");
    await expect(warning).toContainText("Warning: Aya Web will listen on every network");
    await expect(warning).toContainText("travel unencrypted");
    expect(savedConfig().host).toBe("0.0.0.0");

    await row.getByRole("button", { name: "This computer only" }).click();
    await expect(row.getByLabel("Aya Web listen address")).toHaveValue("127.0.0.1");
    await expect(row).not.toContainText("Warning:");
    expect(savedConfig()).toMatchObject({ enabled: false, host: "127.0.0.1" });

    // Turned on now, it serves loopback only, not this computer's network address.
    await row.getByRole("button", { name: "On", exact: true }).click();
    await expect(row).toContainText(`Running at http://127.0.0.1:${PORT}`);
    expect((await fetch(`http://127.0.0.1:${PORT}/api/me`)).status).toBe(401);
    const lan = ownNetworkAddress();
    if (lan) await expect(fetch(`http://${lan}:${PORT}/api/me`)).rejects.toThrow();
  });
});

test.describe("a saved IPv6 wildcard in another spelling", () => {
  test.use({ seedOptions: { ayaHomeFiles: { "web.json": webJson({ host: "::ffff:0:0" }) } } });

  test("gets the same warning and button", async ({ window }) => {
    const row = await openAyaWeb(window);
    await expect(row.getByLabel("Aya Web listen address")).toHaveValue("::ffff:0:0");
    await expect(row.getByRole("status")).toContainText("Warning: Aya Web will listen on every network");
    await row.getByRole("button", { name: "This computer only" }).click();
    await expect(row.getByLabel("Aya Web listen address")).toHaveValue("127.0.0.1");
    await expect(row.getByRole("status")).toHaveCount(0);
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
    expect((await fetch(`http://127.0.0.1:${PORT}/api/me`)).status).toBe(401);
  });
});

test.describe("Aya Web while it is off", () => {
  test.use({ seedOptions: { ayaHomeFiles: { "web.json": webJson({ enabled: false, host: "::1" }) } } });

  test("an address chosen while off is saved, and changes at the same time are applied in turn", async ({
    window,
    seeded,
  }) => {
    const savedConfig = () => JSON.parse(readFileSync(join(seeded.ayaHome, "web.json"), "utf-8"));
    const row = await openAyaWeb(window);
    const select = row.getByLabel("Aya Web listen address");
    await expect(select).toHaveValue("::1");
    await select.selectOption("127.0.0.1");
    await expect.poll(() => savedConfig().host).toBe("127.0.0.1");
    expect(savedConfig()).toMatchObject({ enabled: false, host: "127.0.0.1" });
    await expect(fetch(`http://127.0.0.1:${PORT}/api/me`)).rejects.toThrow();

    // Two windows, or a window and Aya Web, may change the config at once: neither change is lost.
    const otherPort = PORT + 1;
    await window.evaluate(
      (port) => Promise.all([window.aya.configureWeb({ host: "::1" }), window.aya.configureWeb({ port })]),
      otherPort,
    );
    expect(savedConfig()).toMatchObject({ host: "::1", port: otherPort, enabled: false });

    // A disable sent while an enable is still starting the server leaves it off.
    const status = await window.evaluate(async () => {
      await Promise.all([window.aya.configureWeb({ enabled: true }), window.aya.configureWeb({ enabled: false })]);
      return window.aya.webStatus();
    });
    expect(status).toMatchObject({ enabled: false, running: false });
    expect(savedConfig().enabled).toBe(false);
    await expect(fetch(`http://[::1]:${otherPort}/api/me`)).rejects.toThrow();
  });
});
