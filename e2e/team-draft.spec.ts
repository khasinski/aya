// "Draft" in Define team asks Aya Intelligence for a role's fields. A fake
// OpenAI-compatible server stands in for the model.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { openTeams } from "./helpers/team";
import { AYA_INTELLIGENCE_STORAGE_KEY } from "../src/storage-keys";

let server: Server;
let baseUrl = "";
let lastPrompt = "";

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastPrompt = JSON.parse(body).messages.at(-1).content;
      const content = JSON.stringify({
        responsibilities: "Plays each build like a first-time player and reports what confused them.",
        mustNot: "edit code",
        sendsTo: ["implementer", "stranger"],
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => server.close());

/** `config` null: nothing chosen in Settings, so Aya's default provider. */
async function editorWithIntelligence(window: Page, config: Record<string, string> | null) {
  await expect(window.getByTestId("xterm-host").first()).toBeVisible();
  await window.evaluate(
    ({ k, c }) => (c ? localStorage.setItem(k, JSON.stringify(c)) : localStorage.removeItem(k)),
    { k: AYA_INTELLIGENCE_STORAGE_KEY, c: config },
  );
  await window.reload();
  const dialog = await openTeams(window);
  await dialog.getByRole("button", { name: "New team" }).click();
  await dialog.getByLabel("Role 1 name").fill("senior UX game designer");
  await expect(dialog.getByLabel("Role 1 name")).toHaveValue("senior-ux-game-designer");
  return dialog;
}

test("Draft fills a role from its name; targets outside the team are dropped", async ({ window }) => {
  const dialog = await editorWithIntelligence(window, { provider: "openai", openAiBaseUrl: baseUrl, openAiModel: "fake" });
  await dialog.getByRole("button", { name: "Draft role 1" }).click();
  await expect(dialog.getByLabel("Role 1 responsibilities")).toHaveValue(/first-time player/);
  await expect(dialog.getByLabel("Role 1 must not")).toHaveValue("edit code");
  await expect(dialog.getByLabel("Role 1 sends to implementer")).toBeChecked();
  expect(lastPrompt).toMatch(/"senior ux game designer"/);
  await dialog.getByLabel("Team name").fill("design-review");
  await dialog.getByRole("button", { name: "Save team" }).click();
  await expect(dialog.getByTestId("team-design-review")).toContainText("senior-ux-game-designer");
});

test("a provider that does not answer shows the reason next to the role", async ({ window }) => {
  const dialog = await editorWithIntelligence(window, { provider: "openai", openAiBaseUrl: "http://127.0.0.1:9", openAiModel: "fake" });
  await dialog.getByRole("button", { name: "Draft role 1" }).click();
  await expect(dialog.locator(".aya-teams-role").first().locator(".aya-teams-error")).toContainText(/did not answer/);
});

test("roles ticked under Sends to before Draft stay ticked and reach the prompt", async ({ window }) => {
  const dialog = await editorWithIntelligence(window, { provider: "openai", openAiBaseUrl: baseUrl, openAiModel: "fake" });
  await dialog.getByRole("button", { name: "Add role" }).click();
  await dialog.getByLabel("Role 3 name").fill("tester");
  await dialog.getByLabel("Role 1 sends to implementer").uncheck();
  await dialog.getByLabel("Role 1 sends to tester").check();
  await dialog.getByRole("button", { name: "Draft role 1" }).click();
  await expect(dialog.getByLabel("Role 1 must not")).toHaveValue("edit code");
  await expect(dialog.getByLabel("Role 1 sends to tester")).toBeChecked();
  await expect(dialog.getByLabel("Role 1 sends to implementer")).not.toBeChecked();
  expect(lastPrompt).toMatch(/It sends to: tester\./);
});

test("a Must not line typed into Responsibilities is refused, not read back as the field", async ({ window, seeded }) => {
  const dialog = await editorWithIntelligence(window, null);
  await dialog.getByLabel("Team name").fill("design-review");
  await dialog.getByLabel("Role 1 responsibilities").fill("Plays each build.\nMust not: push to main");
  await dialog.getByRole("button", { name: "Save team" }).click();
  await expect(dialog.locator(".aya-teams-error").last()).toContainText(/senior-ux-game-designer.*Must not/);
  expect(existsSync(join(seeded.projectDir, ".aya", "teams", "design-review.md"))).toBe(false);
});

// Apple Intelligence runs through the bundled Swift helper; a script stands in,
// answering after a pause like the on-device model (13-44 s measured).
function appleHelper(name: string, reply: Record<string, unknown>): string {
  const file = join(tmpdir(), `aya-e2e-${name}-${process.pid}`);
  const log = `${file}.request`;
  writeFileSync(
    file,
    `#!${process.execPath}\nlet s="";process.stdin.on("data",c=>s+=c).on("end",()=>{require("fs").writeFileSync(${JSON.stringify(log)},s);setTimeout(()=>process.stdout.write(${JSON.stringify(JSON.stringify(reply))}),1500);});\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

const APPLE_DRAFT = JSON.stringify({ responsibilities: "Reviews each screen for a first-time player.", mustNot: "edit code", sendsTo: ["implementer"] });
const appleOk = appleHelper("apple-ok", { available: true, text: "```json\n" + APPLE_DRAFT + "\n```", error: null });
const appleDown = appleHelper("apple-down", { available: false, text: "", error: "model not ready" });

test.describe("with Apple Intelligence", () => {
  test.use({ seedOptions: { launchEnv: { AYA_E2E_APPLE_HELPER: appleOk } } });

  for (const [label, config] of [
    ["chosen in Settings", { provider: "apple" }],
    ["as the default, with nothing chosen", null],
  ] as const) {
    test(`Draft asks the Apple helper ${label}, says it may take a minute, and fills the role`, async ({ window, seeded }) => {
      const dialog = await editorWithIntelligence(window, config);
      await dialog.getByRole("button", { name: "Draft role 1" }).click();
      await expect(dialog.getByRole("button", { name: "Draft role 1" })).toHaveText(/up to a minute/);
      await expect(dialog.getByLabel("Role 1 must not")).toHaveValue("edit code");
      await expect(dialog.getByLabel("Role 1 responsibilities")).toHaveValue(/first-time player/);
      await expect(dialog.getByRole("button", { name: "Draft role 1" })).toHaveText(/Draft$/);
      const sent = JSON.parse(readFileSync(`${appleOk}.request`, "utf8"));
      expect(sent.kind).toBe("chat");
      expect(sent.prompt).toMatch(/"senior ux game designer"/);
      await dialog.getByLabel("Team name").fill("design-review");
      await dialog.getByRole("button", { name: "Save team" }).click();
      await expect(dialog.getByTestId("team-design-review")).toBeVisible();
      const saved = readFileSync(join(seeded.projectDir, ".aya", "teams", "design-review.md"), "utf8");
      expect(saved).toMatch(/## Role: senior-ux-game-designer\nSends to: implementer \(findings with the screen state as proof\)\nMust not: edit code\nReviews each screen/);
    });
  }
});

test.describe("with Apple Intelligence not ready", () => {
  test.use({ seedOptions: { launchEnv: { AYA_E2E_APPLE_HELPER: appleDown } } });

  test("the helper's reason shows next to the role, and the fields stay as they were", async ({ window }) => {
    const dialog = await editorWithIntelligence(window, { provider: "apple" });
    const before = await dialog.getByLabel("Role 1 must not").inputValue();
    await dialog.getByRole("button", { name: "Draft role 1" }).click();
    await expect(dialog.locator(".aya-teams-role").first().locator(".aya-teams-error")).toContainText("model not ready");
    await expect(dialog.getByLabel("Role 1 must not")).toHaveValue(before);
  });
});

test("drafting a role shows the model what the other roles already do", async ({ window }) => {
  const dialog = await editorWithIntelligence(window, { provider: "openai", openAiBaseUrl: baseUrl, openAiModel: "fake" });
  const reviewer = await dialog.getByLabel("Role 1 responsibilities").inputValue();
  await dialog.getByRole("button", { name: "Draft role 2" }).click();
  await expect(dialog.getByLabel("Role 2 must not")).toHaveValue("edit code");
  expect(lastPrompt).toContain(`- senior-ux-game-designer: ${reviewer}`);
  expect(lastPrompt).not.toMatch(/^- implementer:/m);
});
