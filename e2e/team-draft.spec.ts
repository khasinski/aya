// "Draft" in Define team asks Aya Intelligence for a role's fields. A fake
// OpenAI-compatible server stands in for the model.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

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

async function editorWithIntelligence(window: Page, config: Record<string, string>) {
  await expect(window.getByTestId("xterm-host").first()).toBeVisible();
  await window.evaluate((c) => localStorage.setItem("aya:intelligence", JSON.stringify(c)), config);
  await window.reload();
  await expect(window.getByTestId("xterm-host").first()).toBeVisible();
  await window.getByTestId("teams-toggle").click();
  const dialog = window.getByRole("dialog", { name: "Teams" });
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

test("with Apple Intelligence, Draft says which providers can do it", async ({ window }) => {
  const dialog = await editorWithIntelligence(window, { provider: "apple" });
  await dialog.getByRole("button", { name: "Draft role 1" }).click();
  await expect(dialog.getByText(/needs Ollama or an OpenAI-compatible model/)).toBeVisible();
});
