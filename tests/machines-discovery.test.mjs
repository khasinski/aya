import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { discoverApiEndpoints, resolveDiscoveryHost, discoveryHostname, API_DISCOVERY_PORTS } from "../dist-electron/machines-discovery.js";
import { machinesDiscover } from "../dist-electron/machines.js";
import { probeApi } from "../dist-electron/machines-api.js";
import { runProcess } from "../dist-electron/ssh.js";

function fixture(t) {
  const cache = resolve("node_modules/.cache"); mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(join(cache, "discovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("discovery host validation accepts DNS/IPv4/IPv6 and rejects URL injection and malformed addresses", () => {
  for (const host of ["192.168.0.203", "darwine", "box.lan", "Box.example.", "::1", "fd00::1"]) assert.equal(discoveryHostname(host), host);
  assert.equal(discoveryHostname("[fd00::1]"), "fd00::1");
  for (const host of ["", "-host", "1.2.3.999", "http://host", "user@host", "host:8080", "host/path", "host?x", "host#x", "host%20", "host\n", "foo..bar", "a".repeat(64), "foo_ssh"]) assert.equal(discoveryHostname(host), null, host);
});

test("SSH resolver uses local -G, hardened options, bounded output and a disabled Match exec shell", async () => {
  const host = await resolveDiscoveryHost("me@darwine", async (command, args, options) => {
    assert.equal(command, "ssh"); assert.deepEqual(args.slice(-3), ["-G", "--", "me@darwine"]);
    for (const option of ["ClearAllForwardings=yes", "PermitLocalCommand=no", "ControlMaster=no", "ProxyCommand=none", "ProxyJump=none", "CanonicalizeHostname=no"]) assert.ok(args.includes(option));
    assert.equal(options.deadlineMs, 1500); assert.equal(options.maxOutputBytes, 20000);
    assert.equal(options.env.SHELL, "/usr/bin/false");
    return { code: 0, timedOut: false, spawnError: null, stdout: "hostname 192.168.0.203\nidentityfile private-path\n", stderr: "private error" };
  });
  assert.equal(host, "192.168.0.203");
  await assert.rejects(resolveDiscoveryHost("-oProxyCommand=evil"));
});

test("SSH resolver rejects failed, timed out, duplicated, invalid or truncated output", async () => {
  for (const patch of [{ code: 1 }, { timedOut: true }, { spawnError: "secret" }, { stdout: "hostname x\nhostname y\n" }, { stdout: "hostname http://host\n" }, { stdout: "hostname foo\n" + "x".repeat(20000) }, { stdout: "no host" }]) {
    assert.equal(await resolveDiscoveryHost("darwine", async () => ({ code: 0, timedOut: false, spawnError: null, stdout: "hostname box\n", stderr: "secret", ...patch })), null);
  }
});

test("real SSH resolves fixture HostName/Include and does not execute Match exec or proxy/local commands", async (t) => {
  if (process.platform === "win32") return t.skip("Unix SSH resolver");
  const root = fixture(t);
  const marker = join(root, "should-not-exist");
  writeFileSync(join(root, "included"), "Host darwine\n  HostName 192.168.0.203\n");
  const file = join(root, "config");
  writeFileSync(file, `Include ${join(root, "included")}\nMatch exec "touch ${marker}"\n  HostName 192.0.2.99\nHost *\n  ProxyCommand touch ${marker}\n  LocalCommand touch ${marker}\n  PermitLocalCommand yes\n`);
  const host = await resolveDiscoveryHost("darwine", (command, args, options) => runProcess(command, ["-F", file, ...args], options));
  assert.equal(host, "192.168.0.203"); assert.equal(existsSync(marker), false);
});

test("discovery probes exactly one resolved host and four ports with no token; auth is only a candidate", async () => {
  const seen = [];
  const result = await discoverApiEndpoints({ ssh: "darwine" }, {
    resolveHost: async (target) => { assert.equal(target, "darwine"); return "192.168.0.203"; },
    probe: async (url, token, options) => {
      seen.push(url); assert.equal(token, null); assert.deepEqual(options, { timeoutMs: 1500, maxBytes: 256000 });
      const port = +new URL(url).port;
      return port === 8080 ? { up: false, models: null, error: "API authentication failed" } : port === 1234 ? { up: true, models: ["fixture"], error: null } : { up: false, models: null, error: "API returned an invalid model list" };
    },
  });
  assert.deepEqual(seen, API_DISCOVERY_PORTS.map((p) => `http://192.168.0.203:${p}/v1`));
  assert.deepEqual(result, { candidates: [{ baseUrl: "http://192.168.0.203:8080/v1", kind: "auth-required" }, { baseUrl: "http://192.168.0.203:1234/v1", kind: "confirmed" }], error: null });
});

test("local discovery skips SSH; IPv6 endpoints are bracketed; resolver failures reveal no raw errors", async () => {
  for (const [reach, hostname] of [["local", "127.0.0.1"], [{ ssh: "box" }, "[fd00::1]"]]) {
    const result = await discoverApiEndpoints(reach, {
      resolveHost: async () => { assert.notEqual(reach, "local"); return hostname; },
      probe: async (url) => { assert.equal(new URL(url).hostname, hostname); return { up: true, models: [], error: null }; },
    });
    assert.equal(result.candidates.length, 4);
  }
  let probed = false;
  for (const resolveHost of [async () => null, async () => "host/injection", async () => { throw new Error("secret"); }]) {
    const result = await discoverApiEndpoints({ ssh: "box" }, { resolveHost, probe: async () => { probed = true; } });
    assert.equal(result.candidates.length, 0); assert.ok(result.error); assert.ok(!JSON.stringify(result).includes("secret"));
  }
  assert.equal(probed, false);
});

test("network discovery confirms valid200, marks401/403 unconfirmed, ignores malformed/redirect/large/timeout", async (t) => {
  let mode = "200"; let redirected = 0;
  const http = createServer((req, res) => {
    assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.cookie, undefined);
    if (req.url === "/target") { redirected++; res.end('{"data":[]}'); }
    else if (mode === "200") res.end('{"data":[{"id":"fixture-model"}]}');
    else if (mode === "401" || mode === "403") { res.statusCode = +mode; res.end("private body"); }
    else if (mode === "redirect") { res.writeHead(302, { location: "/target" }); res.end(); }
    else if (mode === "large") res.end("x".repeat(256001));
    else if (mode === "timeout") { res.writeHead(200); res.write('{"data":'); }
    else res.end('{"data":[null]}');
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  t.after(() => { http.closeAllConnections(); http.close(); });
  const base = `http://127.0.0.1:${http.address().port}`;
  for (const next of ["200", "401", "403", "malformed", "redirect", "large", "timeout"]) {
    mode = next;
    const result = await discoverApiEndpoints("local", { probe: (url, token, options) => +new URL(url).port === 8080 ? probeApi(base, token, { ...options, timeoutMs: 50 }) : Promise.resolve({ up: false, models: null, error: "API not answering" }) });
    assert.deepEqual(result.candidates, next === "200" ? [{ baseUrl: "http://127.0.0.1:8080/v1", kind: "confirmed" }] : ["401", "403"].includes(next) ? [{ baseUrl: "http://127.0.0.1:8080/v1", kind: "auth-required" }] : []);
    assert.ok(!JSON.stringify(result).includes("private body"));
  }
  assert.equal(redirected, 0);
});

test("IPC entry scans only saved machines and neither reads nor rewrites the auth store", async (t) => {
  const root = fixture(t);
  const deps = { ayaHome: root, userHome: root };
  const registry = JSON.stringify({ version: 1, machines: [{ id: "local", reach: "local", ollama: { port: 11434 }, api: { baseUrl: "http://127.0.0.1:8080/v1" } }] });
  writeFileSync(join(root, "machines.json"), registry);
  // Invalid/private auth must not be read, even if there is an existing API configuration.
  writeFileSync(join(root, "machines-auth.json"), "private-invalid-auth");
  const [a, b] = await Promise.all([machinesDiscover("local", deps), machinesDiscover("local", deps)]);
  assert.deepEqual(a, b); assert.ok(!a.error);
  assert.equal(readFileSync(join(root, "machines.json"), "utf8"), registry);
  assert.equal(readFileSync(join(root, "machines-auth.json"), "utf8"), "private-invalid-auth");
  assert.ok((await machinesDiscover("unknown", deps)).error);
  assert.ok((await machinesDiscover("http://elsewhere", deps)).error);
});
