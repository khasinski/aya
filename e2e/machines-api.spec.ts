import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./fixtures";
import { seedBase, openMachinesSettings } from "./helpers/machines";

test.use({ seedOptions: { ...seedBase, homeFiles: { ".ssh/config": "Host darwine\n" }, ayaHomeFiles: {
  "machines.json": JSON.stringify({ version: 1, machines: [{ id: "darwine", reach: { ssh: "darwine" }, ollama: { port: 11434 } }] }),
} } });

test("API settings keep credentials private; a served model stays visible with unavailable GPU telemetry", async ({ app, window, seeded }) => {
  const token = "e2e-fixture-token";
  const received: (string | undefined)[] = [];
  const api = createServer((req, res) => {
    received.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    res.statusCode = req.headers.authorization === `Bearer ${token}` ? 200 : 401;
    res.end(res.statusCode === 200 ? '{"data":[{"id":"qwen3.8-27b","owned_by":"ninfer"}]}' : token);
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  try {
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("no API port");
    const url = `http://127.0.0.1:${address.port}`;
    const panel = await openMachinesSettings(window, app);
    await panel.getByRole("combobox", { name: "Backend for darwine" }).selectOption("openai-compatible");
    await panel.getByRole("textbox", { name: "API URL for darwine" }).fill(url);
    const password = panel.getByLabel("Bearer token for darwine");
    await expect(password).toHaveAttribute("type", "password");
    await password.fill(token);
    await panel.getByRole("button", { name: "Save backend" }).click();
    await expect(panel.getByRole("status")).toHaveText("darwine configured: OpenAI-compatible API");
    await expect(password).toHaveValue("");
    await expect(panel).toContainText("Token saved.");
    const setup = await window.evaluate(() => window.aya.machinesSetup());
    expect(JSON.stringify(setup)).not.toContain(token);
    expect(readFileSync(join(seeded.ayaHome, "machines.json"), "utf8")).not.toContain(token);
    expect(statSync(join(seeded.ayaHome, "machines-auth.json")).mode & 0o777).toBe(0o600);
    await window.keyboard.press("Escape");
    await window.getByTestId("machines-toggle").click();
    const popover = window.getByRole("dialog", { name: "Machines" });
    await expect(popover).toContainText("API available (OpenAI-compatible)");
    await expect(popover).toContainText("qwen3.8-27b · served by API");
    await expect(popover).toContainText("GPU telemetry unavailable");
    await expect(popover.getByText("qwen3.8-27b", { exact: false })).not.toContainText(/GiB|until|loaded/);
    expect(received).toContain(`Bearer ${token}`);
    const status = await window.evaluate(() => window.aya.machinesStatus());
    expect(JSON.stringify(status)).not.toContain(token);

    await window.keyboard.press("Escape");
    const again = await openMachinesSettings(window, app);
    await again.getByRole("textbox", { name: "API URL for darwine" }).fill(`${url}/other`);
    await expect(again.getByLabel("Bearer token for darwine")).toHaveValue("");
    await again.getByRole("button", { name: "Save backend" }).click();
    await expect(again).toContainText("No token saved for this URL.");
    expect(JSON.parse(readFileSync(join(seeded.ayaHome, "machines-auth.json"), "utf8")).entries).toEqual([]);
    await window.keyboard.press("Escape");
    await window.getByTestId("machines-toggle").click();
    await expect(window.getByRole("dialog", { name: "Machines" })).toContainText("API authentication failed");
    await expect(window.getByRole("dialog", { name: "Machines" }).getByText("API authentication failed", { exact: true })).toHaveCount(1);
    expect(received).toContain(undefined);
  } finally { api.closeAllConnections(); await new Promise<void>((r) => api.close(() => r())); }
});

test("saved token preview stays local and masked, updates on same-URL replacement, and disappears on clear/change/switch/remove", async ({ app, window, seeded }) => {
  const api = createServer((_req, res) => res.end('{"data":[{"id":"qwen"}]}'));
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  try {
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("no fixture port");
    const base = `http://127.0.0.1:${address.port}`;
    const panel = await openMachinesSettings(window, app);
    const backend = panel.getByRole("combobox", { name: "Backend for darwine" });
    await backend.selectOption("openai-compatible");
    const url = panel.getByRole("textbox", { name: "API URL for darwine" });
    const password = panel.getByLabel("Bearer token for darwine");
    const preview = panel.locator(".aya-modal-hint code");
    const save = panel.getByRole("button", { name: "Save backend" });
    await url.fill(base);

    const checkPreview = async (fullToken: string, expected: string) => {
      await expect(preview).toHaveText(expected);
      await expect(panel).toContainText(`Saved token: ${expected}`);
      await expect(password).toHaveValue("");
      const setup = await window.evaluate(() => window.aya.machinesSetup());
      expect(setup.machines[0].api?.savedTokenPreview).toBe(expected);
      expect(JSON.stringify(setup)).not.toContain(fullToken);
      const publicSetup = await app.evaluate(async () => {
        const require = process.getBuiltinModule("module").createRequire(`${process.cwd()}/package.json`);
        return require("./dist-electron/ipc/web-capture.js").invokeCapturedIpcHandler("machines:setup", []);
      });
      expect(JSON.stringify(publicSetup)).not.toContain("savedTokenPreview");
      expect(JSON.stringify(publicSetup)).not.toContain(fullToken);
      const status = JSON.stringify(await window.evaluate(() => window.aya.machinesStatus()));
      expect(status).not.toContain(fullToken); expect(status).not.toContain("savedTokenPreview");
      const registry = readFileSync(join(seeded.ayaHome, "machines.json"), "utf8");
      expect(registry).not.toContain(fullToken); expect(registry).not.toContain("savedTokenPreview");
      expect(statSync(join(seeded.ayaHome, "machines-auth.json")).mode & 0o777).toBe(0o600);
    };

    await password.fill("abcd-first-fixture-secret"); await save.click();
    await checkPreview("abcd-first-fixture-secret", "abcd••••••••");
    await password.fill("wxyz-replacement-fixture-secret"); await save.click();
    await checkPreview("wxyz-replacement-fixture-secret", "wxyz••••••••");
    await expect(panel).not.toContainText("abcd••••••••");

    const savedUrl = `${base}/v1`;
    await url.fill(`${base}/changed`); await expect(preview).toHaveCount(0);
    await url.fill(savedUrl); await expect(preview).toHaveText("wxyz••••••••");
    await backend.selectOption("ollama"); await expect(preview).toHaveCount(0);
    await backend.selectOption("openai-compatible"); await expect(preview).toHaveText("wxyz••••••••");
    await panel.getByLabel("Clear saved token").check(); await expect(preview).toHaveCount(0);
    await save.click(); await expect(panel).toContainText("No token saved for this URL.");
    await expect(preview).toHaveCount(0);
    expect((await window.evaluate(() => window.aya.machinesSetup())).machines[0].api?.savedTokenPreview).toBeUndefined();

    await password.fill("short"); await save.click();
    await checkPreview("short", "••••••••");
    await url.fill(`${base}/new`); await save.click();
    await expect(panel).toContainText("No token saved for this URL."); await expect(preview).toHaveCount(0);
    await password.fill("last-fixture-token"); await save.click();
    await checkPreview("last-fixture-token", "last••••••••");
    await backend.selectOption("ollama"); await save.click();
    await expect(preview).toHaveCount(0);
    expect((await window.evaluate(() => window.aya.machinesSetup())).machines[0].api).toBeUndefined();
    await backend.selectOption("openai-compatible"); await url.fill(base);
    await password.fill("remove-fixture-token"); await save.click();
    await checkPreview("remove-fixture-token", "remo••••••••");
    await panel.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(panel.getByRole("combobox", { name: "Backend for darwine" })).toHaveCount(0);
    expect((await window.evaluate(() => window.aya.machinesSetup())).machines).toEqual([]);
    expect(JSON.parse(readFileSync(join(seeded.ayaHome, "machines-auth.json"), "utf8")).entries).toEqual([]);
  } finally { api.closeAllConnections(); await new Promise<void>((r) => api.close(() => r())); }
});

test("LAN transport failure offers macOS Local Network settings once, without changing permissions", async ({ app, window }) => {
  await app.evaluate(({ ipcMain, shell }) => {
    const state = globalThis as typeof globalThis & { repairApiUp?: boolean; repairApiError?: string; repairSettingsUrls?: string[] };
    state.repairApiUp = false;
    state.repairApiError = "API host unreachable";
    state.repairSettingsUrls = [];
    shell.openExternal = async (url: string) => { state.repairSettingsUrls!.push(url); };
    ipcMain.removeHandler("machines:status");
    ipcMain.handle("machines:status", () => ({ version: 1, machines: [{
      id: "darwine", reach: { ssh: "darwine" }, ollama: { port: 11434 }, api: { baseUrl: "http://192.168.0.203:8080/v1" },
      status: { reachable: true, checkedAt: new Date().toISOString(), error: null, cpuName: "CPU", cpus: 8, load1: 0.1,
        memUsedBytes: 1e9, memTotalBytes: 8e9, gpus: [], gpuError: "Failed to initialize NVML: Driver/library version mismatch",
        ollama: { up: false, version: null, loaded: null },
        api: { up: state.repairApiUp, models: state.repairApiUp ? ["qwen3.8-27b"] : null, error: state.repairApiUp ? null : state.repairApiError },
      },
    }] }));
  });
  await window.evaluate(() => window.dispatchEvent(new Event("aya:machines-changed")));
  await window.getByTestId("machines-toggle").click();
  const popover = window.getByRole("dialog", { name: "Machines" });
  await expect(popover.getByText("API host unreachable", { exact: true })).toHaveCount(1);
  const settings = popover.getByRole("button", { name: "Privacy & Security settings" });
  if (await window.evaluate(() => window.aya.platform) === "darwin") {
    await settings.click();
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { repairSettingsUrls?: string[] }).repairSettingsUrls)).toEqual(["x-apple.systempreferences:com.apple.preference.security"]);
    await expect(popover).toContainText("Privacy & Security → Local Network");
  } else await expect(settings).toHaveCount(0);
  await app.evaluate(() => { (globalThis as typeof globalThis & { repairApiError?: string }).repairApiError = "API authentication failed"; });
  await window.evaluate(() => window.dispatchEvent(new Event("aya:machines-changed")));
  await expect(popover.getByText("API authentication failed", { exact: true })).toHaveCount(1);
  await expect(settings).toHaveCount(0);
  await app.evaluate(() => { (globalThis as typeof globalThis & { repairApiUp?: boolean }).repairApiUp = true; });
  await window.evaluate(() => window.dispatchEvent(new Event("aya:machines-changed")));
  await expect(popover).toContainText("qwen3.8-27b · served by API");
  await expect(popover).toContainText("GPU telemetry unavailable");
  await expect(settings).toHaveCount(0);
});

test("Electron API transport sends only bearer auth, forbids redirects and bounds malformed/large/stalled replies", async ({ app, window }) => {
  const token = "transport-fixture-token";
  let mode = "ok";
  let redirects = 0;
  const seen: { authorization?: string; cookie?: string }[] = [];
  const api = createServer((req, res) => {
    if (req.url === "/redirect-target") { redirects++; res.end('{"data":[]}'); return; }
    seen.push({ authorization: req.headers.authorization, cookie: req.headers.cookie });
    if (mode === "redirect") { res.writeHead(302, { location: "/redirect-target" }); res.end(); }
    else if (mode === "401") { res.writeHead(401); res.end(token); }
    else if (mode === "malformed") res.end(token);
    else if (mode === "large") res.end("x".repeat(1_000_001));
    else if (mode === "timeout") { res.writeHead(200); res.write('{"data":'); }
    else res.end('{"data":[{"id":"qwen3.8-27b"}]}');
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  try {
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("no API port");
    const url = `http://127.0.0.1:${address.port}`;
    await app.evaluate(async ({ session }, base) => {
      await session.defaultSession.cookies.set({ url: base, name: "unrelated", value: "fixture-cookie" });
    }, url);
    for (const [next, expected] of [["ok", null], ["redirect", "API returned HTTP 302"], ["401", "API authentication failed"], ["malformed", "API returned an invalid model list"], ["large", "API model list exceeds the size limit"], ["timeout", "API request timed out"]] as const) {
      mode = next;
      const status = await window.evaluate(async ({ url, token }) => {
        await window.aya.machinesConfigure(["configure", "darwine", "openai-compatible", url, "--token-stdin"], token);
        return window.aya.machinesStatus();
      }, { url, token });
      // Chromium rejects a manual redirect without a Response; Node returns the 302. Both must refuse it.
      if (next === "redirect") expect(status.machines[0].status.api?.error).toBeTruthy();
      else expect(status.machines[0].status.api?.error).toBe(expected);
      expect(status.machines[0].status.api?.up).toBe(next === "ok");
      expect(JSON.stringify(status)).not.toContain(token);
    }
    expect(redirects).toBe(0);
    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect(seen.every((req) => req.authorization === `Bearer ${token}` && req.cookie === undefined)).toBe(true);
  } finally { api.closeAllConnections(); await new Promise<void>((r) => api.close(() => r())); }
});

test("the machines popover refreshes when Aya's window regains focus", async ({ window }) => {
  let model = "first-model";
  const api = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ id: model }] }));
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  try {
    const address = api.address();
    if (!address || typeof address === "string") throw new Error("no API port");
    const url = `http://127.0.0.1:${address.port}`;
    await window.evaluate((u) => window.aya.machinesConfigure(["configure", "darwine", "openai-compatible", u]), url);
    await window.getByTestId("machines-toggle").click();
    const popover = window.getByRole("dialog", { name: "Machines" });
    await expect(popover).toContainText("first-model · served by API");
    model = "second-model";
    // The status poll runs every 30 s, so only focus can refresh this soon. Main reuses a probe for 3 s: focus until it shows.
    await expect(async () => {
      await window.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(popover).toContainText("second-model · served by API", { timeout: 500 });
    }).toPass({ timeout: 10_000 });
  } finally { api.closeAllConnections(); await new Promise<void>((r) => api.close(() => r())); }
});
