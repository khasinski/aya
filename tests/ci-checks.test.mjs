import { test } from "node:test";
import assert from "node:assert/strict";

const { MAX_CI_LOG_TAIL_BYTES, boundedCiLogTail, getPullRequestChecks, buildCiFailurePrompt,
  createCiFailurePreview, sendCiFailurePreview } = await import("../dist-electron/ci-checks.js");

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
  const log = `\u001b[31mred failure\u001b[0m\n\u001bPsecret terminal payload\u001b\\\n\u009b31mC1 color\u009b0m\nAWS_SECRET=private-value\nBearer abcdefghijklmnopqrstuvwxyz0123456789\n${"x".repeat(9_000)}TAIL-END`;
  const { calls, gh } = githubFixture({ log });
  const preview = await buildCiFailurePrompt(directory, "feature/ci", checkUrl, gh);
  assert.equal(preview.check.name, "Linux / electron");
  assert(preview.prompt.includes("Tail of the failed job log (up to 8 KB; earlier output may be omitted):"));
  assert(preview.prompt.includes("TAIL-END"));
  assert(!preview.prompt.includes("AWS_SECRET"));
  assert(!preview.prompt.includes("private-value"));
  assert(!preview.prompt.includes("abcdefghijklmnopqrstuvwxyz0123456789"));
  assert(!preview.prompt.includes("secret terminal payload"));
  assert(!preview.prompt.includes("C1 color"));
  assert(!preview.prompt.includes("\u001b"));
  assert(Buffer.byteLength(preview.prompt.slice(preview.prompt.indexOf("Tail of the failed job log")), "utf8") <= MAX_CI_LOG_TAIL_BYTES + 100);
  assert.deepEqual(calls.at(-1).args, ["run", "view", "123456", "--job", "789012", "--log-failed"]);
  assert(calls.at(-1).timeout >= 20_000);

  const evil = githubFixture({ checks: [{ ...checkRows[0], link: "https://evil.example/actions/runs/123456/job/789012" }] });
  await assert.rejects(buildCiFailurePrompt(directory, "feature/ci", checkUrl, evil.gh), /no longer failing/);
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
