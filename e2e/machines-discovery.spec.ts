import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, type ElectronApplication } from "@playwright/test";
import { test } from "./fixtures";
import { seedBase, openMachinesSettings } from "./helpers/machines";

test.use({ seedOptions: { ...seedBase, homeFiles: { ".ssh/config": "Host darwine\n" }, ayaHomeFiles: {
  "machines.json": JSON.stringify({ version: 1, machines: [{ id: "darwine", reach: { ssh: "darwine" }, ollama: { port: 11434 } }] }),
} } });

test("real401 discovery fills URL on backend selection with no Find/Use clicks, sends no saved token/cookies, and saves only on click", async ({ app, window, seeded }) => {
  const token = "discovery-fixture-token";
  const seen: { authorization?: string; cookie?: string }[] = [];
  let mode = "401"; let redirected = 0;
  const api = createServer((req, res) => {
    seen.push({ authorization: req.headers.authorization, cookie: req.headers.cookie });
    if (req.url === "/target") { redirected++; res.end('{"data":[]}'); return; }
    if (req.headers.authorization === `Bearer ${token}` || mode === "200") res.end('{"data":[{"id":"fixture-model"}]}');
    else if (mode === "401" || mode === "403") { res.statusCode = +mode; res.end(token); }
    else if (mode === "redirect") { res.writeHead(302, { location: "/target" }); res.end(); }
    else if (mode === "large") res.end("x".repeat(256001));
    else if (mode === "timeout") { res.writeHead(200); res.write('{"data":'); }
    else res.end('{"data":[null]}');
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  try {
    const addr = api.address();
    if (!addr || typeof addr === "string") throw new Error("no fixture port");
    const baseUrl = `http://127.0.0.1:${addr.port}/v1`;
    // Only redirect the fixed port list in this isolated app to the test server; production resolver,
    // registry, preload, IPC and Chromium probe remain in use. Fake SSH answers local -G with loopback.
    await app.evaluate(({ session }, { port, baseUrl }) => {
      const require = process.getBuiltinModule("module").createRequire(`${process.cwd()}/package.json`);
      const discovery = require("./dist-electron/machines-discovery.js");
      discovery.API_DISCOVERY_PORTS.splice(0, discovery.API_DISCOVERY_PORTS.length, port);
      return session.defaultSession.cookies.set({ url: baseUrl, name: "private-cookie", value: "fixture-cookie" });
    }, { port: addr.port, baseUrl });
    const file = join(seeded.ayaHome, "machines.json");
    const before = readFileSync(file, "utf8");
    const panel = await openMachinesSettings(window, app);
    await panel.getByRole("combobox", { name: "Backend for darwine" }).selectOption("openai-compatible");
    const url = panel.getByRole("textbox", { name: "API URL for darwine" });
    await expect(panel).toContainText("Requires authentication · compatibility unconfirmed");
    await expect(url).toHaveValue(baseUrl);
    await expect(panel.getByRole("button", { name: /^Use http:/ })).toHaveCount(0);
    await expect(panel).not.toContainText("Choose an endpoint");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(existsSync(join(seeded.ayaHome, "machines-auth.json"))).toBe(false);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.authorization === undefined && r.cookie === undefined)).toBe(true);
    await panel.getByLabel("Bearer token for darwine").fill(token);
    await panel.getByRole("button", { name: "Save backend" }).click();
    await expect(panel).toContainText("Token saved.");
    expect((await window.evaluate(() => window.aya.machinesSetup())).machines[0].api?.baseUrl).toBe(baseUrl);
    expect(await window.evaluate(() => window.aya.machinesStatus())).toMatchObject({ machines: [{ status: { api: { up: true } } }] });
    await panel.getByRole("combobox", { name: "Backend for darwine" }).selectOption("ollama");
    await panel.getByRole("combobox", { name: "Backend for darwine" }).selectOption("openai-compatible");
    await expect(url).toHaveValue(baseUrl);
    await expect(panel.getByRole("button", { name: /^Use http:/ })).toHaveCount(0);

    for (const next of ["200", "401", "403", "malformed", "redirect", "large", "timeout"]) {
      mode = next; seen.length = 0;
      const result = await window.evaluate(() => window.aya.machinesDiscover("darwine"));
      expect(result.candidates).toEqual(next === "200" ? [{ baseUrl, kind: "confirmed" }] : ["401", "403"].includes(next) ? [{ baseUrl, kind: "auth-required" }] : []);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((r) => r.authorization === undefined && r.cookie === undefined)).toBe(true);
    }
    expect(redirected).toBe(0);
  } finally { api.closeAllConnections(); await new Promise<void>((r) => api.close(() => r())); }
});

type Candidate = { baseUrl: string; kind: "confirmed" | "auth-required" };
type PendingDiscovery = { id: string; resolve: (result: { candidates: Candidate[]; error: string | null }) => void };

async function installDelayedDiscovery(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as typeof globalThis & { discoveries?: PendingDiscovery[] };
    state.discoveries = [];
    ipcMain.removeHandler("machines:discover");
    ipcMain.handle("machines:discover", (_e, id) => new Promise((resolve) => { state.discoveries!.push({ id, resolve }); }));
  });
}
async function resolveDiscovery(app: ElectronApplication, index: number, candidates: Candidate[], error: string | null = null) {
  await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { discoveries?: PendingDiscovery[] }).discoveries!.length)).toBeGreaterThan(index);
  await app.evaluate(async (_app, { index, candidates, error }) => {
    (globalThis as typeof globalThis & { discoveries?: PendingDiscovery[] }).discoveries![index].resolve({ candidates, error });
    await new Promise<void>((r) => setImmediate(r));
  }, { index, candidates, error });
}

test("confirmed discovery fills an untouched empty URL; multiple results require a choice and retry preserves manual input", async ({ app, window, seeded }) => {
  await installDelayedDiscovery(app);
  const before = readFileSync(join(seeded.ayaHome, "machines.json"), "utf8");
  const panel = await openMachinesSettings(window, app);
  await panel.getByRole("combobox", { name: "Backend for darwine" }).selectOption("openai-compatible");
  const url = panel.getByRole("textbox", { name: "API URL for darwine" });
  const first = { baseUrl: "http://fixture:8080/v1", kind: "confirmed" } as const;
  await resolveDiscovery(app, 0, [first]);
  await expect(url).toHaveValue(first.baseUrl);
  await expect(panel.getByRole("button", { name: /^Use http:/ })).toHaveCount(0);
  await expect(panel).not.toContainText("Choose an endpoint");
  expect(readFileSync(join(seeded.ayaHome, "machines.json"), "utf8")).toBe(before);
  await url.fill("");
  await panel.getByRole("button", { name: "Search again", exact: true }).click();
  const second = { baseUrl: "http://fixture:8000/v1", kind: "confirmed" } as const;
  await resolveDiscovery(app, 1, [first, second]);
  await expect(panel.getByRole("button", { name: /^Use http:/ })).toHaveCount(2);
  await expect(url).toHaveValue("");
  await panel.getByRole("button", { name: `Use ${second.baseUrl}` }).click();
  await expect(url).toHaveValue(second.baseUrl);
  await url.fill("http://manual:9000/v1");
  await panel.getByRole("button", { name: "Search again", exact: true }).click();
  await resolveDiscovery(app, 2, [first]);
  await expect(panel).toContainText("Choose an endpoint below");
  await expect(url).toHaveValue("http://manual:9000/v1");
  await panel.getByRole("button", { name: "Search again", exact: true }).click();
  await resolveDiscovery(app, 3, [], "Could not resolve this SSH host. Enter the API URL manually.");
  await expect(panel).toContainText("Could not resolve this SSH host");
  await expect(url).toHaveValue("http://manual:9000/v1");
  await expect(panel.getByRole("button", { name: "Search again", exact: true })).toBeEnabled();
});

test("late results respect token/clear edits, manual URL, backend changes and unmount", async ({ app, window }) => {
  await installDelayedDiscovery(app);
  let panel = await openMachinesSettings(window, app);
  let backend = panel.getByRole("combobox", { name: "Backend for darwine" });
  await backend.selectOption("openai-compatible");
  let url = panel.getByRole("textbox", { name: "API URL for darwine" });
  const token = panel.getByLabel("Bearer token for darwine");
  const first = { baseUrl: "http://old:8080/v1", kind: "confirmed" } as const;
  await token.fill("newly-typed-fixture-token");
  await resolveDiscovery(app, 0, [first]);
  await expect(panel).toContainText("Choose an endpoint below");
  await expect(url).toHaveValue(""); await expect(token).toHaveValue("newly-typed-fixture-token");
  await panel.getByRole("button", { name: `Use ${first.baseUrl}` }).click();
  await expect(token).toHaveValue("");
  await panel.getByRole("button", { name: "Search again", exact: true }).click();
  await url.fill("http://manual:9000/v1");
  await resolveDiscovery(app, 1, [first]);
  await expect(url).toHaveValue("http://manual:9000/v1");
  await expect(panel.getByRole("button", { name: /^Use http:/ })).toHaveCount(0);

  await url.fill("");
  await backend.selectOption("ollama"); await backend.selectOption("openai-compatible");
  await panel.getByLabel("Clear saved token").check();
  await resolveDiscovery(app, 2, [first]);
  await expect(url).toHaveValue(""); await expect(panel.getByLabel("Clear saved token")).toBeChecked();
  await panel.getByRole("button", { name: "Search again", exact: true }).click();
  await backend.selectOption("ollama"); await backend.selectOption("openai-compatible");
  const newer = { baseUrl: "http://new:8080/v1", kind: "confirmed" } as const;
  await resolveDiscovery(app, 4, [newer]);
  await expect(url).toHaveValue(newer.baseUrl);
  await resolveDiscovery(app, 3, [first]);
  await expect(url).toHaveValue(newer.baseUrl);
  await expect(panel.getByRole("button", { name: `Use ${first.baseUrl}` })).toHaveCount(0);

  await panel.getByRole("button", { name: "Search again", exact: true }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { discoveries?: PendingDiscovery[] }).discoveries!.length)).toBe(6);
  await window.keyboard.press("Escape");
  panel = await openMachinesSettings(window, app);
  backend = panel.getByRole("combobox", { name: "Backend for darwine" });
  await backend.selectOption("openai-compatible");
  url = panel.getByRole("textbox", { name: "API URL for darwine" });
  await resolveDiscovery(app, 5, [first]);
  await resolveDiscovery(app, 6, [newer]);
  await expect(url).toHaveValue(newer.baseUrl);
  await expect(panel.getByRole("button", { name: `Use ${first.baseUrl}` })).toHaveCount(0);
});

test("a removed machine's late discovery cannot fill its replacement's editor", async ({ app, window }) => {
  await installDelayedDiscovery(app);
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as typeof globalThis & { discoveryReplacement?: boolean };
    state.discoveryReplacement = false;
    ipcMain.removeHandler("machines:setup");
    ipcMain.handle("machines:setup", () => ({ machines: [{ id: state.discoveryReplacement ? "other" : "darwine", reach: { ssh: "darwine" }, ollama: { port: 11434 } }], hosts: [] }));
    ipcMain.removeHandler("machines:command");
    ipcMain.handle("machines:command", () => { state.discoveryReplacement = true; return "removed darwine"; });
  });
  const panel = await openMachinesSettings(window, app);
  await panel.getByRole("combobox", { name: "Backend for darwine" }).selectOption("openai-compatible");
  await expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { discoveries?: PendingDiscovery[] }).discoveries!.length)).toBe(1);
  await panel.getByRole("button", { name: "Remove", exact: true }).click();
  await panel.getByRole("combobox", { name: "Backend for other" }).selectOption("openai-compatible");
  const url = panel.getByRole("textbox", { name: "API URL for other" });
  const newer = { baseUrl: "http://new-machine:8080/v1", kind: "confirmed" } as const;
  await resolveDiscovery(app, 1, [newer]);
  await expect(url).toHaveValue(newer.baseUrl);
  await resolveDiscovery(app, 0, [{ baseUrl: "http://removed-machine:8080/v1", kind: "confirmed" }]);
  await expect(url).toHaveValue(newer.baseUrl);
  expect(await app.evaluate(() => (globalThis as typeof globalThis & { discoveries?: PendingDiscovery[] }).discoveries!.map((d) => d.id))).toEqual(["darwine", "other"]);
  await expect(panel.getByRole("button", { name: "Use http://removed-machine:8080/v1" })).toHaveCount(0);
});
