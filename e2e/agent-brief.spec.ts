// #117: the brief reaches the agent through its harness's channel, only for
// presets that opt in, on the real launch path.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { AGENT_START_TIMEOUT_MS, AGENT_TEST_TIMEOUT_MS, SLOW_EXPECT_TIMEOUT_MS } from "./timeouts";
import { fireShortcut } from "./helpers/shortcut";
import { teamSeed, IMPLEMENTER_FIRST_TEAM } from "./helpers/team";
import { agentBin, ARGV_DUMP, ARGV_DUMP_FILE } from "./helpers/agent-bin";
import { firstTerminalShown } from "./helpers/terminal";

test.describe.configure({ timeout: AGENT_TEST_TIMEOUT_MS });

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
        command: `${agentBin(agent, ARGV_DUMP)} ${ARGV_DUMP_FILE}`,
      },
    ],
  },
});

async function paneLaunch(seeded: { projectDir: string; tabIds: { right: string } }) {
  const dump = join(seeded.projectDir, `argv-${seeded.tabIds.right}.json`);
  await expect
    .poll(() => existsSync(dump), { message: "the pane never started", timeout: AGENT_START_TIMEOUT_MS })
    .toBe(true);
  return JSON.parse(readFileSync(dump, "utf8"));
}

test.describe("antigravity preset with the brief on", () => {
  test.use({ seedOptions: { ...fakeAgent("antigravity").seedOptions } });

  test("launch writes Aya's always-on rule; turning it off deletes it", async ({
    window,
    seeded,
  }) => {
    const rule = join(seeded.root, "home", ".gemini", "config", "rules", "aya-brief.md");
    await paneLaunch(seeded);
    const content = readFileSync(rule, "utf8");
    expect(content.startsWith("---\ntrigger: always_on\n---\n")).toBe(true);
    expect(content).toContain("aya capabilities");

    await window.evaluate(async () => {
      const presets = await window.aya.listPresets();
      await window.aya.savePresets(presets.map((p) => ({ ...p, agentBrief: false })));
    });
    expect(existsSync(rule)).toBe(false);
  });

  test("deleting the last antigravity preset deletes the rule too", async ({ window, seeded }) => {
    const rule = join(seeded.root, "home", ".gemini", "config", "rules", "aya-brief.md");
    await paneLaunch(seeded);
    expect(existsSync(rule)).toBe(true);
    await window.evaluate(async () => {
      const presets = await window.aya.listPresets();
      await window.aya.savePresets(presets.filter((p) => p.agent !== "antigravity"));
    });
    expect(existsSync(rule)).toBe(false);
  });
});

test.describe("claude preset with the brief on", () => {
  test.use(fakeAgent("claude"));

  test("the pane is launched with --append-system-prompt and can run aya", async ({
    window,
    seeded,
  }) => {
    void window;
    const { args, ayaOnPath, pathEntries } = await paneLaunch(seeded);
    // Two claude panes share the folder, so no --continue; the brief is exactly
    // one argument, then the session id the pane is born with.
    const flag = args.indexOf("--append-system-prompt");
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(args.lastIndexOf("--append-system-prompt")).toBe(flag);
    expect(args[flag + 1]).toContain("aya capabilities");
    expect(args.slice(flag + 2)).toHaveLength(2);
    expect(args[flag + 2]).toBe("--session-id");
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

test.describe("Antigravity added from Suggested", () => {
  test.use({ seedOptions: { fakeBins: ["agy"] } });

  // Suggested harnesses used to be saved as "custom", hiding the toggle.
  test("shows the brief toggle, and opting in writes the rule", async ({ window, app, seeded }) => {
    await fireShortcut(app, "open-settings");
    const settings = window.locator(".aya-modal--settings");
    await settings.getByTestId("settings-tab").filter({ hasText: "Presets" }).click();
    await settings.locator(".aya-settings-suggested-btn", { hasText: "Antigravity" }).click();
    await settings
      .locator(".aya-preset-toggle", { hasText: "Tell the agent about aya" })
      .locator('input[type="checkbox"]')
      .check();
    await settings.locator(".aya-modal-btn--primary", { hasText: "Save" }).click();
    await expect(settings).toBeHidden();
    const rule = join(seeded.root, "home", ".gemini", "config", "rules", "aya-brief.md");
    await expect.poll(() => existsSync(rule)).toBe(true);
    const saved = JSON.parse(readFileSync(join(seeded.ayaHome, "presets.json"), "utf8"))
      .presets.find((p: { command: string }) => p.command === "agy");
    expect(saved).toMatchObject({ agent: "antigravity", autoResume: true, agentBrief: true });
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
    expect(args.slice(flag + 2, flag + 3)).toEqual(["--session-id"]);
    expect(args).toHaveLength(flag + 4);
  });
});

test.describe("opencode preset with the brief on", () => {
  test.use(fakeAgent("opencode"));

  test("the pane gets OPENCODE_CONFIG naming a config file that lists a brief file in AYA_HOME", async ({
    window,
    seeded,
  }) => {
    void window;
    const { args, opencodeConfig, opencodeConfigContent } = await paneLaunch(seeded);
    expect(args).not.toContain("--rules");
    expect(opencodeConfigContent, "the user's own inline config is not touched").toBeNull();
    const { instructions } = JSON.parse(readFileSync(opencodeConfig, "utf8"));
    expect(instructions).toEqual([join(seeded.ayaHome, "agent-brief.md")]);
    expect(readFileSync(instructions[0], "utf8")).toContain("aya capabilities");
  });
});

test("a broken presets.json does not stop a pane from spawning", async ({ window, seeded }) => {
  writeFileSync(join(seeded.ayaHome, "presets.json"), "{");
  const marker = join(seeded.projectDir, "spawned.txt");
  await window.evaluate(
    ({ cwd, marker }) =>
      window.aya.ptySpawn({
        ptyId: "broken-presets",
        presetId: "shell",
        command: `echo ok > '${marker}'`,
        cwd,
        cols: 80,
        rows: 24,
      }),
    { cwd: seeded.projectDir, marker },
  );
  await expect.poll(() => existsSync(marker), { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(true);
});

const teamPane = (agent: string, agentBrief: boolean) =>
  teamSeed(IMPLEMENTER_FIRST_TEAM, { presetList: fakeAgent(agent, agentBrief).seedOptions.presetList, assignments: { tester: "tab-right" } });

test.describe("a claude team pane without the brief opt-in", () => {
  test.use(teamPane("claude", false));

  // A team role turns the brief on for claude and codex; the preset stays opted out.
  test("starts with the brief and its role note, and the preset is not changed", async ({ window, seeded }) => {
    await firstTerminalShown(window);
    const { args } = await paneLaunch(seeded);
    const note = args[args.indexOf("--append-system-prompt") + 1];
    expect(note).toMatch(/aya capabilities[\s\S]*tester in the Aya team ux-review/);
    const saved = JSON.parse(readFileSync(join(seeded.ayaHome, "presets.json"), "utf8")).presets[0];
    expect(saved.agentBrief).toBeUndefined();
  });
});

test.describe("a team pane with the brief on", () => {
  test.use(teamPane("grok", true));

  test("gets the brief and its role note in one flag", async ({ window, seeded }) => {
    await firstTerminalShown(window);
    const { args } = await paneLaunch(seeded);
    const flag = args.indexOf("--rules");
    expect(args.lastIndexOf("--rules")).toBe(flag);
    expect(args[flag + 1]).toMatch(/aya capabilities[\s\S]*tester in the Aya team ux-review/);
  });
});
