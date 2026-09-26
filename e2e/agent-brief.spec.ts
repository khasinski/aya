// #117: the aya brief reaches the agent through its harness's channel, only
// for presets that opt in. Claude: an argument on the real launch command.
// Codex: a marked section in its AGENTS.md, added and removed by saving the
// preset, with the user's own text left alone.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

test.describe.configure({ timeout: 120_000 });

const NODE = process.execPath;
const ARGV_DUMP = join(__dirname, "helpers", "argv-dump.cjs");
const REPO_BIN = join(__dirname, "..", "bin");

test.describe("claude preset with the brief on", () => {
  test.use({
    seedOptions: {
      presetList: [
        {
          id: "shell",
          name: "Fake claude",
          icon: "$",
          color: "",
          agent: "claude",
          agentBrief: true,
          command: `'${NODE}' '${ARGV_DUMP}' "$AYA_PROJECT_DIR/argv-$AYA_TERMINAL_ID.json"`,
        },
      ],
    },
  });

  test("the pane is launched with --append-system-prompt and can run aya", async ({
    window,
    seeded,
  }) => {
    void window;
    const dump = join(seeded.projectDir, `argv-${seeded.tabIds.right}.json`);
    await expect
      .poll(() => existsSync(dump), { message: "the pane never started", timeout: 60_000 })
      .toBe(true);
    const { args, ayaOnPath, pathEntries } = JSON.parse(readFileSync(dump, "utf8"));
    // The seeded tab is a restored one, so auto-resume's --continue comes
    // first; the brief follows it as exactly one argument.
    const flag = args.indexOf("--append-system-prompt");
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(args.lastIndexOf("--append-system-prompt")).toBe(flag);
    expect(args[flag + 1]).toContain("aya capabilities");
    expect(args).toHaveLength(flag + 2);
    // The bundled CLI is appended to the pane's PATH, so `aya` resolves even
    // with no shim installed. The user's rc files run after us (login +
    // interactive shell) and may append more, so only presence is promised.
    expect(pathEntries).toContain(REPO_BIN);
    expect(ayaOnPath).not.toBeNull();
  });
});

test.describe("claude preset with the brief off (the default)", () => {
  test.use({
    seedOptions: {
      presetList: [
        {
          id: "shell",
          name: "Fake claude",
          icon: "$",
          color: "",
          agent: "claude",
          command: `'${NODE}' '${ARGV_DUMP}' "$AYA_PROJECT_DIR/argv-$AYA_TERMINAL_ID.json"`,
        },
      ],
    },
  });

  test("no --append-system-prompt without the opt-in", async ({ window, seeded }) => {
    void window;
    const dump = join(seeded.projectDir, `argv-${seeded.tabIds.right}.json`);
    await expect
      .poll(() => existsSync(dump), { message: "the pane never started", timeout: 60_000 })
      .toBe(true);
    expect(JSON.parse(readFileSync(dump, "utf8")).args).not.toContain(
      "--append-system-prompt",
    );
  });
});

test("codex AGENTS.md: saving the preset adds the section, turning it off removes only it", async ({
  window,
  seeded,
}) => {
  const home = join(seeded.root, "codex-brief-home");
  const agentsMd = join(home, "AGENTS.md");
  mkdirSync(home, { recursive: true });
  const userText = "# My rules\n\nAlways run the tests.\n";
  writeFileSync(agentsMd, userText);

  const save = (agentBrief: boolean) =>
    window.evaluate(
      async ({ configDir, agentBrief }) => {
        const presets = await window.aya.listPresets();
        await window.aya.savePresets([
          ...presets.filter((p) => p.id !== "codex-brief"),
          {
            id: "codex-brief",
            name: "Codex",
            icon: "C",
            color: "",
            agent: "codex",
            configDir,
            command: "codex",
            ...(agentBrief ? { agentBrief: true } : {}),
          },
        ]);
      },
      { configDir: home, agentBrief },
    );

  await save(true);
  const withBrief = readFileSync(agentsMd, "utf8");
  expect(withBrief.startsWith(userText)).toBe(true);
  expect(withBrief).toContain("aya:brief:begin");
  expect(withBrief).toContain("If the AYA_TERMINAL_ID environment variable is set");

  await save(true);
  expect(readFileSync(agentsMd, "utf8"), "a second save stacked a section").toBe(withBrief);

  await save(false);
  expect(readFileSync(agentsMd, "utf8")).toBe(userText);
});
