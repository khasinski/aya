import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeApiUrl, probeApi } from "../dist-electron/machines-api.js";
import { machineToken, savedTokenPreview, MACHINES_AUTH_FILE } from "../dist-electron/machines-auth.js";
import { loadRegistry, machinesSetup, machinesUiSetup, machinesStatus, machineStatus, handleMachinesRequest, formatMachines, clearMachineStatusCache } from "../dist-electron/machines.js";
import { startControlServerOn } from "../dist-electron/control.js";
import { health, modelLines } from "../dist-test/machines-view.js";
import { probeScript } from "../dist-electron/machines-probe.js";
import { configureDialogText } from "../dist-electron/machines-dialog.js";

// The CJS fs that dist-electron/atomic-write.js calls, so one rename can be made to fail.
const fsCjs = createRequire(import.meta.url)("node:fs");

const TOKEN = "fixture-private-token";
const NOW = new Date("2026-10-12T12:00:00Z");
const hardware = () => ({ reachable: true, checkedAt: NOW.toISOString(), error: null, cpuName: "CPU", cpus: 8, load1: 1, memUsedBytes: 1e9, memTotalBytes: 8e9, gpus: [], gpuError: "Failed to initialize NVML: Driver/library version mismatch", ollama: { up: false, version: null, loaded: null, modelsError: "not probed", installed: null, running: null } });

async function server(t, handler) {
  const http = createServer(handler);
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  t.after(() => { http.closeAllConnections(); http.close(); });
  return `http://127.0.0.1:${http.address().port}`;
}

function registry(t) {
  clearMachineStatusCache();
  const root = mkdtempSync(join(tmpdir(), "aya-api-"));
  t.after(() => { clearMachineStatusCache(); rmSync(root, { recursive: true, force: true }); });
  const deps = { ayaHome: join(root, "aya"), userHome: join(root, "home"), now: () => NOW, probe: async (_reach, _port, options) => { assert.equal(options.hardwareOnly, true); return hardware(); }, confirmRemove: async () => true, confirmConfigure: async () => true };
  mkdirSync(deps.ayaHome); mkdirSync(deps.userHome);
  const file = join(deps.ayaHome, "machines.json");
  const old = { version: 1, machines: [{ id: "darwine", reach: { ssh: "darwine" }, ollama: { port: 11435 } }] };
  writeFileSync(file, JSON.stringify(old));
  const configure = (url, token = TOKEN) => handleMachinesRequest({ argv: ["configure", "darwine", "openai-compatible", url, ...(token === undefined ? [] : ["--token-stdin"])], ...(token === undefined ? {} : { token }) }, deps);
  return { root, deps, file, old, configure };
}

test("API URL accepts root or /v1 and rejects embedded auth, query and fragment without reflecting them", () => {
  assert.equal(normalizeApiUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080/v1");
  assert.equal(normalizeApiUrl("http://127.0.0.1:8080/v1/"), "http://127.0.0.1:8080/v1");
  for (const url of [`http://u:${TOKEN}@host`, `http://host?token=${TOKEN}`, `http://host#${TOKEN}`, "file:///secret", "http://host/\n"]) {
    assert.throws(() => normalizeApiUrl(url), (err) => !err.message.includes(TOKEN));
  }
});

test("saved token preview shows four characters and a fixed mask; short tokens are entirely masked", () => {
  for (const token of ["a", "abcd", "abcdefg", "🔑🔑🔑🔑", "🔑abcde"]) assert.equal(savedTokenPreview(token), "••••••••");
  for (const token of ["abcdefgh", "abcd" + "x".repeat(200), "🔑🔒żółwxy"]) {
    assert.equal(savedTokenPreview(token), Array.from(token).slice(0, 4).join("") + "••••••••");
    assert.ok(!savedTokenPreview(token).includes(token));
  }
});

test("only UI setup gets a masked prefix; same-URL replace updates it, change/clear/switch/remove drop it", async (t) => {
  const { deps, file, configure } = registry(t);
  const url = "http://host:8080/v1";
  const preview = async () => (await machinesUiSetup(deps)).machines[0]?.api?.savedTokenPreview;
  const config = (...argv) => handleMachinesRequest({ argv: ["configure", "darwine", ...argv] }, deps);
  await configure("http://host:8080/", "abcd-first-private-key");
  assert.equal(await preview(), "abcd••••••••");
  await config("openai-compatible", "http://host:8080/v1/");
  assert.equal(await preview(), "abcd••••••••");
  await configure(url, "wxyz-second-private-key");
  assert.equal(await preview(), "wxyz••••••••");
  assert.ok(!JSON.stringify(await machinesUiSetup(deps)).includes("wxyz-second-private-key"));
  const publicSetup = await machinesSetup(deps);
  assert.equal(publicSetup.machines[0].api.tokenConfigured, true);
  assert.equal(publicSetup.machines[0].api.savedTokenPreview, undefined);
  assert.ok(!JSON.stringify(publicSetup).includes("wxyz"));
  assert.ok(!readFileSync(file, "utf8").includes("savedTokenPreview"));
  assert.ok(!readFileSync(file, "utf8").includes("wxyz"));
  await configure(url, "short");
  assert.equal(await preview(), "••••••••");
  await config("openai-compatible", "http://host:8081");
  assert.equal(await preview(), undefined);
  await configure(url);
  await config("openai-compatible", url, "--clear-token");
  assert.equal(await preview(), undefined);
  await configure(url);
  await config("ollama", "11434");
  assert.equal(await preview(), undefined);
  await configure(url);
  await handleMachinesRequest({ argv: ["remove", "darwine"] }, deps);
  assert.deepEqual((await machinesUiSetup(deps)).machines, []);
});

test("API hardware probes do not contact Ollama or inspect its installation", () => {
  const script = probeScript(11434, true);
  assert.ok(!/curl|ollama|@@version|@@ps/.test(script));
  assert.match(script, /nvidia-smi/);
  assert.match(script, /@@end/);
});

test("GET /v1/models sends auth in headers and reports served IDs only", async (t) => {
  const base = await server(t, (req, res) => {
    assert.equal(req.method, "GET"); assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    res.end(JSON.stringify({ data: [{ id: "qwen3.8-27b", owned_by: "ninfer" }, { id: "qwen3.8-27b" }] }));
  });
  assert.deepEqual(await probeApi(base, TOKEN), { up: true, models: ["qwen3.8-27b"], error: null });
});

for (const [name, code, body, error] of [
  ["401", 401, TOKEN, "API authentication failed"], ["403", 403, TOKEN, "API authentication failed"],
  ["500", 500, TOKEN, "API returned HTTP 500"],
  ["malformed JSON", 200, "bad", "API returned an invalid model list"],
  ["wrong schema", 200, '{"data":[null]}', "API returned an invalid model list"],
  ["reflected token", 200, JSON.stringify({ data: [{ id: TOKEN }] }), "API returned an invalid model list"],
]) test(`API ${name} is sanitized`, async (t) => {
  const base = await server(t, (_req, res) => { res.statusCode = code; res.end(body); });
  const state = await probeApi(base, TOKEN);
  assert.deepEqual(state, { up: false, models: null, error });
  assert.ok(!JSON.stringify(state).includes(TOKEN));
});

test("an empty model list is an available API serving no models, in the CLI and the status view", async (t) => {
  const base = await server(t, (_req, res) => res.end('{"data":[]}'));
  const api = await probeApi(base, TOKEN);
  assert.deepEqual(api, { up: true, models: [], error: null });
  const status = { ...hardware(), api };
  const view = { id: "darwine", reach: { ssh: "darwine" }, ollama: { port: 11434 }, api: { baseUrl: normalizeApiUrl(base) }, status };
  const text = formatMachines([view], NOW);
  assert.match(text, /API available \(OpenAI-compatible\)\n\s+No models served by API\n/);
  assert.deepEqual(modelLines(status, NOW), ["No models served by API"]);
});

test("API timeout covers a stalled response body", async (t) => {
  const base = await server(t, (_req, res) => { res.writeHead(200); res.write('{"data":'); });
  assert.equal((await probeApi(base, TOKEN, { timeoutMs: 40 })).error, "API request timed out");
});

test("API response size is bounded", async (t) => {
  const base = await server(t, (_req, res) => res.end("x".repeat(2048)));
  assert.equal((await probeApi(base, TOKEN, { maxBytes: 100 })).error, "API model list exceeds the size limit");
});

test("API redirects are never followed with the token", async (t) => {
  let redirects = 0;
  const target = await server(t, (_req, res) => { redirects++; res.end('{"data":[]}'); });
  const base = await server(t, (_req, res) => { res.writeHead(302, { location: `${target}/v1/models` }); res.end(); });
  assert.equal((await probeApi(base, TOKEN)).error, "API returned HTTP 302");
  assert.equal(redirects, 0);
});

test("network failures expose only known, actionable codes without reflecting exception text", async () => {
  const original = globalThis.fetch;
  try {
    for (const [code, expected] of [["EHOSTUNREACH", "API host unreachable"], ["ENETUNREACH", "API host unreachable"], ["EACCES", "API network access denied"], ["EPERM", "API network access denied"], ["OTHER", "API not answering"]]) {
      for (const nested of [false, true]) {
        globalThis.fetch = async () => { throw Object.assign(new Error(TOKEN), nested ? { cause: { code, message: TOKEN } } : { code }); };
        const state = await probeApi("http://host", TOKEN);
        assert.equal(state.error, expected);
        assert.ok(!JSON.stringify(state).includes(TOKEN));
      }
    }
    for (const [message, expected] of [["net::ERR_ADDRESS_UNREACHABLE", "API host unreachable"], ["net::ERR_NETWORK_ACCESS_DENIED", "API network access denied"], ["net::ERR_ACCESS_DENIED", "API network access denied"], [`net::ERR_NETWORK_ACCESS_DENIED ${TOKEN}`, "API not answering"]]) {
      globalThis.fetch = async () => { throw new Error(message); };
      const state = await probeApi("http://host", TOKEN);
      assert.equal(state.error, expected);
      assert.ok(!JSON.stringify(state).includes(TOKEN));
    }
  } finally { globalThis.fetch = original; }
});

test("version 1 upgrades in place, secrets are private, GPU warnings never hide a working API", async (t) => {
  const base = await server(t, (_req, res) => res.end('{"data":[{"id":"qwen3.8-27b"}]}'));
  const { deps, file, old, configure } = registry(t);
  assert.deepEqual(await loadRegistry(deps), old);
  const reply = await configure(base);
  const auth = join(deps.ayaHome, MACHINES_AUTH_FILE);
  assert.equal(statSync(auth).mode & 0o777, 0o600);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(readFileSync(auth, "utf8").includes(TOKEN));
  assert.ok(!readFileSync(file, "utf8").includes(TOKEN));
  const setup = await machinesSetup(deps);
  assert.equal(setup.machines[0].api.tokenConfigured, true);
  const uiSetup = await machinesUiSetup(deps);
  assert.equal(uiSetup.machines[0].api.savedTokenPreview, "fixt••••••••");
  const status = await machinesStatus(deps);
  const s = status.machines[0].status;
  assert.equal(health(s).level, "ok");
  assert.deepEqual(modelLines(s, NOW), ["qwen3.8-27b · served by API"]);
  const text = formatMachines(status.machines, NOW);
  assert.match(text, /API available/); assert.match(text, /qwen3\.8-27b \(served by API\)/);
  assert.match(text, /GPU telemetry unavailable.*Driver\/library version mismatch/);
  assert.ok(!text.includes("hot until"));
  for (const publicValue of [reply, setup, uiSetup, status, text]) assert.ok(!JSON.stringify(publicValue).includes(TOKEN));
  for (const publicValue of [reply, setup, status, text]) assert.ok(!JSON.stringify(publicValue).includes("savedTokenPreview"));
});

test("API remains visible when SSH telemetry is unavailable", async (t) => {
  const base = await server(t, (_req, res) => res.end('{"data":[{"id":"qwen"}]}'));
  const { deps, configure } = registry(t);
  deps.probe = async () => ({ ...hardware(), reachable: false, gpuError: null, error: "SSH unavailable" });
  await configure(base);
  const status = await machinesStatus(deps);
  assert.equal(health(status.machines[0].status).level, "ok");
  assert.match(formatMachines(status.machines, NOW), /unreachable.*SSH unavailable/);
  assert.match(formatMachines(status.machines, NOW), /qwen \(served by API\)/);
});

test("tokens are kept only for the same URL; changing URL, clearing, switching and removing discard them", async (t) => {
  const { deps, configure } = registry(t);
  await configure("http://host:8080");
  const config = (...argv) => handleMachinesRequest({ argv: ["configure", "darwine", ...argv] }, deps);
  await config("openai-compatible", "http://host:8080/v1/");
  assert.equal(await machineToken(deps.ayaHome, "darwine", "http://host:8080/v1"), TOKEN);
  await config("openai-compatible", "http://host:8081");
  assert.equal(await machineToken(deps.ayaHome, "darwine", "http://host:8081/v1"), null);
  await configure("http://host:8080");
  await config("openai-compatible", "http://host:8080", "--clear-token");
  assert.equal((await machinesSetup(deps)).machines[0].api.tokenConfigured, false);
  await configure("http://host:8080");
  await config("ollama", "11436");
  assert.equal((await loadRegistry(deps)).machines[0].api, undefined);
  assert.equal((await loadRegistry(deps)).machines[0].ollama.port, 11436);
  assert.equal(await machineToken(deps.ayaHome, "darwine", "http://host:8080/v1"), null);
  await configure("http://host:8080");
  await handleMachinesRequest({ argv: ["remove", "darwine"] }, deps);
  assert.equal(await machineToken(deps.ayaHome, "darwine", "http://host:8080/v1"), null);
});

test("unexpected disk fields are never returned by setup or status", async (t) => {
  const { deps, file, old } = registry(t);
  old.machines[0].token = TOKEN;
  old.machines[0].ollama.token = TOKEN;
  old.machines[0].api = { baseUrl: "http://host/v1", token: TOKEN };
  old.machines[0].api.savedTokenPreview = TOKEN;
  writeFileSync(file, JSON.stringify(old));
  assert.ok(!JSON.stringify(await machinesSetup(deps)).includes(TOKEN));
  assert.ok(!JSON.stringify(await machinesUiSetup(deps)).includes(TOKEN));
});

test("an old probe cannot overwrite fresh status after configure invalidates the cache", async (t) => {
  let oldRequested;
  const oldRequest = new Promise((r) => { oldRequested = r; });
  const base = await server(t, (req, res) => { res.statusCode = req.headers.authorization ? 200 : 401; res.end(req.headers.authorization ? '{"data":[{"id":"qwen"}]}' : TOKEN); if (!req.headers.authorization) oldRequested(); });
  const { deps } = registry(t);
  await handleMachinesRequest({ argv: ["configure", "darwine", "openai-compatible", base] }, deps);
  const machine = (await loadRegistry(deps)).machines[0];
  let finishOld;
  const oldStarted = new Promise((r) => { finishOld = r; });
  deps.probe = async () => { await oldStarted; return hardware(); };
  const old = machineStatus(machine, deps);
  // Allow the old unauthenticated API request to complete while its hardware probe is held.
  await oldRequest;
  await handleMachinesRequest({ argv: ["configure", "darwine", "openai-compatible", base, "--token-stdin"], token: TOKEN }, deps);
  deps.probe = async () => hardware();
  assert.equal((await machineStatus(machine, deps)).api.up, true);
  finishOld();
  assert.equal((await old).api.up, false);
  assert.equal((await machineStatus(machine, deps)).api.up, true);
});

test("a permissive credentials file is rejected with a sanitized error, never exposed or overwritten", async (t) => {
  const { deps, configure } = registry(t);
  const auth = join(deps.ayaHome, MACHINES_AUTH_FILE);
  const contents = JSON.stringify({ version: 1, entries: [{ id: "darwine", baseUrl: "http://host/v1", token: TOKEN }] });
  writeFileSync(auth, contents, { mode: 0o644 });
  // umask can drop group/other bits from the create mode; set the mode explicitly.
  chmodSync(auth, 0o644);
  await assert.rejects(configure("http://host"), (err) => /credentials could not be read/.test(err.message) && !err.message.includes(TOKEN));
  assert.equal(readFileSync(auth, "utf8"), contents);
});

test("CLI reads the token from stdin, never argv or replies; public JSON stays redacted", async (t) => {
  const { deps, root } = registry(t);
  const base = await server(t, (_req, res) => res.end('{"data":[{"id":"qwen"}]}'));
  const socket = join(root, "control.sock");
  const observed = [];
  const stop = startControlServerOn(socket, { getWindow: () => null, openProject: () => {}, machines: deps, onRequest: (request) => observed.push(request) });
  t.after(stop);
  const cli = (args, input = "") => new Promise((resolveResult, reject) => {
    const child = spawn(resolve("bin/aya"), ["machines", ...args], { env: { ...process.env, AYA_SOCKET: socket } });
    assert.ok(!child.spawnargs.join(" ").includes(TOKEN));
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => stdout += c); child.stderr.on("data", (c) => stderr += c);
    child.on("error", reject); child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(input);
  });
  const configured = await cli(["configure", "darwine", "openai-compatible", base, "--token-stdin"], TOKEN + "\n");
  assert.equal(configured.code, 0, configured.stderr);
  assert.equal(await machineToken(deps.ayaHome, "darwine", normalizeApiUrl(base)), TOKEN);
  const status = await cli(["--json"]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).machines[0].status.api.up, true);
  for (const result of [configured, status]) assert.ok(!JSON.stringify(result).includes(TOKEN));
  assert.ok(!JSON.stringify(observed).includes(TOKEN), "measurement hooks never receive the credential");
  const bad = await cli(["configure", "darwine", "openai-compatible", base, "--token-stdin"], TOKEN + "\nextra\n");
  assert.notEqual(bad.code, 0); assert.ok(!JSON.stringify(bad).includes(TOKEN));
});

test("configure asks in Aya with the URL and what happens to the token; Cancel changes nothing", async (t) => {
  const { deps, file, configure } = registry(t);
  const url = "http://host:8080/v1";
  await configure(url);
  const before = readFileSync(file, "utf8");
  const asks = [];
  let answer = false;
  deps.confirmConfigure = async (ask) => { asks.push(ask); return answer; };
  const config = (...argv) => handleMachinesRequest({ argv: ["configure", "darwine", ...argv] }, deps, "lead");

  assert.equal((await config("ollama", "11434")).output, "Not configured: cancelled in Aya.\n");
  assert.equal(readFileSync(file, "utf8"), before, "Cancel leaves machines.json as it was");
  assert.equal(await machineToken(deps.ayaHome, "darwine", url), TOKEN, "Cancel keeps the saved token");

  await config("openai-compatible", "http://host:8080/");
  await config("openai-compatible", "http://other:8080");
  await config("openai-compatible", url, "--clear-token");
  await handleMachinesRequest({ argv: ["configure", "darwine", "openai-compatible", url, "--token-stdin"], token: "new-private-token" }, deps, "lead");
  assert.deepEqual(asks, [
    { id: "darwine", backend: "ollama", target: "11434", token: "removed", pane: "lead" },
    { id: "darwine", backend: "openai-compatible", target: url, token: "kept", pane: "lead" },
    { id: "darwine", backend: "openai-compatible", target: "http://other:8080/v1", token: "removed", pane: "lead" },
    { id: "darwine", backend: "openai-compatible", target: url, token: "removed", pane: "lead" },
    { id: "darwine", backend: "openai-compatible", target: url, token: "stored", pane: "lead" },
  ]);
  assert.equal(readFileSync(file, "utf8"), before, "nothing was saved while every answer was Cancel");
  assert.ok(!JSON.stringify(asks).includes(TOKEN) && !JSON.stringify(asks).includes("new-private-token"), "the dialog never sees a token");

  answer = true;
  assert.equal((await config("ollama", "11434")).output, "darwine configured: Ollama port 11434\n");
  assert.equal(asks.at(-1).token, "removed");
  assert.equal((await loadRegistry(deps)).machines[0].api, undefined);
  assert.equal(await machineToken(deps.ayaHome, "darwine", url), null);
  await config("openai-compatible", url);
  assert.equal(asks.at(-1).token, "none", "a machine without a token loses nothing");
});

test("the configure dialog names the change and the token's fate, and shows outside text as text", () => {
  const api = configureDialogText({ id: "darwine", backend: "openai-compatible", target: "http://host:8080/v1", token: "removed", pane: "lead\u001b[31m" });
  assert.equal(api.message, "Change darwine to an OpenAI-compatible API?");
  assert.match(api.detail, /^Asked by pane "lead\\u001b\[31m"\. API URL: http:\/\/host:8080\/v1\n\nThe saved API token is deleted; it cannot be recovered\.\n\nAya only reads/);
  assert.ok(!api.detail.includes("\u001b"), "an escape from the pane's name is shown, not run");
  const bare = configureDialogText({ id: "darwine", backend: "openai-compatible", target: "http://host:8080/v1", token: "none" });
  assert.equal(bare.detail, "API URL: http://host:8080/v1\n\nNo API token is saved for this URL.\n\nAya only reads its state and model list; nothing changes on the machine.");
  const ollama = configureDialogText({ id: "darwine", backend: "ollama", target: "11434", token: "none" });
  assert.equal(ollama.message, "Change darwine to Ollama on port 11434?");
  assert.equal(ollama.detail, "Aya only reads its state and model list; nothing changes on the machine.");
});

test("configure without Aya's dialog, or on a machine changed while Aya asked, changes nothing", async (t) => {
  const { deps, file, configure } = registry(t);
  await configure("http://host:8080");
  const before = readFileSync(file, "utf8");
  delete deps.confirmConfigure;
  await assert.rejects(handleMachinesRequest({ argv: ["configure", "darwine", "ollama"] }, deps), /needs the user's yes in Aya/);
  assert.equal(readFileSync(file, "utf8"), before, "no dialog: machines.json unchanged");
  assert.equal(await machineToken(deps.ayaHome, "darwine", "http://host:8080/v1"), TOKEN, "no dialog: the token stays");
  deps.confirmConfigure = async () => {
    // Settings switches the machine to another URL while the pane's question is open.
    const changed = JSON.parse(readFileSync(file, "utf8"));
    changed.machines[0].api.baseUrl = "http://elsewhere:8080/v1";
    writeFileSync(file, JSON.stringify(changed));
    return true;
  };
  await assert.rejects(handleMachinesRequest({ argv: ["configure", "darwine", "ollama"] }, deps), /changed while Aya asked; nothing was changed/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).machines[0].api.baseUrl, "http://elsewhere:8080/v1");
  assert.equal(await machineToken(deps.ayaHome, "darwine", "http://host:8080/v1"), TOKEN);
  writeFileSync(file, before);
});

test("a failed machines.json write keeps the saved token, for configure and for remove", async (t) => {
  const { deps, file, configure } = registry(t);
  const url = "http://host:8080/v1";
  await configure(url);
  const before = readFileSync(file, "utf8");
  const rename = fsCjs.promises.rename;
  t.mock.method(fsCjs.promises, "rename", async (from, to) => {
    if (to === file) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    return rename(from, to);
  });
  for (const argv of [["configure", "darwine", "ollama"], ["configure", "darwine", "openai-compatible", "http://other:8080"], ["remove", "darwine"]]) {
    await assert.rejects(handleMachinesRequest({ argv }, deps), /ENOSPC/, argv.join(" "));
    assert.equal(readFileSync(file, "utf8"), before, `${argv.join(" ")}: machines.json unchanged`);
    assert.equal(await machineToken(deps.ayaHome, "darwine", url), TOKEN, `${argv.join(" ")}: the token stays with the unchanged machine`);
  }
});

test("a credentials file that cannot be updated after the registry is saved is reported, not hidden", async (t) => {
  const { deps, configure } = registry(t);
  const url = "http://host:8080/v1";
  await configure(url);
  const auth = join(deps.ayaHome, MACHINES_AUTH_FILE);
  const rename = fsCjs.promises.rename;
  let failAuth = true;
  t.mock.method(fsCjs.promises, "rename", async (from, to) => {
    if (failAuth && to === auth) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    return rename(from, to);
  });
  await assert.rejects(handleMachinesRequest({ argv: ["configure", "darwine", "ollama"] }, deps), (err) => err.message === "darwine now uses Ollama port 11434, but its API token could not be updated; configure it again");
  assert.equal((await loadRegistry(deps)).machines[0].ollama.port, 11434, "the registry change itself was saved");
  failAuth = false;
  await configure(url);
  failAuth = true;
  await assert.rejects(handleMachinesRequest({ argv: ["remove", "darwine"] }, deps), (err) => err.message === `removed darwine, but its saved API token could not be deleted from ${MACHINES_AUTH_FILE}`);
});

test("a token saved in Settings while a pane's question is open is not deleted by that answer", async (t) => {
  const { deps, file } = registry(t);
  const url = "http://host:8080/v1";
  await handleMachinesRequest({ argv: ["configure", "darwine", "openai-compatible", url] }, deps);
  assert.equal(await machineToken(deps.ayaHome, "darwine", url), null);
  const asks = [];
  deps.confirmConfigure = async (ask) => {
    asks.push(ask);
    // Meanwhile the user saves a token for the same URL in Settings (its click is the yes).
    await handleMachinesRequest({ argv: ["configure", "darwine", "openai-compatible", url, "--token-stdin"], token: "late-private-token" }, { ...deps, confirmConfigure: async () => true });
    return true;
  };
  await assert.rejects(handleMachinesRequest({ argv: ["configure", "darwine", "ollama"] }, deps, "lead"), /changed while Aya asked; nothing was changed/);
  assert.equal(asks[0].token, "none", "the pane's question said there was no token to lose");
  assert.equal(await machineToken(deps.ayaHome, "darwine", url), "late-private-token");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).machines[0].api.baseUrl, url);
});

test("a token left for an earlier URL is not revived by configuring that URL again", async (t) => {
  const { deps, file, configure } = registry(t);
  const a = "http://host-a:8080/v1";
  await configure("http://host-b:8080");
  // What a failed credentials write after a URL change leaves: the registry on B, a token still stored for A.
  writeFileSync(join(deps.ayaHome, MACHINES_AUTH_FILE), JSON.stringify({ version: 1, entries: [{ id: "darwine", baseUrl: a, token: TOKEN }] }), { mode: 0o600 });
  const asks = [];
  deps.confirmConfigure = async (ask) => { asks.push(ask); return true; };
  await handleMachinesRequest({ argv: ["configure", "darwine", "openai-compatible", a] }, deps);
  assert.equal(asks[0].token, "none");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).machines[0].api.baseUrl, a);
  assert.equal(await machineToken(deps.ayaHome, "darwine", a), null, "the user was told no token: none is sent to A");
});
