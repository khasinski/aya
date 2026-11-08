// aya present / aya artifact against a stub control socket: the JSON the app receives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cli = resolve("bin/aya");

async function run(args, stdin = "") {
  const dir = mkdtempSync(join(tmpdir(), "aya-present-"));
  const socket = join(dir, "aya.sock");
  let request = null;
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      request = JSON.parse(buffer.slice(0, newline));
      conn.end(`${JSON.stringify({ ok: true, output: "created artifact x\n" })}\n`);
    });
  });
  await new Promise((done) => server.listen(socket, done));
  try {
    const result = await new Promise((done, fail) => {
      const child = spawn(cli, args, { env: { ...process.env, AYA_SOCKET: socket, AYA_PROJECT_SLUG: "" }, cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("error", fail);
      child.on("close", (status) => done({ status, err }));
      child.stdin.end(stdin);
    });
    return { ...result, request, dir };
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
}

test("present --html - reads stdin and opens by default", async () => {
  const { status, request } = await run(["present", "--title", "Plan", "--html", "-"], "<h1>hi</h1>");
  assert.equal(status, 0);
  assert.equal(request.type, "artifact-present");
  assert.deepEqual(request.input, { kind: "html", title: "Plan", html: "<h1>hi</h1>" });
  assert.equal(request.open, true);
});

test("present --table reads JSON, --id updates, --no-open stores", async () => {
  const { status, request } = await run(["present", "--title", "T", "--table", "-", "--id", "abc", "--no-open"], JSON.stringify({ columns: ["a"], rows: [["1"]] }));
  assert.equal(status, 0);
  assert.deepEqual(request.input, { kind: "table", title: "T", columns: ["a"], rows: [["1"]], artifactId: "abc" });
  assert.equal(request.open, false);
});

test("present --image sends an absolute path; --metric sends value and description", async () => {
  const image = await run(["present", "--title", "I", "--image", "pic.png"]);
  assert.match(image.request.input.imagePath, /^\/.*pic\.png$/);
  const metric = await run(["present", "--title", "M", "--metric", "42", "--description", "users"]);
  assert.deepEqual(metric.request.input, { kind: "metric", title: "M", value: "42", description: "users" });
});

test("present refuses a missing kind, a missing title and mixed kinds without contacting Aya", async () => {
  for (const args of [["present", "--title", "x"], ["present", "--metric", "1"], ["present", "--title", "x", "--metric", "1", "--image", "a.png"], ["present", "--title", "x", "--bogus"]]) {
    const { status, request, err } = await run(args);
    assert.notEqual(status, 0, args.join(" "));
    assert.equal(request, null);
    assert.match(err, /aya:/);
  }
});

test("artifact list and open", async () => {
  const list = (await run(["artifact", "list", "--json"])).request;
  assert.equal(list.type, "artifact-list");
  assert.equal(list.json, true);
  const open = await run(["artifact", "open", "abc"]);
  assert.equal(open.request.type, "artifact-open");
  assert.equal(open.request.artifactId, "abc");
  assert.notEqual((await run(["artifact", "bogus"])).status, 0);
});
