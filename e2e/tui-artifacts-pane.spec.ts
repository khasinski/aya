// A terminal pane's aya present artifacts show in its header ("Artifacts (N)"), open from there, and come back after
// a real quit and relaunch (kept under AYA_HOME/tui-artifacts).
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { launchApp } from "./helpers/relaunch";

const AYA = resolve("bin/aya");
// The pane's own process presents, so the artifact is the pane's; once only, so the relaunch adds nothing.
const SCRIPT = `#!/bin/sh
if [ ! -f presented ]; then
  printf '%s' '{"columns":["Team","Score"],"rows":[["Red","3"],["Blue","5"]]}' > t.json
  ${JSON.stringify(AYA)} present --title Quarterly --table t.json --no-open && touch presented
fi
echo pane-ready
exec sleep 100000
`;

const previewTitled = (app: ElectronApplication, title: string): Page | undefined =>
  app.windows().find((w) => w.url().startsWith("data:text/html") && decodeURIComponent(w.url()).includes(`<title>${title}</title>`));

test.use({
  seedOptions: {
    singleTab: { presetId: "presenter", name: "Presenter" },
    presetList: [{ id: "presenter", name: "Presenter", icon: "◆", color: "", command: "sh present.sh" }],
    projectFiles: { "present.sh": SCRIPT },
  },
});

test("a pane's artifact is listed in its header, opens from there and survives a relaunch", async ({ seeded }) => {
  test.setTimeout(120_000);
  const first = await launchApp(seeded);
  let second: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    const header = first.window.locator(".aya-pane-header");
    // Stored with --no-open, so it arrives unseen.
    const unseen = header.getByRole("button", { name: "Artifacts (1), 1 new" });
    await expect(unseen).toBeVisible({ timeout: 30_000 });
    await expect(unseen).toHaveAttribute("data-unseen", "true");
    await unseen.click();
    const list = first.window.getByRole("dialog", { name: "Artifacts" });
    const row = list.getByRole("button", { name: /Quarterly/ });
    await expect(row).toContainText("Table · r1");
    await expect(header.getByRole("button", { name: "Artifacts (1)", exact: true })).toBeVisible();
    await row.click();
    await expect.poll(() => Boolean(previewTitled(first.app, "Quarterly"))).toBe(true);
    await expect(previewTitled(first.app, "Quarterly")!.locator("tbody tr")).toHaveCount(2);
    const kept = join(seeded.ayaHome, "tui-artifacts");
    await expect.poll(() => existsSync(kept) && readdirSync(kept).length).toBe(1);

    await first.app.close();
    second = await launchApp(seeded);
    const again = second.window.locator(".aya-pane-header").getByRole("button", { name: "Artifacts (1)", exact: true });
    await expect(again).toBeVisible({ timeout: 30_000 });
    await again.click();
    await expect(second.window.getByRole("dialog", { name: "Artifacts" }).getByRole("button", { name: /Quarterly/ })).toContainText("r1");
  } finally {
    await first.app.close().catch(() => undefined);
    await second?.app.close().catch(() => undefined);
  }
});
