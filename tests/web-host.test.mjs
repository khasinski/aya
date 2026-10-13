// Aya Web listen address: loopback for a new setup, a saved address kept across updates, what Settings may save, the URLs and addresses Settings shows, and the Host check of a loopback server.

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
const { allNetworksWarning, listensOnAllNetworks, webHostOptions } = await import(
  "../dist-test/web-host-options.js"
);

const creds = webCredentials("pw", false);

test("a saved address is kept on or off, 0.0.0.0 included: an update does not cut anyone off", () => {
  for (const enabled of [true, false]) {
    for (const host of ["0.0.0.0", "::", "100.64.0.7", "127.0.0.1"]) {
      assert.equal(normalizeWebConfig({ ...creds, enabled, host }).host, host, `${host} enabled=${enabled}`);
    }
  }
  // The field the first loopback version saved is no longer kept.
  assert.equal("hostChosen" in normalizeWebConfig({ ...creds, host: "0.0.0.0", hostChosen: true }), false);
});

test("a config without a usable address gets the loopback default", () => {
  for (const host of [undefined, "", "  ", 7, null]) {
    assert.equal(normalizeWebConfig({ ...creds, host }).host, "127.0.0.1", String(host));
  }
});

test("listensOnAllNetworks: the IPv4 and IPv6 wildcards in any spelling, nothing else", () => {
  for (const host of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::0", "0::", "::ffff:0.0.0.0"]) {
    assert.equal(listensOnAllNetworks(host), true, host);
  }
  for (const host of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "100.64.0.7", "fe80::1", "", "localhost", ":::"]) {
    assert.equal(listensOnAllNetworks(host), false, host);
  }
});

test("allNetworksWarning: says whether Aya Web listens now or will once on, and that nothing is encrypted", () => {
  assert.match(allNetworksWarning({ host: "0.0.0.0", enabled: true }), /^Aya Web listens on every network/);
  assert.match(allNetworksWarning({ host: "0:0:0:0:0:0:0:0", enabled: false }), /^Aya Web will listen on every network/);
  assert.match(allNetworksWarning({ host: "::", enabled: true }), /password and your terminals travel unencrypted/);
  assert.equal(allNetworksWarning({ host: "127.0.0.1", enabled: true }), null);
  assert.equal(allNetworksWarning({ host: "100.64.0.7", enabled: false }), null);
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

test("isLoopbackHost: all of 127/8 and ::1 in any spelling, 127/8 mapped into IPv6, nothing else", () => {
  for (const host of [
    "127.0.0.1",
    "127.1.2.3",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:127.9.8.7",
    "::FFFF:7f00:1",
  ]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of [
    "0.0.0.0",
    "::",
    "::2",
    "::ffff:10.0.0.1",
    "::ffff:128.0.0.1",
    "fe80::1",
    "100.64.0.7",
    "localhost",
    "127.example",
    "1270.0.0.1",
    "",
  ]) {
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
    ["0.0.0.0", "All IPv4 networks (0.0.0.0)"],
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
  for (const host of ["127.0.0.1:7683", "localhost:7683", "localhost", "[::1]:7683", "127.0.0.2", "[::ffff:127.0.0.1]:7683"]) {
    assert.equal(hostHeaderAllowed("127.0.0.1", host), true, host);
    assert.equal(hostHeaderAllowed("::1", host), true, host);
    assert.equal(hostHeaderAllowed("::ffff:127.0.0.1", host), true, host);
  }
  assert.equal(hostHeaderAllowed("::ffff:127.0.0.1", "evil.example"), false);
  for (const host of ["evil.example:7683", "evil.example", "127.0.0.1.evil.example", "localhost.evil.example", "", undefined, "a b"]) {
    assert.equal(hostHeaderAllowed("127.0.0.1", host), false, String(host));
  }
  assert.equal(hostHeaderAllowed("0.0.0.0", "my-mac.tailnet.ts.net:7683"), true);
  assert.equal(hostHeaderAllowed("100.64.0.7", "evil.example"), true);
});

function request(port, { method = "GET", path = "/", host, headers = {}, body, connect = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: connect, port, method, path, headers: { Host: host, ...headers } },
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

test("a server configured with the name localhost checks Host too: the check goes by the bound address", async () => {
  // localhost binds 127.0.0.1 or ::1, whichever the resolver gives first; the request below resolves it the same way.
  const { handle, cleanup } = await startTestServer({ host: "localhost" });
  const port = handle.port;
  try {
    assert.equal((await request(port, { host: `evil.example:${port}`, connect: "localhost" })).status, 421);
    assert.equal((await request(port, { host: `localhost:${port}`, connect: "localhost" })).status, 200);
  } finally {
    await cleanup();
  }
});

test("a server on a mapped loopback address checks Host", async () => {
  const { handle, cleanup } = await startTestServer({ host: "::ffff:127.0.0.1" });
  const port = handle.port;
  try {
    assert.equal((await request(port, { host: `evil.example:${port}` })).status, 421);
    assert.equal((await request(port, { host: `127.0.0.1:${port}` })).status, 200);
  } finally {
    await cleanup();
  }
});
