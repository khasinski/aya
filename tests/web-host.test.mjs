// Aya Web listen address: loopback by default, the old 0.0.0.0 default moved off when nobody chose it, what
// Settings may save, the URLs and addresses Settings shows, and the Host check of a loopback server.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { WebSocket } from "ws";
import { PASSWORD, startTestServer } from "./helpers/web-server.mjs";

const {
  isLoopbackHost,
  normalizeWebConfig,
  normalizeWebHost,
  webCredentials,
  webInterfaceAddresses,
  webServerUrls,
} = await import("../dist-electron/web-config.js");
const { hostHeaderAllowed } = await import("../dist-electron/web-server.js");
const { webHostOptions } = await import("../dist-test/web-host-options.js");

const creds = webCredentials("pw", false);

test("a config saved with the old 0.0.0.0 default moves to loopback while it is off", () => {
  const parsed = normalizeWebConfig({ ...creds, enabled: false, host: "0.0.0.0" });
  assert.equal(parsed.host, "127.0.0.1");
  assert.equal("hostChosen" in parsed, false);
});

test("a config that is on keeps 0.0.0.0, so a working remote setup is not cut off", () => {
  const parsed = normalizeWebConfig({ ...creds, enabled: true, host: "0.0.0.0" });
  assert.equal(parsed.host, "0.0.0.0");
});

test("an address the user chose is kept, wildcard included, and the choice is remembered", () => {
  const parsed = normalizeWebConfig({ ...creds, enabled: false, host: "0.0.0.0", hostChosen: true });
  assert.equal(parsed.host, "0.0.0.0");
  assert.equal(parsed.hostChosen, true);
  // Only a literal true counts as a choice.
  assert.equal(normalizeWebConfig({ ...creds, host: "0.0.0.0", hostChosen: "yes" }).host, "127.0.0.1");
});

test("a pinned interface address and the IPv6 wildcard are not migrated", () => {
  assert.equal(normalizeWebConfig({ ...creds, host: "100.64.0.7" }).host, "100.64.0.7");
  assert.equal(normalizeWebConfig({ ...creds, host: "::" }).host, "::");
  assert.equal(normalizeWebConfig({ ...creds, host: "  " }).host, "127.0.0.1");
  assert.equal(normalizeWebConfig({ ...creds, host: 7 }).host, "127.0.0.1");
});

test("normalizeWebHost: Settings may save IP literals only", () => {
  for (const host of ["127.0.0.1", "0.0.0.0", "::", "::1", "100.64.0.7", "192.168.1.20"]) {
    assert.equal(normalizeWebHost(host), host, host);
  }
  assert.equal(normalizeWebHost(" 100.64.0.7 "), "100.64.0.7");
  for (const host of ["localhost", "evil.example", "", "127.0.0.1:80", "999.1.1.1", "-o", null, 7, undefined]) {
    assert.equal(normalizeWebHost(host), null, String(host));
  }
});

test("isLoopbackHost: all of 127/8 and ::1, nothing else", () => {
  for (const host of ["127.0.0.1", "127.1.2.3", "::1"]) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ["0.0.0.0", "::", "100.64.0.7", "localhost", "127.example", "1270.0.0.1", ""]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

const interfaces = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  en0: [
    { address: "192.168.1.20", family: "IPv4", internal: false },
    { address: "fe80::1", family: "IPv6", internal: false },
  ],
  utun4: [{ address: "100.64.0.7", family: "IPv4", internal: false }],
  gone: undefined,
};

test("webInterfaceAddresses lists non-internal IPv4 addresses with their interface", () => {
  assert.deepEqual(webInterfaceAddresses(interfaces), [
    { name: "en0", address: "192.168.1.20" },
    { name: "utun4", address: "100.64.0.7" },
  ]);
  assert.deepEqual(webInterfaceAddresses({}), []);
});

test("webServerUrls: the pinned address, IPv6 in brackets, or every interface for a wildcard", () => {
  assert.deepEqual(webServerUrls({ host: "127.0.0.1", port: 7683 }, interfaces), ["http://127.0.0.1:7683"]);
  assert.deepEqual(webServerUrls({ host: "::1", port: 7683 }, interfaces), ["http://[::1]:7683"]);
  assert.deepEqual(webServerUrls({ host: "0.0.0.0", port: 7683 }, interfaces), [
    "http://192.168.1.20:7683",
    "http://100.64.0.7:7683",
  ]);
  assert.deepEqual(webServerUrls({ host: "::", port: 7683 }, {}), ["http://127.0.0.1:7683"]);
});

test("webHostOptions: this computer, all networks, then each interface", () => {
  const addresses = webInterfaceAddresses(interfaces);
  assert.deepEqual(webHostOptions({ host: "127.0.0.1", addresses }), [
    ["127.0.0.1", "This computer only (127.0.0.1)"],
    ["0.0.0.0", "All networks (0.0.0.0)"],
    ["192.168.1.20", "en0 (192.168.1.20)"],
    ["100.64.0.7", "utun4 (100.64.0.7)"],
  ]);
  // The pinned interface is one of the listed addresses, not added twice.
  assert.equal(webHostOptions({ host: "100.64.0.7", addresses }).length, 4);
});

test("webHostOptions: an address no option covers is shown first, so the select shows what is in use", () => {
  const options = webHostOptions({ host: "10.9.9.9", addresses: [] });
  assert.deepEqual(options[0], ["10.9.9.9", "10.9.9.9 (from web.json)"]);
  assert.equal(options.length, 3);
});

test("hostHeaderAllowed: a loopback server answers loopback names only; other servers any Host", () => {
  for (const host of ["127.0.0.1:7683", "localhost:7683", "localhost", "[::1]:7683", "127.0.0.2"]) {
    assert.equal(hostHeaderAllowed("127.0.0.1", host), true, host);
    assert.equal(hostHeaderAllowed("::1", host), true, host);
  }
  for (const host of ["evil.example:7683", "evil.example", "127.0.0.1.evil.example", "localhost.evil.example", "", undefined, "a b"]) {
    assert.equal(hostHeaderAllowed("127.0.0.1", host), false, String(host));
  }
  assert.equal(hostHeaderAllowed("0.0.0.0", "my-mac.tailnet.ts.net:7683"), true);
  assert.equal(hostHeaderAllowed("100.64.0.7", "evil.example"), true);
});

function request(port, { method = "GET", path = "/", host, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { Host: host, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("a loopback server refuses a rebinding Host on pages, login and the WebSocket", async () => {
  const { handle, cleanup } = await startTestServer();
  const port = handle.port;
  try {
    const evil = `evil.example:${port}`;
    assert.equal((await request(port, { host: evil })).status, 421);
    const login = await request(port, {
      method: "POST",
      path: "/api/login",
      host: evil,
      headers: { "Content-Type": "application/json", Origin: `http://${evil}` },
      body: JSON.stringify({ user: "tester", password: PASSWORD }),
    });
    assert.equal(login.status, 421);
    assert.equal(JSON.parse(login.body).error, "bad_host");

    // The same login addressed to this computer works, and its cookie still cannot open the socket under a
    // foreign Host.
    const ok = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/api/login",
          headers: { Host: `localhost:${port}`, "Content-Type": "application/json" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ user: "tester", password: PASSWORD }));
    });
    assert.equal(ok.statusCode, 200);
    const cookie = ok.headers["set-cookie"][0].split(";")[0];
    assert.equal((await request(port, { path: "/", host: `localhost:${port}` })).status, 200);

    const outcome = (host) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, Host: host } });
        ws.on("open", () => {
          ws.close();
          resolve("open");
        });
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
        ws.on("error", () => resolve("error"));
      });
    assert.equal(await outcome(evil), 401);
    assert.equal(await outcome(`127.0.0.1:${port}`), "open");
  } finally {
    await cleanup();
  }
});
