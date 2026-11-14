import { createHash } from "node:crypto";
import { copyFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test as base, expect, launchApp, closeAndWait } from "./fixtures";
import type { Page, Locator } from "@playwright/test";
import { fireShortcut } from "./helpers/shortcut";

const test = base.extend<{ planHistory: boolean; toolCount: number }>({
  planHistory: [false, { option: true }],
  toolCount: [40, { option: true }],
  app: async ({ seeded, planHistory, toolCount }, use) => {
    const bin = join(seeded.root, "gui-bin"); mkdirSync(bin);
    copyFileSync(resolve("tests/helpers/fake-codex-gui.cjs"), join(bin, "codex"));
    chmodSync(join(bin, "codex"), 0o755);
    seeded.launchEnv = { AYA_E2E_CODEX_BIN: join(bin, "codex") };
    const history = join(seeded.ayaHome, "conversations"); mkdirSync(history, { recursive: true });
    const name = createHash("sha256").update(seeded.tabIds.left).digest("hex") + ".json";
    writeFileSync(join(history, name), JSON.stringify({ cwd: seeded.projectDir, agent: "codex", view: {
      messages: Array.from({ length: 40 }, (_, i) => ({ id: `old-${i}`, type: "assistant", ...(planHistory && i === 39
        ? { kind: "plan", text: Array.from({ length: 60 }, (_, j) => `${j + 1}. Plan step ${String(j + 1).padStart(2, "0")}: Make the requested change.`).join("\n") }
        : { text: `Earlier answer ${i}. ` + "A long conversation with enough history to scroll through. ".repeat(20) }) })),
      activities: Array.from({ length: toolCount }, (_, i) => ({ id: `tool-${i}`, label: `Earlier tool ${i}`, status: "completed", output: "Output line\n".repeat(100), kind: "command" })),
      turnOutcome: "complete",
    } }));
    const app = await launchApp(seeded);
    try { await use(app); } finally { await closeAndWait(app); }
  },
});

test.use({ seedOptions: {
  singleTab: { presetId: "gui", name: "Codex GUI" },
  presetList: [{ id: "gui", name: "Codex GUI", icon: "◆", color: "", command: "codex", agent: "codex", interfaceMode: "gui" }],
} });

for (const pixels of [1, 12, 40]) {
  test(`a gentle ${pixels}px upward wheel stops following a streaming conversation`, async ({ window }) => {
    const { gui, viewport, gap } = await readyHistory(window);
    await gui.getByRole("textbox", { name: "Message Codex" }).fill("long-stream");
    await gui.getByRole("textbox", { name: "Message Codex" }).press("Enter");
    await expect(gui.locator("article.assistant").last()).toContainText("Paragraph 1:");
    await wheel(window, viewport, -pixels);
    await expect(gui.getByRole("button", { name: "Jump to latest" })).toBeVisible({ timeout: 1500 });
    const top = await viewport.evaluate(node => node.scrollTop);
    await expect(gui.getByRole("status", { name: "Turn status" })).toHaveText("Turn complete");
    expect(await viewport.evaluate(node => node.scrollTop)).toBeCloseTo(top, 0);
    expect(await gap()).toBeGreaterThan(80);
    await gui.getByRole("button", { name: "Jump to latest" }).click();
    await expect.poll(gap).toBeLessThanOrEqual(1);
    await expect(gui.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  });
}

async function readyHistory(window: Page) {
  await window.setViewportSize({ width: 1000, height: 650 });
  const gui = window.locator(".aya-conversation");
  const viewport = gui.getByLabel("Conversation with Codex", { exact: true });
  const gap = () => viewport.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop);
  await expect(gui.locator("header").getByRole("status")).toHaveText("Ready");
  await expect(gui.locator("article.assistant")).toHaveCount(40);
  await window.evaluate(() => document.fonts.ready);
  await painted(window);
  const jump = gui.getByRole("button", { name: "Jump to latest" });
  if (await jump.isVisible()) await jump.click();
  await expect.poll(gap).toBeLessThanOrEqual(1);
  return { gui, viewport, gap };
}

async function wheel(window: Page, viewport: Locator, pixels: number) {
  const rect = (await viewport.boundingBox())!;
  await window.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await window.mouse.wheel(0, pixels);
}

const painted = (window: Page) => window.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test("a gentle idle scroll remains detached when the window shrinks", async ({ window }) => {
  const { gui, viewport, gap } = await readyHistory(window);
  await wheel(window, viewport, -12);
  await expect(gui.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  const top = await viewport.evaluate(node => node.scrollTop);
  await window.setViewportSize({ width: 1000, height: 550 });
  await painted(window);
  expect(await viewport.evaluate(node => node.scrollTop)).toBeCloseTo(top, 0);
  expect(await gap()).toBeGreaterThan(80);
  await expect(gui.getByRole("button", { name: "Jump to latest" })).toBeVisible();
});

test("following survives browser clamping after the window grows", async ({ window }) => {
  const { gui, gap } = await readyHistory(window);
  await window.setViewportSize({ width: 1000, height: 750 });
  await painted(window);
  await expect.poll(gap).toBeLessThanOrEqual(1);
  await expect(gui.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await gui.getByRole("textbox", { name: "Message Codex" }).fill("long-stream");
  await gui.getByRole("textbox", { name: "Message Codex" }).press("Enter");
  await expect(gui.getByRole("status", { name: "Turn status" })).toHaveText("Turn complete");
  await expect.poll(gap).toBeLessThanOrEqual(1);
});

test("scrolling back down resumes following subsequent streamed text", async ({ window }) => {
  const { gui, viewport, gap } = await readyHistory(window);
  await gui.getByRole("textbox", { name: "Message Codex" }).fill("long-stream");
  await gui.getByRole("textbox", { name: "Message Codex" }).press("Enter");
  await expect(gui.locator("article.assistant").last()).toContainText("Paragraph 1:");
  await wheel(window, viewport, -12);
  await expect(gui.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  await wheel(window, viewport, 100000);
  await expect(gui.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await expect(gui.getByRole("status", { name: "Turn status" })).toHaveText("Turn complete");
  await expect.poll(gap).toBeLessThanOrEqual(1);
});

test("scrolling nested tool results does not detach the conversation", async ({ window }) => {
  const { gui, gap } = await readyHistory(window);
  await gui.getByLabel("Tool activity", { exact: true }).click();
  const tools = gui.getByRole("region", { name: "Tool activity details" });
  await expect(tools).toBeVisible();
  await tools.focus();
  await window.keyboard.press("End");
  // Chromium animates keyboard scrolling; measure the wheel only after End finishes.
  await expect.poll(() => tools.evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop)).toBeLessThanOrEqual(1);
  await painted(window);
  // Focusing a nested region may scroll the outer viewport to reveal it.
  // Explicitly resume following before testing the nested wheel gesture.
  const jump = gui.getByRole("button", { name: "Jump to latest" });
  if (await jump.isVisible()) await jump.click();
  await expect.poll(gap).toBeLessThanOrEqual(1);
  const before = await tools.evaluate(node => node.scrollTop);
  await wheel(window, tools, -12);
  await expect.poll(() => tools.evaluate(node => node.scrollTop)).toBeLessThan(before);
  await expect(gui.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await window.setViewportSize({ width: 1000, height: 550 });
  await painted(window);
  await expect.poll(gap).toBeLessThanOrEqual(1);
  await expect(gui.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
});

for (const streaming of [false, true]) {
  test(`End after clicking answer text resumes following ${streaming ? "during a stream" : "while idle"}`, async ({ window }) => {
    const { gui, viewport, gap } = await readyHistory(window);
    if (streaming) {
      const prompt = gui.getByRole("textbox", { name: "Message Codex" });
      await prompt.fill("long-stream"); await prompt.press("Enter");
      await expect(gui.locator("article.assistant").last()).toContainText("Paragraph 1:");
    }
    await wheel(window, viewport, -120);
    await expect(gui.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    const rect = (await viewport.boundingBox())!;
    // Exercise a real click on answer text, rather than focusing the scroller
    // from the test: this is the path that used to leave keydown on BODY.
    await window.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await window.keyboard.press("End");
    await expect.poll(gap).toBeLessThanOrEqual(1);
    await expect(gui.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
    if (streaming) {
      await expect(gui.getByRole("status", { name: "Turn status" })).toHaveText("Turn complete");
      await expect.poll(gap).toBeLessThanOrEqual(1);
    }
  });
}

test("find highlights update without undoing manual scrolling during a stream", async ({ window, app }) => {
  const { gui, viewport } = await readyHistory(window);
  const prompt = gui.getByRole("textbox", { name: "Message Codex" });
  await prompt.fill("long-stream"); await prompt.press("Enter");
  await expect(gui.locator("article.assistant").last()).toContainText("Paragraph 1:");
  await fireShortcut(app, "find-in-pane");
  await gui.getByRole("searchbox", { name: "Find in conversation" }).fill("Earlier answer 10.");
  await expect(gui.getByRole("status", { name: "Find results" })).toContainText("1 of 1");
  await painted(window);
  const before = await viewport.evaluate(node => node.scrollTop);
  await wheel(window, viewport, -120);
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeLessThan(before - 50);
  const readingTop = await viewport.evaluate(node => node.scrollTop);
  await expect(gui.getByRole("status", { name: "Turn status" })).toHaveText("Turn complete");
  expect(await viewport.evaluate(node => node.scrollTop)).toBeCloseTo(readingTop, 0);
  expect(await window.evaluate(() => CSS.highlights.get("aya-find-current")?.size)).toBe(1);
});

test("find still navigates after manual scrolling and query changes", async ({ window, app }) => {
  const { gui, viewport } = await readyHistory(window);
  await fireShortcut(app, "find-in-pane");
  const find = gui.getByRole("searchbox", { name: "Find in conversation" });
  const results = gui.getByRole("status", { name: "Find results" });
  await find.fill("Earlier answer 10.");
  await expect(results).toHaveText("1 of 1");
  await painted(window);
  const firstTop = await viewport.evaluate(node => node.scrollTop);
  await find.fill("Earlier answer 20.");
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeGreaterThan(firstTop + 100);
  await find.fill("Earlier answer");
  await expect(results).toHaveText("1 of 40");
  await painted(window);
  const firstMatchTop = await viewport.evaluate(node => node.scrollTop);
  await wheel(window, viewport, 600);
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeGreaterThan(500);
  const readingTop = await viewport.evaluate(node => node.scrollTop);
  await find.press("Enter");
  await expect(results).toHaveText("2 of 40");
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeLessThan(readingTop);
  await find.press("Shift+Enter");
  await expect(results).toHaveText("1 of 40");
  await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeCloseTo(firstMatchTop, 0);
  await find.press("Escape");
  await expect(find).toHaveCount(0);
  expect(await window.evaluate(() => CSS.highlights.size)).toBe(0);
});

test("an empty or unmatched search keeps following streamed text", async ({ window, app }) => {
  const { gui, gap } = await readyHistory(window);
  const prompt = gui.getByRole("textbox", { name: "Message Codex" });
  await prompt.fill("long-stream"); await prompt.press("Enter");
  await expect(gui.locator("article.assistant").last()).toContainText("Paragraph 1:");
  await fireShortcut(app, "find-in-pane");
  const find = gui.getByRole("searchbox", { name: "Find in conversation" });
  await expect(gui.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  await find.fill("no-such-match-in-the-history");
  await expect(gui.getByRole("status", { name: "Find results" })).toHaveText("No results");
  await expect(gui.getByRole("status", { name: "Turn status" })).toHaveText("Turn complete");
  await expect.poll(gap).toBeLessThanOrEqual(1);
  await expect(gui.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
});

for (const readingHistory of [false, true]) {
  test(`a first match arriving in the stream preserves ${readingHistory ? "manual reading" : "automatic following"}`, async ({ window, app }) => {
    const { gui, viewport, gap } = await readyHistory(window);
    const prompt = gui.getByRole("textbox", { name: "Message Codex" });
    await prompt.fill("long-stream"); await prompt.press("Enter");
    await expect(gui.locator("article.assistant").last()).toContainText("Paragraph 1:");
    await fireShortcut(app, "find-in-pane");
    await gui.getByRole("searchbox", { name: "Find in conversation" }).fill("Paragraph 60:");
    await expect(gui.getByRole("status", { name: "Find results" })).toHaveText("No results");
    if (readingHistory) {
      await wheel(window, viewport, -120);
      await expect(gui.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    }
    const readingTop = await viewport.evaluate(node => node.scrollTop);
    await expect(gui.getByRole("status", { name: "Turn status" })).toHaveText("Turn complete");
    await expect(gui.getByRole("status", { name: "Find results" })).toHaveText("1 of 1");
    if (readingHistory) expect(await viewport.evaluate(node => node.scrollTop)).toBeCloseTo(readingTop, 0);
    else {
      await expect.poll(gap).toBeLessThanOrEqual(1);
      await expect(gui.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
    }
  });
}

test("find can return to its only match after manual scrolling", async ({ window, app }) => {
  const { gui, viewport } = await readyHistory(window);
  await fireShortcut(app, "find-in-pane");
  const find = gui.getByRole("searchbox", { name: "Find in conversation" });
  await find.fill("Earlier answer 10.");
  await expect(gui.getByRole("status", { name: "Find results" })).toHaveText("1 of 1");
  await painted(window);
  const matchTop = await viewport.evaluate(node => node.scrollTop);
  for (const action of [() => find.press("Enter"), () => gui.getByRole("button", { name: "Next match" }).click(), () => gui.getByRole("button", { name: "Previous match" }).click()]) {
    await wheel(window, viewport, -120);
    await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeLessThan(matchTop - 50);
    await action();
    await expect.poll(() => viewport.evaluate(node => node.scrollTop)).toBeCloseTo(matchTop, 0);
  }
});

test.describe("short tool output", () => {
  test.use({ toolCount: 2 });
  test("a contained list without overflow does not detach conversation following", async ({ window }) => {
    const { gui, viewport, gap } = await readyHistory(window);
    await gui.getByLabel("Tool activity", { exact: true }).click();
    const jump = gui.getByRole("button", { name: "Jump to latest" });
    if (await jump.isVisible()) await jump.click();
    await expect.poll(gap).toBeLessThanOrEqual(1);
    const tools = gui.getByRole("region", { name: "Tool activity details" });
    expect(await tools.evaluate(node => node.scrollHeight - node.clientHeight)).toBe(0);
    const top = await viewport.evaluate(node => node.scrollTop);
    await wheel(window, tools, -12);
    await painted(window);
    expect(await viewport.evaluate(node => node.scrollTop)).toBeCloseTo(top, 0);
    await expect(jump).toHaveCount(0);
    await window.setViewportSize({ width: 1000, height: 550 });
    await expect.poll(gap).toBeLessThanOrEqual(1);
  });
});

test.describe("long proposed plan", () => {
  test.use({ planHistory: true });
  test("expansion keeps the first newly revealed step visible", async ({ window }) => {
    const { gui, viewport } = await readyHistory(window);
    await gui.getByRole("button", { name: "Show all", exact: true }).click();
    await expect(gui.getByRole("button", { name: "Show less", exact: true })).toBeVisible();
    await painted(window);
    const rect = (await viewport.boundingBox())!;
    const step = (await gui.getByText("Plan step 11: Make the requested change.", { exact: true }).boundingBox())!;
    expect(step.y).toBeGreaterThanOrEqual(rect.y);
    expect(step.y + step.height).toBeLessThanOrEqual(rect.y + rect.height);
    await expect(gui.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    await gui.getByRole("button", { name: "Jump to latest" }).click();
    await expect(gui.getByRole("button", { name: "Jump to latest" })).toHaveCount(0);
  });
});
