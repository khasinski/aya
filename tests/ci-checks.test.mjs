import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { MAX_CI_LOG_TAIL_BYTES, boundedCiLogTail, getPullRequestChecks, buildCiFailurePrompt,
  MAX_STORED_CI_PREVIEWS, createCiFailurePreview, sendCiFailurePreview } = await import("../dist-electron/ci-checks.js");
const { GH_MAX_OUTPUT_BYTES, runGh } = await import("../dist-electron/git-publish.js");

const directory = "/tmp/aya-ci-checks-test";
const prUrl = "https://github.com/acme/repo/pull/17";
const checkUrl = "https://github.com/acme/repo/actions/runs/123456/job/789012";
const repoUrl = "https://github.com/acme/repo";
const checkRows = [{ name: "Linux / electron", state: "failure", bucket: "fail", link: checkUrl }];

function githubFixture({ log = "AssertionError: expected 1 to equal 2\n", state = "OPEN", checks = checkRows } = {}) {
  const calls = [];
  const gh = async (_directory, args, timeout) => {
    calls.push({ args, timeout });
    if (args[0] === "repo" && args[1] === "view") return repoUrl;
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ url: prUrl, state });
    if (args[0] === "pr" && args[1] === "checks") return JSON.stringify(checks);
    if (args[0] === "run" && args[1] === "view") return log;
    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  };
  return { calls, gh };
}

test("loads PR checks with bounded gh calls and same-repository HTTPS links", async () => {
  const { calls, gh } = githubFixture();
  const result = await getPullRequestChecks(directory, "feature/ci", gh);
  assert.deepEqual(result, {
    pullRequestUrl: prUrl,
    pullRequestState: "open",
    checks: [{ name: checkRows[0].name, state: checkRows[0].state, bucket: "fail", url: checkUrl }],
  });
  assert.deepEqual(calls.map((call) => call.args.slice(0, 2)), [["repo", "view"], ["pr", "view"], ["pr", "checks"]]);
  assert(calls.every((call) => call.timeout > 0 && call.timeout <= 20_000));
});

test("stops check polling data for merged and closed pull requests", async () => {
  for (const state of ["MERGED", "CLOSED"]) {
    const { calls, gh } = githubFixture({ state });
    const result = await getPullRequestChecks(directory, "feature/ci", gh);
    assert.equal(result.pullRequestState, state.toLowerCase());
    assert.deepEqual(result.checks, []);
    assert.equal(calls.length, 2, "must not request check details once the PR is closed");
  }
});

test("accepts gh's pending-check exit while preserving its JSON rows", async () => {
  const pendingRows = [{ name: "macOS tests", state: "queued", bucket: "pending", link: checkUrl }];
  const { gh: base } = githubFixture();
  const gh = async (cwd, args, timeout) => {
    if (args[0] === "pr" && args[1] === "checks") {
      throw Object.assign(new Error("checks are pending"), { code: 8, stdout: JSON.stringify(pendingRows) });
    }
    return base(cwd, args, timeout);
  };
  const result = await getPullRequestChecks(directory, "feature/ci", gh);
  assert.equal(result.checks[0].bucket, "pending");
  assert.equal(result.checks[0].name, "macOS tests");
});

test("failure preview includes a sanitized bounded log tail and only accepts repository job URLs", async () => {
  const log = `\u001b[31mred failure\u001b[0m\n\u001bPsecret terminal payload\u001b\\\n\u001b]0;ESC OSC secret\u001b\\\n\u009dC1 OSC secret\u001b\\\n\u0090C1 DCS secret\u001b\\\nAWS_SECRET=private-value\nBearer abcdefghijklmnopqrstuvwxyz0123456789\n${"x".repeat(9_000)}report\u202etxt\nTAIL-END`;
  const { calls, gh } = githubFixture({ log });
  const preview = await buildCiFailurePrompt(directory, "feature/ci", checkUrl, gh);
  assert.equal(preview.check.name, "Linux / electron");
  assert(preview.prompt.includes("Tail of the failed job log (up to 8 KB; earlier output may be omitted):"));
  assert(preview.prompt.includes("TAIL-END"));
  assert(!preview.prompt.includes("AWS_SECRET"));
  assert(!preview.prompt.includes("private-value"));
  assert(!preview.prompt.includes("abcdefghijklmnopqrstuvwxyz0123456789"));
  assert(!preview.prompt.includes("secret terminal payload"));
  assert(!preview.prompt.includes("OSC secret"));
  assert(!preview.prompt.includes("DCS secret"));
  assert(preview.prompt.includes("report\\u202etxt"));
  assert(!preview.prompt.includes("report\u202etxt"));
  assert(!preview.prompt.includes("C1 color"));
  assert(!preview.prompt.includes("\u001b"));
  assert(Buffer.byteLength(preview.prompt.slice(preview.prompt.indexOf("Tail of the failed job log")), "utf8") <= MAX_CI_LOG_TAIL_BYTES + 100);
  assert.deepEqual(calls.at(-1).args, ["run", "view", "123456", "--job", "789012", "--log-failed"]);
  assert(calls.at(-1).timeout >= 20_000);

  const evil = githubFixture({ checks: [{ ...checkRows[0], link: "https://evil.example/actions/runs/123456/job/789012" }] });
  await assert.rejects(buildCiFailurePrompt(directory, "feature/ci", checkUrl, evil.gh), /no longer failing/);
});

test("check names make bidi controls visible", async () => {
  const { gh } = githubFixture({ checks: [{ ...checkRows[0], name: "report\u202etxt" }] });
  const result = await getPullRequestChecks(directory, "feature/ci", gh);
  assert.equal(result.checks[0].name, "report\\u202etxt");
});

test("runGh captures logs over 1 MiB before bounding the prompt tail", async () => {
  const root = mkdtempSync(join(tmpdir(), "aya-gh-large-log-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const fakeGh = join(bin, "gh");
  writeFileSync(fakeGh, `#!/usr/bin/env node\nprocess.stdout.write("x".repeat(1_500_000) + "LAST-LINE");\n`);
  chmodSync(fakeGh, 0o755);
  try {
    const result = await runGh(root, ["run", "view"], 10_000, undefined, { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` });
    assert.equal(GH_MAX_OUTPUT_BYTES, 64 * 1024 * 1024);
    assert(result.length > 1_000_000);
    assert.equal(boundedCiLogTail(result).slice(-9), "LAST-LINE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preview is refetched and sends one bracketed paste through the shared Enter path", async () => {
  const { gh } = githubFixture({ log: "exact failure output\n" });
  const preview = await createCiFailurePreview({
    directory, branch: "feature/ci", checkUrl, projectSlug: "project", targetId: "pane-1",
  }, gh);
  assert.match(preview.prompt, /exact failure output/);
  let sent;
  await sendCiFailurePreview({ token: preview.token, projectSlug: "project", targetId: "pane-1" }, async (...args) => { sent = args; }, gh);
  assert.deepEqual(sent, ["project", "pane-1", `\x1b[200~${preview.prompt}\x1b[201~`]);
  await assert.rejects(sendCiFailurePreview({ token: preview.token, projectSlug: "project", targetId: "pane-1" }, async () => {}, gh), /preview expired/);
});

test("a changed log requires a new preview and is never sent", async () => {
  let log = "first failure";
  const gh = async (_directory, args) => {
    if (args[0] === "repo" && args[1] === "view") return repoUrl;
    if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ url: prUrl, state: "OPEN" });
    if (args[0] === "pr" && args[1] === "checks") return JSON.stringify(checkRows);
    if (args[0] === "run" && args[1] === "view") return log;
    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  };
  const preview = await createCiFailurePreview({
    directory, branch: "feature/ci", checkUrl, projectSlug: "project", targetId: "pane-1",
  }, gh);
  log = "updated failure";
  let sends = 0;
  await assert.rejects(sendCiFailurePreview({ token: preview.token, projectSlug: "project", targetId: "pane-1" }, async () => { sends += 1; }, gh), /log changed/);
  assert.equal(sends, 0);
});

test("concurrent sends cannot use the same single-use preview token", async () => {
  const { gh } = githubFixture();
  const preview = await createCiFailurePreview({
    directory, branch: "feature/ci", checkUrl, projectSlug: "project", targetId: "pane-1",
  }, gh);
  let sends = 0;
  const input = { token: preview.token, projectSlug: "project", targetId: "pane-1" };
  const sender = async () => { sends += 1; };
  const results = await Promise.allSettled([
    sendCiFailurePreview(input, sender, gh),
    sendCiFailurePreview(input, sender, gh),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(sends, 1);
});

test("preview storage evicts the oldest unexpired preview at its fixed cap", async () => {
  const { gh } = githubFixture();
  const created = [];
  for (let index = 0; index <= MAX_STORED_CI_PREVIEWS; index += 1) {
    created.push(await createCiFailurePreview({
      directory, branch: "feature/ci", checkUrl, projectSlug: "project", targetId: `pane-${index}`,
    }, gh));
  }
  const sender = async () => {};
  await assert.rejects(sendCiFailurePreview({ token: created[0].token, projectSlug: "project", targetId: "pane-0" }, sender, gh), /preview expired/);
  await sendCiFailurePreview({ token: created.at(-1).token, projectSlug: "project", targetId: `pane-${MAX_STORED_CI_PREVIEWS}` }, sender, gh);
});

test("expired previews are rejected and pruned before new previews are stored", async () => {
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const { gh } = githubFixture();
    const make = (targetId) => createCiFailurePreview({
      directory, branch: "feature/ci", checkUrl, projectSlug: "project", targetId,
    }, gh);
    const expired = await make("old-pane");
    now += 5 * 60_000 + 1;
    const current = await make("new-pane");
    const sender = async () => {};
    await assert.rejects(sendCiFailurePreview({ token: expired.token, projectSlug: "project", targetId: "old-pane" }, sender, gh), /preview expired/);
    await sendCiFailurePreview({ token: current.token, projectSlug: "project", targetId: "new-pane" }, sender, gh);
  } finally {
    Date.now = originalNow;
  }
});
