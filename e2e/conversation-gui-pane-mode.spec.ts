// Terminal ⇄ Conversation: one Claude pane switches both ways in place and every switch resumes the same session.
// The terminal is e2e/helpers/fake-claude.cjs (it logs each launch's arguments and saves a transcript like Claude),
// the Conversation is tests/helpers/fake-claude-gui.cjs with its launch log on.

import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { closeAndWait, expect, launchApp, test } from "./fixtures";
import { agentBin } from "./helpers/agent-bin";
import { seedEnv } from "./helpers/seed";
import { fireShortcut } from "./helpers/shortcut";
import { SLOW_EXPECT_TIMEOUT_MS } from "./timeouts";

const FAKE_CLAUDE = agentBin("claude", join(__dirname, "helpers", "fake-claude.cjs"));
const FAKE_CODEX = agentBin("codex", join(__dirname, "helpers", "fake-codex.cjs"));

function seedClaudePane() {
  const seed = seedEnv({
    singleTab: { presetId: "claude", name: "Claude" },
    presetList: [{
      // No auto-resume: the seeded tab starts fresh (--session-id), and a switch resumes all the same.
      id: "claude", name: "Claude", icon: "✻", color: "", agent: "claude", configDir: "~/claude-config", autoResume: false,
      command: `CLAUDE_CONFIG_DIR="$HOME/claude-config" ${FAKE_CLAUDE} "$AYA_PROJECT_DIR/claude-$AYA_TERMINAL_ID.jsonl"`,
    }],
  });
  const bin = join(seed.root, "gui-bin"); mkdirSync(bin);
  copyFileSync(resolve("tests/helpers/fake-claude-gui.cjs"), join(bin, "claude")); chmodSync(join(bin, "claude"), 0o755);
  const guiLog = join(seed.root, "gui-launches.jsonl");
  seed.launchEnv = { ...seed.launchEnv, AYA_E2E_CLAUDE_BIN: join(bin, "claude"), AYA_FAKE_CLAUDE_LAUNCH_LOG: guiLog };
  const lines = (file: string) => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const terminalLaunches = () => lines(join(seed.projectDir, `claude-${seed.tabIds.left}.jsonl`)) as { args: string[]; sessionId: string | null }[];
  const guiLaunches = () => lines(guiLog) as { args: string[] }[];
  const savedTab = () => (JSON.parse(readFileSync(join(seed.ayaHome, "projects", "e2e-proj.json"), "utf8")).tabs as { id: string; presetId: string; interfaceMode?: string; sessionId?: string }[])[0];
  const transcript = (sessionId: string) => {
    const projects = join(seed.root, "home", "claude-config", "projects");
    for (const dir of readdirSync(projects)) if (existsSync(join(projects, dir, `${sessionId}.jsonl`))) return join(projects, dir, `${sessionId}.jsonl`);
    throw Error(`no transcript for ${sessionId}`);
  };
  return { seed, terminalLaunches, guiLaunches, savedTab, transcript };
}

test("a Claude pane switches terminal → conversation → terminal on the same session, and keeps its mode", async () => {
  const { seed, terminalLaunches, guiLaunches, savedTab, transcript } = seedClaudePane();
  let app = await launchApp(seed);
  try {
    let page = await app.firstWindow();
    const terminal = page.locator('[data-testid="terminal-pane"]:visible');
    await expect.poll(() => terminalLaunches().length, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(1);
    const sessionId = terminalLaunches()[0].sessionId!;
    expect(terminalLaunches()[0].args).toEqual(["--session-id", sessionId]);
    await expect.poll(() => savedTab().sessionId, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(sessionId);
    // What the terminal conversation said, as Claude Code saves it.
    appendFileSync(transcript(sessionId), [
      { type: "user", uuid: "u1", message: { role: "user", content: "Remember the word PELICAN." } },
      { type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "I will remember PELICAN." }] } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");

    // Both modes draw the same header, with the switch in it.
    const header = terminal.locator('header.aya-pane-header[data-pane-mode="terminal"]');
    await expect(header.getByRole("button", { name: "Show as terminal" })).toHaveAttribute("aria-pressed", "true");
    await header.getByRole("button", { name: "Show as conversation" }).click();

    const gui = page.locator(".aya-conversation");
    await expect(gui.locator("header").getByRole("status")).toHaveText("Ready");
    await expect(gui.locator('header[data-pane-mode="gui"]').getByRole("button", { name: "Show as conversation" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-testid="terminal-pane"]:visible')).toHaveCount(0);
    await expect(gui.locator("article.user").first()).toContainText("Remember the word PELICAN.");
    await expect(gui.locator("article.assistant").first()).toContainText("I will remember PELICAN.");
    await expect(gui.locator(".aya-gui-import-notice")).toContainText("Continued the terminal session");
    expect(guiLaunches().at(-1)!.args).toEqual(expect.arrayContaining(["--resume", sessionId]));
    await expect.poll(() => savedTab().interfaceMode).toBe("gui");
    expect(savedTab()).toMatchObject({ presetId: "claude", sessionId });

    // A pending approval holds the switch, with a message; the pane stays a conversation.
    const prompt = gui.getByRole("textbox", { name: "Message Claude" });
    await prompt.fill("approval"); await prompt.press("Enter");
    const approval = gui.getByRole("group", { name: "Approval required" });
    await expect(approval).toBeVisible();
    await gui.getByRole("button", { name: "Show as terminal" }).click();
    await expect(gui.getByRole("alert").filter({ hasText: "Answer the pending approval" })).toBeVisible();
    await expect(gui).toBeVisible();
    await approval.getByRole("button", { name: "Allow once" }).click();
    await expect(gui.getByRole("status", { name: "Turn status" })).toHaveText("Turn complete");

    // ⌘⌥G (View menu): back to the terminal, which resumes the conversation's session.
    await fireShortcut(app, "toggle-pane-mode");
    await expect(page.locator('[data-testid="terminal-pane"]:visible')).toHaveCount(1);
    await expect(gui).toHaveCount(0);
    await expect.poll(() => terminalLaunches().length, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(2);
    expect(terminalLaunches()[1].args).toEqual(["--resume", sessionId]);
    await expect.poll(() => savedTab().interfaceMode).toBe("terminal");

    // The mode survives a restart: switch once more and relaunch.
    await page.locator('[data-testid="terminal-pane"]:visible').getByRole("button", { name: "Show as conversation" }).click();
    await expect(page.locator(".aya-conversation header").getByRole("status")).toHaveText("Ready");
    await expect.poll(() => savedTab().interfaceMode).toBe("gui");
    await closeAndWait(app);
    const launchesBefore = guiLaunches().length;
    app = await launchApp(seed);
    page = await app.firstWindow();
    await expect(page.locator(".aya-conversation header").getByRole("status")).toHaveText("Ready");
    await expect(page.locator(".aya-conversation article.user").first()).toContainText("Remember the word PELICAN.");
    expect(terminalLaunches()).toHaveLength(2);
    expect(guiLaunches().length).toBe(launchesBefore + 1);
    expect(guiLaunches().at(-1)!.args).toEqual(expect.arrayContaining(["--resume", sessionId]));
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test("a Codex pane carries its thread from the terminal to the conversation and back", async () => {
  const seed = seedEnv({
    singleTab: { presetId: "codex", name: "Codex" },
    presetList: [{
      id: "codex", name: "Codex", icon: "◆", color: "", agent: "codex", configDir: "~/codex-home", autoResume: false,
      command: `FAKE_CODEX_STORE=on CODEX_HOME="$HOME/codex-home" ${FAKE_CODEX} "$AYA_PROJECT_DIR/codex-$AYA_TERMINAL_ID.jsonl"`,
    }],
  });
  const bin = join(seed.root, "gui-bin"); mkdirSync(bin);
  copyFileSync(resolve("tests/helpers/fake-codex-gui.cjs"), join(bin, "codex")); chmodSync(join(bin, "codex"), 0o755);
  seed.launchEnv = { ...seed.launchEnv, AYA_E2E_CODEX_BIN: join(bin, "codex") };
  const launchFile = join(seed.projectDir, `codex-${seed.tabIds.left}.jsonl`);
  const launches = () => existsSync(launchFile) ? readFileSync(launchFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; session: string | null }) : [];
  const savedTab = () => JSON.parse(readFileSync(join(seed.ayaHome, "projects", "e2e-proj.json"), "utf8")).tabs[0] as { sessionId?: string; interfaceMode?: string };
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow();
    await expect.poll(() => launches().length, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(1);
    const thread = launches()[0].session!;
    // Aya learns a Codex terminal's thread from Codex's own store.
    await expect.poll(() => savedTab().sessionId, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(thread);
    const day = join(seed.root, "home", "codex-home", "sessions", "2026", "11", "26");
    mkdirSync(day, { recursive: true });
    appendFileSync(join(day, `rollout-2026-11-26T10-00-00-${thread}.jsonl`), [
      { type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", id: "u1", content: [{ type: "text", text: "Remember the word HERON." }] } } },
      { type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage", id: "a1", content: [{ type: "Text", text: "HERON noted." }] } } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");

    await page.locator('[data-testid="terminal-pane"]:visible').getByRole("button", { name: "Show as conversation" }).click();
    const gui = page.locator(".aya-conversation");
    await expect(gui.locator("header").getByRole("status")).toHaveText("Ready");
    await expect(gui.locator("article.user").first()).toContainText("Remember the word HERON.");
    await expect(gui.locator("article.assistant").first()).toContainText("HERON noted.");

    await gui.getByRole("button", { name: "Show as terminal" }).click();
    await expect.poll(() => launches().length, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(2);
    // The conversation resumed the terminal's thread (thread/resume), and the terminal resumes it again.
    expect(launches()[1]).toMatchObject({ args: ["resume", thread], session: thread });
    await expect.poll(() => savedTab().interfaceMode).toBe("terminal");
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test("a pane whose agent has no Conversation has no switch", async () => {
  const seed = seedEnv({ singleTab: { presetId: "shell", name: "Shell" } });
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow();
    const header = page.locator('[data-testid="terminal-pane"]:visible header.aya-pane-header');
    await expect(header).toBeVisible();
    await expect(header.getByRole("group", { name: "Pane mode" })).toHaveCount(0);
    await fireShortcut(app, "toggle-pane-mode");
    await expect(page.locator(".aya-conversation")).toHaveCount(0);
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});

test("Claude and Claude GUI twin presets merge into one, and the GUI pane keeps opening as a conversation", async () => {
  const seed = seedEnv({
    singleTab: { presetId: "claude-gui", name: "Claude GUI" },
    presetList: [
      { id: "claude", name: "Claude", icon: "✻", color: "", command: "claude" },
      { id: "claude-gui", name: "Claude GUI", icon: "✦", color: "", command: "claude", agent: "claude", interfaceMode: "gui" },
      { id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" },
    ],
  });
  const bin = join(seed.root, "gui-bin"); mkdirSync(bin);
  copyFileSync(resolve("tests/helpers/fake-claude-gui.cjs"), join(bin, "claude")); chmodSync(join(bin, "claude"), 0o755);
  seed.launchEnv = { ...seed.launchEnv, AYA_E2E_CLAUDE_BIN: join(bin, "claude") };
  const app = await launchApp(seed);
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".aya-conversation header").getByRole("status")).toHaveText("Ready");
    const presets = JSON.parse(readFileSync(join(seed.ayaHome, "presets.json"), "utf8")).presets as { id: string }[];
    expect(presets.map((p) => p.id)).toEqual(["claude", "shell"]);
    const tab = JSON.parse(readFileSync(join(seed.ayaHome, "projects", "e2e-proj.json"), "utf8")).tabs[0];
    expect(tab).toMatchObject({ presetId: "claude", interfaceMode: "gui", name: "Claude GUI" });
  } finally { await closeAndWait(app); rmSync(seed.root, { recursive: true, force: true }); }
});
