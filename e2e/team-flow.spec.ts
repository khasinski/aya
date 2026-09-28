// Flow preview in Define team: the graph follows the Sends to checkboxes live;
// "Explain flow" asks a fake OpenAI-compatible model what the text sends.

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
        routes: [
          { from: "reviewer", to: "implementer", carries: "findings to fix" },
          { from: "implementer", to: "reviewer", carries: "unclear" },
        ],
        unlisted: [{ from: "tester", to: "implementer", carries: "bug steps" }],
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => server.close());
test.beforeEach(() => {
  lastPrompt = "";
});

async function editor(window: Page) {
  await expect(window.getByTestId("xterm-host").first()).toBeVisible();
  await window.evaluate((c) => localStorage.setItem("aya:intelligence", JSON.stringify(c)), {
    provider: "openai",
    openAiBaseUrl: baseUrl,
    openAiModel: "fake",
  });
  await window.reload();
  await expect(window.getByTestId("xterm-host").first()).toBeVisible();
  await window.getByTestId("teams-toggle").click();
  const dialog = window.getByRole("dialog", { name: "Teams" });
  await dialog.getByRole("button", { name: "New team" }).click();
  return dialog;
}

test("the flow graph and routes follow the Sends to checkboxes as you tick them", async ({ window }) => {
  const dialog = await editor(window);
  const routes = dialog.getByLabel("Flow routes");
  await expect(routes).toContainText("reviewer → implementer");
  await expect(routes).toContainText("implementer → reviewer");
  await expect(dialog.getByRole("img", { name: /Team flow: reviewer to implementer, implementer to reviewer/ })).toBeVisible();
  await dialog.getByLabel("Role 2 sends to reviewer").uncheck();
  await expect(routes).not.toContainText("implementer → reviewer");
  await expect(dialog.getByRole("img", { name: "Team flow: reviewer to implementer" })).toBeVisible();
});

test("Explain flow labels each route from the text and warns about a route the text has but no box allows", async ({ window }) => {
  const dialog = await editor(window);
  await dialog.getByRole("button", { name: "Add role" }).click();
  await dialog.getByLabel("Role 3 name").fill("tester");
  await dialog.getByLabel("Role 3 sends to reviewer").check();
  await dialog.getByLabel("Role 3 responsibilities").fill("Reports each bug to the implementer with steps.");
  await dialog.getByRole("button", { name: "Explain flow" }).click();
  const routes = dialog.getByLabel("Flow routes");
  await expect(routes).toContainText("reviewer → implementer: findings to fix");
  await expect(routes).toContainText("implementer → reviewer: not described in the text");
  await expect(routes).toContainText("tester → reviewer: not described in the text");
  const unlisted = dialog.locator(".aya-teams-warning", { hasText: "bug steps" });
  await expect(unlisted).toHaveText("The text has tester → implementer (bug steps), but tester does not send to implementer. Tick it, or change the text.");
  expect(lastPrompt).toContain("- tester -> reviewer");
  expect(lastPrompt).toContain("Reports each bug to the implementer with steps.");
  await dialog.getByLabel("Protocol").fill("The tester talks to everyone.");
  await expect(dialog.getByText("Edited since the explanation; explain again.")).toBeVisible();
  await expect(routes).not.toContainText("findings to fix");
  await expect(unlisted).toHaveCount(0);
});

test("a role nobody sends to, or that sends to nobody, is flagged without asking the model", async ({ window }) => {
  const dialog = await editor(window);
  await dialog.getByRole("button", { name: "Add role" }).click();
  await dialog.getByLabel("Role 3 name").fill("tester");
  await dialog.getByLabel("Round role").selectOption("implementer");
  // team1 as saved by hand: reviewer -> tester, implementer -> reviewer, tester -> reviewer.
  await dialog.getByLabel("Role 1 sends to implementer").uncheck();
  await dialog.getByLabel("Role 1 sends to tester").check();
  await dialog.getByLabel("Role 3 sends to reviewer").check();
  const warnings = dialog.locator(".aya-teams-flow .aya-teams-warning");
  await expect(warnings).toHaveText(["Nobody sends to implementer; it only gets Aya's rounds."]);
  await dialog.getByLabel("Role 3 sends to reviewer").uncheck();
  await expect(warnings).toContainText(["tester sends to nobody, so its work reaches no one."]);
  expect(lastPrompt).toBe("");
});
