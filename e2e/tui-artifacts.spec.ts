// aya present: an artifact for a TUI pane opens in its own window, an update reloads that window in place.
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const AYA = resolve("bin/aya");
const run = promisify(execFile);

const previews = (app: ElectronApplication): Page[] => app.windows().filter((w) => w.url().startsWith("data:text/html"));
const previewTitled = (app: ElectronApplication, title: string): Page | undefined =>
  previews(app).find((w) => decodeURIComponent(w.url()).includes(`<title>${title}</title>`));

test("aya present opens a table window, updates it in place and lists it", async ({ app, seeded }) => {
  await (await app.firstWindow()).waitForLoadState("domcontentloaded");
  const env = { ...process.env, AYA_SOCKET: join(seeded.ayaHome, "aya.sock"), AYA_HOME: seeded.ayaHome, AYA_TERMINAL_ID: "", AYA_PRESET_ID: "" };
  const aya = (...args: string[]) => run(AYA, args, { env }).then((r) => r.stdout);
  const table = join(seeded.ayaHome, "table.json");

  writeFileSync(table, JSON.stringify({ columns: ["Team", "Score"], rows: [["Red", "3"], ["Blue", "5"]] }));
  const created = await aya("present", "--title", "Quarterly", "--table", table);
  const id = /artifact (\S+) /.exec(created)?.[1];
  expect(id).toBeTruthy();
  await expect.poll(() => Boolean(previewTitled(app, "Quarterly"))).toBe(true);
  const page = previewTitled(app, "Quarterly")!;
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.locator("td", { hasText: "Blue" })).toBeVisible();
  const before = previews(app).length;

  // The same id: same window, new content, revision 2.
  writeFileSync(table, JSON.stringify({ columns: ["Team", "Score"], rows: [["Red", "3"], ["Blue", "5"], ["Green", "9"]] }));
  expect(await aya("present", "--title", "Quarterly", "--table", table, "--id", id!)).toMatch(/updated artifact .* \(r2\)/);
  await expect(page.locator("tbody tr")).toHaveCount(3);
  await expect(page.locator("header small")).toContainText("r2");
  expect(previews(app).length).toBe(before);

  // A metric stored without a window is listed, and opens on request.
  await aya("present", "--title", "Users", "--metric", "1204", "--description", "active today", "--no-open");
  expect(previewTitled(app, "Users")).toBeUndefined();
  const listing = await aya("artifact", "list");
  expect(listing).toMatch(/metric {2}r1 {2}Users/);
  expect(listing).toMatch(/table {2}r2 {2}Quarterly/);
  const metricId = /^(\S+) {2}metric/m.exec(listing)![1];
  await aya("artifact", "open", metricId);
  await expect.poll(() => Boolean(previewTitled(app, "Users"))).toBe(true);
  await expect(previewTitled(app, "Users")!.locator(".metric b")).toHaveText("1204");

  // Mistakes are refused with a reason and open nothing.
  await expect(aya("present", "--title", "Bad", "--table", table, "--id", "nope")).rejects.toMatchObject({ stderr: expect.stringContaining('no artifact "nope"') });
});

test("aya present shows an HTML widget in the isolated frame", async ({ app, seeded }) => {
  await (await app.firstWindow()).waitForLoadState("domcontentloaded");
  const env = { ...process.env, AYA_SOCKET: join(seeded.ayaHome, "aya.sock"), AYA_HOME: seeded.ayaHome, AYA_TERMINAL_ID: "", AYA_PRESET_ID: "" };
  const file = join(seeded.ayaHome, "w.html");
  writeFileSync(file, "<h1 id='x'>widget ok</h1>");
  await run(AYA, ["present", "--title", "Widget", "--html", file], { env });
  await expect.poll(() => Boolean(previewTitled(app, "Widget"))).toBe(true);
  const page = previewTitled(app, "Widget")!;
  await expect(page.locator("iframe")).toHaveAttribute("src", /^aya-widget:\/\/preview\//);
  await expect(page.frameLocator("iframe").locator("#x")).toHaveText("widget ok");
});
