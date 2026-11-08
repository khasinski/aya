// The real transport (fetchRuleBytes) against a real local HTTPS server: the default `fetch`, TLS, redirects and the
// size cap, none of it stubbed. A child process trusts the server's throwaway certificate through NODE_EXTRA_CA_CERTS.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aya-https-"));
const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem");
let haveOpenssl = true;
try {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
} catch { haveOpenssl = false; }

const good = JSON.stringify({ schemaVersion: 1, ruleSetVersion: "net1", agent: "claude", rules: [] });
const routes = {
  "/ok.json": (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(good); },
  "/redirect.json": (_req, res) => { res.writeHead(302, { location: "/ok.json" }); res.end(); },
  "/to-http.json": (_req, res) => { res.writeHead(302, { location: "http://127.0.0.1:9/x.json" }); res.end(); },
  "/big.json": (_req, res) => { res.writeHead(200); res.end(Buffer.alloc(70 * 1024, 32)); },
  "/missing.json": (_req, res) => { res.writeHead(404); res.end("secret body text"); },
  "/garbage.json": (_req, res) => { res.writeHead(200); res.end("<html>not rules</html>"); },
};

async function fetchVia(port, route, agent = "claude") {
  const home = fs.mkdtempSync(path.join(dir, "home-"));
  const script = `
    const { fetchUserRuleFile } = require(${JSON.stringify(path.resolve("dist-electron/screen-rule-fetch.js"))});
    const { loadBundledScreenRules } = require(${JSON.stringify(path.resolve("dist-electron/screen-rule-data.js"))});
    const builtin = loadBundledScreenRules(${JSON.stringify(path.resolve("electron/screen-rules"))});
    fetchUserRuleFile({ url: process.argv[1], agent: ${JSON.stringify(agent)}, replace: false, directory: ${JSON.stringify(path.join(home, "screen-rules"))}, builtin })
      .then((r) => console.log(JSON.stringify(r)), (e) => { console.log(JSON.stringify({ error: e.message })); });`;
  const out = await new Promise((done) => {
    const child = spawn(process.execPath, ["-e", script, `https://localhost:${port}${route}`], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdio: ["ignore", "pipe", "inherit"] });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.on("close", () => done(text));
  });
  return { result: JSON.parse(out), file: path.join(home, "screen-rules", `${agent}.json`) };
}

test("real HTTPS: a rule file arrives, follows a same-scheme redirect and lands 0600", { skip: !haveOpenssl }, async () => {
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => (routes[req.url] ?? routes["/missing.json"])(req, res));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  try {
    for (const route of ["/ok.json", "/redirect.json"]) {
      const { result, file } = await fetchVia(port, route);
      assert.equal(result.error, undefined, route);
      assert.equal(result.version, "net1");
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    for (const [route, pattern] of [["/to-http.json", /https|could not fetch/], ["/big.json", /larger than 64 KiB/], ["/missing.json", /404/], ["/garbage.json", /not a valid rule file/]]) {
      const { result, file } = await fetchVia(port, route);
      assert.match(result.error ?? "", pattern, route);
      assert.equal(fs.existsSync(file), false, `${route} left a file`);
      assert.doesNotMatch(result.error, /secret body text/, "the response body is never echoed");
    }
  } finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
});

test("real HTTPS: an untrusted certificate is refused", { skip: !haveOpenssl }, async () => {
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, routes["/ok.json"]);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  try {
    const home = fs.mkdtempSync(path.join(dir, "home-"));
    const script = `require(${JSON.stringify(path.resolve("dist-electron/screen-rule-fetch.js"))}).fetchRuleBytes(new URL("https://localhost:${port}/ok.json"), AbortSignal.timeout(5000)).then(() => console.log("fetched"), () => console.log("refused"));`;
    const out = execFileSync(process.execPath, ["-e", script], { env: { ...process.env, NODE_EXTRA_CA_CERTS: "" } }).toString().trim();
    assert.equal(out, "refused");
    void home;
  } finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
});
