// Covers resolveGitHubLink — the PR → branch → none decision behind the
// status-bar GitHub link. The gh/git subprocesses are injected so we test the
// branching without a real repo or network (mirrors how the pure parsers in
// git/usage are tested while their shell wrappers are left to integration use).

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveGitHubLink } from "../dist-electron/github.js";

// Builds a fake gh runner from a map of subcommand -> stdout (or an Error to
// throw). Records every call so tests can assert ordering / arguments.
function fakeGh(handlers) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const key = args[0];
    const result = handlers[key];
    if (result === undefined) throw new Error(`unexpected gh ${key}`);
    if (result instanceof Error) throw result;
    return result;
  };
  return { run, calls };
}

const branch = async () => "feature/x";

test("returns the PR url when the branch has a PR", async () => {
  const { run, calls } = fakeGh({ pr: "https://github.com/o/r/pull/7\n" });
  const link = await resolveGitHubLink(run, branch);
  assert.deepEqual(link, { kind: "pr", url: "https://github.com/o/r/pull/7" });
  // PR is checked first; no need to fall back to browse.
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "pr");
});

test("falls back to the branch page when there is no PR", async () => {
  const { run, calls } = fakeGh({
    pr: new Error("no pull requests found"),
    browse: "https://github.com/o/r/tree/feature/x\n",
  });
  const link = await resolveGitHubLink(run, branch);
  assert.deepEqual(link, {
    kind: "branch",
    url: "https://github.com/o/r/tree/feature/x",
  });
  // browse is invoked with the resolved branch name.
  const browseCall = calls.find((c) => c[0] === "browse");
  assert.ok(browseCall.includes("--branch"));
  assert.ok(browseCall.includes("feature/x"));
});

test("treats empty PR stdout as no PR and falls back", async () => {
  const { run } = fakeGh({
    pr: "   \n",
    browse: "https://github.com/o/r/tree/feature/x\n",
  });
  const link = await resolveGitHubLink(run, branch);
  assert.equal(link.kind, "branch");
});

test("returns null when there is no PR and no current branch", async () => {
  const { run, calls } = fakeGh({ pr: new Error("no PR") });
  const link = await resolveGitHubLink(run, async () => null);
  assert.equal(link, null);
  // With no branch we never attempt browse.
  assert.ok(!calls.some((c) => c[0] === "browse"));
});

test("returns null when both PR and branch lookups fail (gh missing / no remote)", async () => {
  const { run } = fakeGh({
    pr: new Error("gh missing"),
    browse: new Error("no github remote"),
  });
  const link = await resolveGitHubLink(run, branch);
  assert.equal(link, null);
});
