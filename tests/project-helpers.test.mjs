import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  activeProjectAfterClose,
  basename,
  compactRecord,
  dedupeSlugs,
  defaultTabName,
  findProject,
  findProjectSlugForSession,
  mergeGitInfo,
  normalizeLocalPath,
  pathContainsProject,
  remoteTerminalCommand,
  resumePanesForProjects,
  samePollPayload,
  sameProjectBadges,
  sameSessionRecords,
  sessionDir,
  shellQuote,
  terminalSpawn,
  uniquePresetId,
  uniqueProjectName,
} from "../dist-test/project-helpers.js";
import { PRESET_ID_SHELL } from "../dist-test/preset-ids.js";

const project = (slug, directory = `/src/${slug}`, extra = {}) => ({
  slug, name: slug, directory, tabs: [], ...extra,
});
const preset = (extra = {}) => ({
  id: "claude", name: "Claude", command: "claude", icon: "C", color: "", ...extra,
});
const terminal = (extra = {}) => ({ id: "t1", cwd: "/src/aya", ...extra });
const remoteProject = (extra = {}) => project("remote", "/local", {
  remote: { hostId: "host", label: "Host", sshTarget: "dev@host", directory: "/srv/aya" },
  ...extra,
});

// Parse only the outer command's arguments, without running ssh or the harness.
function shellWords(command) {
  return execFileSync("/bin/sh", ["-c", `set -- ${command}; printf '%s\\0' "$@"`], {
    encoding: "utf8",
  }).split("\0").slice(0, -1);
}

test("findProject returns the first matching object or null", () => {
  const first = project("aya");
  assert.equal(findProject([first, project("aya")], "aya"), first);
  assert.equal(findProject([first], "absent"), null);
  assert.equal(findProject([], "aya"), null);
});

test("activeProjectAfterClose keeps the selection when another project closes", () => {
  const remaining = [project("first"), project("active")];
  assert.equal(activeProjectAfterClose("active", "closed", remaining), "active");
  assert.equal(activeProjectAfterClose(null, "closed", remaining), null);
  assert.equal(activeProjectAfterClose("stale", "closed", []), "stale");
});

test("activeProjectAfterClose selects the first remaining project in display order", () => {
  const remaining = [project("third"), project("first")];
  assert.equal(activeProjectAfterClose("closed", "closed", remaining), "third");
  assert.deepEqual(remaining.map((p) => p.slug), ["third", "first"]);
  assert.equal(activeProjectAfterClose("closed", "closed", [project("only")]), "only");
});

test("activeProjectAfterClose clears the selection when the last project closes", () => {
  assert.equal(activeProjectAfterClose("closed", "closed", []), null);
});

test("basename strips trailing slashes and falls back for an empty path", () => {
  assert.equal(basename("/src/My Project///"), "My Project");
  assert.equal(basename("relative"), "relative");
  assert.equal(basename("/"), "project");
  assert.equal(basename(""), "project");
});

test("samePollPayload compares nested serialized contents", () => {
  const payload = { sessions: [{ id: "s", cwd: "/src" }], usage: null };
  assert.equal(samePollPayload(payload, structuredClone(payload)), true);
  assert.equal(samePollPayload(payload, { ...payload, usage: 1 }), false);
  assert.equal(samePollPayload([1, 2], [2, 1]), false);
  // Serialization preserves object key order and omits undefined values.
  assert.equal(samePollPayload({ a: 1, b: 2 }, { b: 2, a: 1 }), false);
  assert.equal(samePollPayload({ a: undefined }, {}), true);
});

test("mergeGitInfo preserves identity until branch or dirty count changes", () => {
  const other = { branch: "other", dirty: 0 };
  const state = { "/src/aya": { branch: "main", dirty: 2 }, "/src/other": other };
  assert.equal(mergeGitInfo(state, "/src/aya", { branch: "main", dirty: 2 }), state);
  for (const info of [{ branch: null, dirty: 2 }, { branch: "main", dirty: 3 }]) {
    const next = mergeGitInfo(state, "/src/aya", info);
    assert.notEqual(next, state);
    assert.equal(next["/src/aya"], info);
    assert.equal(next["/src/other"], other);
  }
  const added = { branch: "worktree", dirty: 0 };
  assert.equal(mergeGitInfo(state, "/worktree", added)["/worktree"], added);
  assert.deepEqual(state["/src/aya"], { branch: "main", dirty: 2 });
  assert.equal(Object.hasOwn(state, "/worktree"), false);
});

test("shellQuote preserves apostrophes, whitespace, and shell syntax as one argument", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  for (const value of ["", "a b", "a'b", "line\nbreak", "$HOME `printf x` $(printf y); * \\"]) {
    assert.deepEqual(shellWords(shellQuote(value)), [value]);
  }
});

test("remoteTerminalCommand leaves local commands verbatim", () => {
  const command = "  claude --chrome  ";
  assert.equal(remoteTerminalCommand(project("aya"), preset({ command })), command);
});

test("remoteTerminalCommand uses a login shell for shell presets and shell commands", () => {
  for (const shell of [preset({ id: PRESET_ID_SHELL, command: "custom-shell" }), preset({ command: " $SHELL " })]) {
    assert.deepEqual(shellWords(remoteTerminalCommand(remoteProject(), shell)), [
      "ssh", "-tt", "dev@host", 'cd \'/srv/aya\' && exec "${SHELL:-/bin/sh}" -l',
    ]);
  }
});

test("remoteTerminalCommand quotes both the ssh argument and the nested harness command", () => {
  const remote = remoteProject({
    remote: { sshTarget: "dev@host's alias", directory: "/srv/aya's repo" },
  });
  assert.deepEqual(shellWords(remoteTerminalCommand(remote, preset({ command: "claude --prompt 'hi'" }))), [
    "ssh", "-tt", "dev@host's alias",
    'cd \'/srv/aya\'\\\'\'s repo\' && exec "${SHELL:-/bin/sh}" -l -i -c \'exec claude --prompt \'\\\'\'hi\'\\\'\'\'',
  ]);
});

test("sessionDir uses the terminal cwd locally and target plus directory remotely", () => {
  const pane = terminal({ cwd: "/worktree" });
  assert.equal(sessionDir(null, pane), "/worktree");
  assert.equal(sessionDir(project("aya"), pane), "/worktree");
  assert.equal(sessionDir(remoteProject(), pane), "dev@host:/srv/aya");
});

test("terminalSpawn launches machine tabs directly without remote wrapping or resume", () => {
  const pane = terminal({ sshTarget: "dev@host's alias", restored: true, sessionId: "session" });
  assert.deepEqual(terminalSpawn(remoteProject(), preset(), pane, [], "/home/me"), {
    command: "ssh -- 'dev@host'\\''s alias'",
  });
});

test("terminalSpawn preserves fresh commands and resumes restored local terminals", () => {
  assert.deepEqual(terminalSpawn(null, preset(), terminal(), [], "/home/me"), { command: "claude" });
  assert.deepEqual(terminalSpawn(project("aya"), preset(), terminal({ restored: true }), [], "/home/me"), {
    command: "claude --continue",
  });
  assert.deepEqual(terminalSpawn(null, preset(), terminal({ restored: true, sessionId: "s1" }), [], "/home/me"), {
    command: "claude --resume s1",
  });
  assert.deepEqual(terminalSpawn(null, preset({ autoResume: false }), terminal({ restored: true }), [], "/home/me"), {
    command: "claude",
  });
});

test("terminalSpawn forwards the shared-directory alternative and local peer cwds", () => {
  const panes = [
    { id: "t1", preset: preset(), cwd: "/src/aya" },
    { id: "t2", preset: preset(), cwd: "/other" },
    { id: "t3", preset: preset({ command: "codex" }), cwd: "/codex" },
  ];
  assert.deepEqual(terminalSpawn(null, preset(), terminal({ restored: true }), panes, "/home/me"), {
    command: "claude --continue", sharedDirCommand: "claude", peerCwds: ["/other"],
  });
  assert.deepEqual(terminalSpawn(null, preset(), terminal({ restored: true, sharedDir: true }), panes, "/home/me"), {
    command: "claude",
  });
});

test("restored launch isolates directory-wide sessions across hydration and saved-tab states", async (t) => {
  const cliCases = [
    { id: "claude", command: "claude", directoryResume: true },
    { id: "opencode", command: "opencode", directoryResume: true },
    { id: "codex", command: "codex", directoryResume: true },
    // Grok resumes only an explicit session id; it has no directory-wide continue form.
    { id: "grok", command: "grok", directoryResume: false },
  ];
  const hydrationCases = [
    { name: "launching pane hydrates first", ids: ["launch"] },
    { name: "sibling hydrates first", ids: ["sibling"] },
    { name: "both hydrate", ids: ["launch", "sibling"] },
  ];
  const autoResumeCases = [
    { name: "default", value: undefined, enabled: true },
    { name: "enabled", value: true, enabled: true },
    { name: "disabled", value: false, enabled: false },
  ];

  for (const cli of cliCases) {
    for (const hydration of hydrationCases) {
      for (const savedSibling of [false, true]) {
        for (const sameDirectory of [false, true]) {
          for (const autoResume of autoResumeCases) {
            await t.test(
              `${cli.id}, ${hydration.name}, sibling ${savedSibling ? "saved" : "live only"}, ` +
                `${sameDirectory ? "same" : "different"} directory, autoResume ${autoResume.name}`,
              () => {
                const targetPreset = preset({
                  id: cli.id,
                  command: cli.command,
                  ...(autoResume.value === undefined ? {} : { autoResume: autoResume.value }),
                });
                const targetDir = "/src/work";
                const siblingDir = sameDirectory ? targetDir : "/src/other";
                const targetTab = { id: "launch", presetId: cli.id, name: "Launch", cwd: targetDir };
                const siblingTab = { id: "sibling", presetId: cli.id, name: "Sibling", cwd: siblingDir };
                const saved = project("work", targetDir, {
                  tabs: [targetTab, ...(savedSibling ? [siblingTab] : [])],
                });
                const hydrated = Object.fromEntries(hydration.ids.map((id) => [
                  id,
                  terminal({
                    id,
                    projectSlug: "work",
                    presetId: cli.id,
                    cwd: id === "launch" ? targetDir : siblingDir,
                    restored: true,
                    exitCode: null,
                  }),
                ]));
                const panes = resumePanesForProjects([saved], hydrated, [targetPreset], {});
                const spawn = terminalSpawn(
                  saved,
                  targetPreset,
                  terminal({
                    id: "launch",
                    projectSlug: "work",
                    presetId: cli.id,
                    cwd: targetDir,
                    restored: true,
                  }),
                  panes,
                  "/home/me",
                );
                const siblingIsKnown = savedSibling || hydration.ids.includes("sibling");
                const siblingSharesDirectory = siblingIsKnown && sameDirectory;
                const shouldAvoidContinue = cli.directoryResume && autoResume.enabled && siblingSharesDirectory;

                assert.equal(panes.some((pane) => pane.id === "sibling"), siblingIsKnown);
                assert.equal(
                  spawn.sharedDirCommand !== undefined,
                  cli.directoryResume && autoResume.enabled && siblingIsKnown,
                );
                if (shouldAvoidContinue) {
                  assert.equal(spawn.command.includes("--continue") || spawn.command.includes("resume --last"), true);
                  assert.equal(spawn.sharedDirCommand, cli.command);
                  assert.ok(spawn.peerCwds?.includes(siblingDir));
                }
                if (!cli.directoryResume || !autoResume.enabled) {
                  assert.equal(spawn.sharedDirCommand, undefined);
                }
              },
            );
          }
        }
      }
    }
  }

  await t.test("a closed terminal record left in memory is not a sibling", () => {
    const targetPreset = preset();
    const saved = project("work", "/src/work", {
      tabs: [{ id: "launch", presetId: "claude", name: "Launch" }],
    });
    const panes = resumePanesForProjects([saved], {
      closed: terminal({
        id: "closed",
        projectSlug: "work",
        presetId: "claude",
        cwd: "/src/work",
        restored: true,
        exitCode: 0,
      }),
    }, [targetPreset], {});
    assert.deepEqual(panes.map((pane) => pane.id), ["launch"]);
    const spawn = terminalSpawn(
      saved,
      targetPreset,
      terminal({ id: "launch", projectSlug: "work", presetId: "claude", restored: true }),
      panes,
      "/home/me",
    );
    assert.deepEqual(spawn, { command: "claude --continue" });
  });
});

test("terminalSpawn wraps remote resume and maps matching peer directories to local home", () => {
  const remote = remoteProject();
  const panes = [{ id: "t2", preset: preset(), cwd: "dev@host:/srv/aya" }];
  const spawn = terminalSpawn(remote, preset(), terminal({ restored: true }), panes, "/home/me");
  assert.deepEqual(shellWords(spawn.command), [
    "ssh", "-tt", "dev@host", 'cd \'/srv/aya\' && exec "${SHELL:-/bin/sh}" -l -i -c \'exec claude --continue\'',
  ]);
  assert.deepEqual(shellWords(spawn.sharedDirCommand), [
    "ssh", "-tt", "dev@host", 'cd \'/srv/aya\' && exec "${SHELL:-/bin/sh}" -l -i -c \'exec claude\'',
  ]);
  assert.deepEqual(spawn.peerCwds, ["/home/me"]);
  const unrelated = terminalSpawn(remote, preset(), terminal({ restored: true }), [
    { ...panes[0], cwd: "other@host:/srv/aya" },
  ], "/home/me");
  assert.deepEqual(unrelated, { command: spawn.command });
});

test("uniqueProjectName predicts slug collisions and chooses the first free suffix", () => {
  assert.equal(uniqueProjectName([], "/src/My Project/"), "My Project");
  assert.equal(uniqueProjectName([project("my-project"), project("my-project-2")], "/src/My Project"), "My Project 3");
  assert.equal(uniqueProjectName([project("my-project"), project("my-project-3")], "/src/My Project"), "My Project 2");
  assert.equal(uniqueProjectName([project("project")], "/src/###"), "### 2");
  assert.equal(uniqueProjectName([project("project")], "/"), "project 2");
});

test("uniqueProjectName checks slugs rather than display names without changing projects", () => {
  const projects = [project("my-project", "/elsewhere", { name: "Renamed" }),
    project("other", "/other", { name: "My Project 2" })];
  const before = structuredClone(projects);
  assert.equal(uniqueProjectName(projects, "/src/My Project///"), "My Project 2");
  assert.deepEqual(projects, before);
  assert.equal(uniqueProjectName([project("other", "/other", { name: "My Project" })], "/src/My Project"), "My Project");
});

test("uniquePresetId scopes and normalizes repo presets, with collision suffixes", () => {
  const repo = project("my-repo");
  assert.equal(uniquePresetId([], repo, preset({ id: "../../Bad ID" })), "my-repo--bad-id");
  assert.equal(uniquePresetId([], repo, preset({ id: "", name: "Dev Server" })), "my-repo-dev-server");
  assert.equal(uniquePresetId([preset({ id: "my-repo-claude" }), preset({ id: "my-repo-claude-2" })], repo, preset()), "my-repo-claude-3");
  assert.equal(uniquePresetId([preset({ id: "my-repo-claude" }), preset({ id: "my-repo-claude-3" })], repo, preset()), "my-repo-claude-2");
});

test("defaultTabName prefers the trimmed display name, then id, then terminal", () => {
  assert.equal(defaultTabName(preset({ name: "  Work Claude  " })), "Work Claude");
  assert.equal(defaultTabName(preset({ name: " \t " })), "claude");
  assert.equal(defaultTabName(preset({ name: "", id: "" })), "terminal");
});

test("normalizeLocalPath only removes trailing slashes beyond a one-character path", () => {
  assert.equal(normalizeLocalPath("/src/aya///"), "/src/aya");
  assert.equal(normalizeLocalPath("/"), "/");
  assert.equal(normalizeLocalPath(""), "");
  assert.equal(normalizeLocalPath("/src/../aya"), "/src/../aya");
});

test("pathContainsProject matches exact paths and descendants at a slash boundary", () => {
  assert.equal(pathContainsProject("/src/aya///", "/src/aya/"), true);
  assert.equal(pathContainsProject("/src/aya/sub", "/src/aya/"), true);
  assert.equal(pathContainsProject("/src/aya-other", "/src/aya"), false);
  assert.equal(pathContainsProject("/src", "/src/aya"), false);
  // Preserve the existing root-directory edge case.
  assert.equal(pathContainsProject("/src/aya", "/"), false);
});

test("findProjectSlugForSession chooses the deepest local project and keeps first ties", () => {
  const projects = [project("parent", "/src"), project("child", "/src/aya"), project("tie", "/src/aya")];
  assert.equal(findProjectSlugForSession({ cwd: "/src/aya/sub" }, projects), "child");
  assert.equal(findProjectSlugForSession({ cwd: "/src/aya-other" }, projects), "parent");
  assert.equal(findProjectSlugForSession({ cwd: "/elsewhere" }, projects), null);
  assert.equal(findProjectSlugForSession({ cwd: "/local" }, [remoteProject()]), null);
  assert.equal(findProjectSlugForSession({ cwd: "/src" }, []), null);
});

test("dedupeSlugs keeps first occurrences in order without changing the input", () => {
  const input = ["b", "a", "b", "", "a", "constructor", ""];
  assert.deepEqual(dedupeSlugs(input), ["b", "a", "", "constructor"]);
  assert.deepEqual(input, ["b", "a", "b", "", "a", "constructor", ""]);
  assert.deepEqual(dedupeSlugs([]), []);
});

test("compactRecord retains live ids and drops null, undefined, and empty values", () => {
  const input = { a: "t1", b: null, c: undefined, d: "", e: " " };
  assert.deepEqual(compactRecord(input), { a: "t1", e: " " });
  assert.equal(input.b, null);
  assert.deepEqual(compactRecord({}), {});
});

test("sameProjectBadges compares counts, levels, and keys independently of object identity", () => {
  const badges = { a: { count: 1, level: "waiting" }, b: { count: 2, level: "done" } };
  assert.equal(sameProjectBadges(badges, { b: { ...badges.b }, a: { ...badges.a } }), true);
  assert.equal(sameProjectBadges(badges, { ...badges, a: { count: 2, level: "waiting" } }), false);
  assert.equal(sameProjectBadges(badges, { ...badges, a: { count: 1, level: "done" } }), false);
  assert.equal(sameProjectBadges(badges, { a: badges.a }), false);
  assert.equal(sameProjectBadges({ a: badges.a }, { c: badges.a }), false);
});

test("sameSessionRecords ignores record order but compares session identity and array order", () => {
  const first = { id: "s1" };
  const second = { id: "s2" };
  const records = { a: [first, second], b: [] };
  assert.equal(sameSessionRecords(records, { b: [], a: [first, second] }), true);
  assert.equal(sameSessionRecords(records, { a: [second, first], b: [] }), false);
  assert.equal(sameSessionRecords(records, { a: [{ ...first }, second], b: [] }), false);
  assert.equal(sameSessionRecords(records, { a: [first], b: [] }), false);
  assert.equal(sameSessionRecords(records, { c: [first, second], b: [] }), false);
});
