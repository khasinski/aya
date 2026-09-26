// #117: the brief reaches the agent through its harness's channel, only for
// presets that opt in, on the real launch path.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { fireShortcut } from "./helpers/shortcut";

test.describe.configure({ timeout: 120_000 });

const NODE = process.execPath;
const ARGV_DUMP = join(__dirname, "helpers", "argv-dump.cjs");
const REPO_BIN = join(__dirname, "..", "bin");

/** A preset whose pane records its argv/env instead of running `agent`. */
const fakeAgent = (agent: string, agentBrief = true) => ({
  seedOptions: {
    presetList: [
      {
        id: "shell",
        name: `Fake ${agent}`,
        icon: "$",
        color: "",
        agent,
        ...(agentBrief ? { agentBrief: true } : {}),
        command: `'${NODE}' '${ARGV_DUMP}' "$AYA_PROJECT_DIR/argv-$AYA_TERMINAL_ID.json"`,
      },
    ],
  },
});

async function paneLaunch(seeded: { projectDir: string; tabIds: { right: string } }) {
  const dump = join(seeded.projectDir, `argv-${seeded.tabIds.right}.json`);
  await expect
    .poll(() => existsSync(dump), { message: "the pane never started", timeout: 60_000 })
    .toBe(true);
  return JSON.parse(readFileSync(dump, "utf8"));
}

test.describe("claude preset with the brief on", () => {
  test.use(fakeAgent("claude"));

  test("the pane is launched with --append-system-prompt and can run aya", async ({
    window,
    seeded,
  }) => {
    void window;
    const { args, ayaOnPath, pathEntries } = await paneLaunch(seeded);
    // The seeded tab is a restored one, so auto-resume's --continue comes
    // first; the brief follows it as exactly one argument.
    const flag = args.indexOf("--append-system-prompt");
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(args.lastIndexOf("--append-system-prompt")).toBe(flag);
    expect(args[flag + 1]).toContain("aya capabilities");
    expect(args).toHaveLength(flag + 2);
    // User rc files run after us and may append more, so only presence is promised.
    expect(pathEntries).toContain(REPO_BIN);
    expect(ayaOnPath).not.toBeNull();
  });
});

test.describe("claude preset with the brief off (the default)", () => {
  test.use(fakeAgent("claude", false));

  test("no --append-system-prompt without the opt-in", async ({ window, seeded }) => {
    void window;
    const { args } = await paneLaunch(seeded);
    expect(args).not.toContain("--append-system-prompt");
  });
});

test.describe("the Settings toggle", () => {
  test.use(fakeAgent("claude", false));

  test("checking it and saving persists agentBrief on the preset", async ({
    window,
    app,
    seeded,
  }) => {
    await fireShortcut(app, "open-settings");
    const settings = window.locator(".aya-modal--settings");
    await settings.getByTestId("settings-tab").filter({ hasText: "Presets" }).click();
    await settings
      .locator(".aya-preset-toggle", { hasText: "Tell the agent about aya" })
      .locator('input[type="checkbox"]')
      .check();
    await settings.locator(".aya-modal-btn--primary", { hasText: "Save" }).click();
    await expect(settings).toBeHidden();
    const saved = () =>
      JSON.parse(readFileSync(join(seeded.ayaHome, "presets.json"), "utf8")).presets[0].agentBrief;
    await expect.poll(saved).toBe(true);
  });
});

test.describe("grok preset with the brief on", () => {
  test.use(fakeAgent("grok"));

  test("the pane is launched with --rules carrying the brief", async ({ window, seeded }) => {
    void window;
    const { args } = await paneLaunch(seeded);
    const flag = args.indexOf("--rules");
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(args[flag + 1]).toContain("aya capabilities");
    expect(args).toHaveLength(flag + 2);
  });
});

test.describe("opencode preset with the brief on", () => {
  test.use(fakeAgent("opencode"));

  test("the pane gets OPENCODE_CONFIG_CONTENT naming a brief file in AYA_HOME", async ({
    window,
    seeded,
  }) => {
    void window;
    const { args, opencodeConfigContent } = await paneLaunch(seeded);
    expect(args).not.toContain("--rules");
    const { instructions } = JSON.parse(opencodeConfigContent);
    expect(instructions).toEqual([join(seeded.ayaHome, "agent-brief.md")]);
    expect(readFileSync(instructions[0], "utf8")).toContain("aya capabilities");
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

  const save = (agentBrief: boolean, configDir = home) =>
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
      { configDir, agentBrief },
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

  // An AGENTS.md that Aya created for the section alone is deleted with it.
  const bareMd = join(seeded.root, "codex-bare-home", "AGENTS.md");
  await save(true, join(seeded.root, "codex-bare-home"));
  expect(existsSync(bareMd)).toBe(true);
  await save(false, join(seeded.root, "codex-bare-home"));
  expect(existsSync(bareMd)).toBe(false);
});
