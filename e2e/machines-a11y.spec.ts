import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./fixtures";
import { openMachines, seedBase, TWO_MACHINES } from "./helpers/machines";

// WCAG 2.2 A checks for Settings > Machines read from the DOM and the keyboard, never from pixels:
// every control has a name and is reached by Tab, headings do not skip, status is never color alone, no trap.
// AYA_WCAG_OUT=<dir> also saves the evidence each state produced.

const MAX_TABS = 80;

interface Control {
  desc: string;
  name: string;
  visible: string;
}

/** The panel's enabled, visible interactive elements in DOM order, with their accessible name as the tree computes it. */
async function controls(page: Page): Promise<Control[]> {
  const panel = page.getByRole("tabpanel", { name: /Machines/ });
  const found = panel.locator("button:not([disabled]), input:not([disabled]), a[href], select, textarea, [tabindex]:not([tabindex='-1'])");
  const out: Control[] = [];
  for (const el of await found.all()) {
    if (!(await el.isVisible())) continue;
    const desc = await el.evaluate((n) => `${n.tagName.toLowerCase()}${n.id ? `#${n.id}` : ""}[${(n.textContent ?? "").trim().slice(0, 30)}]`);
    // Playwright's own accessible name, the one getByRole matches on.
    const name = await el.evaluate((n) => {
      const e = n as HTMLElement & { labels?: NodeListOf<HTMLLabelElement> };
      const by = e.getAttribute("aria-labelledby");
      if (e.getAttribute("aria-label")) return e.getAttribute("aria-label") ?? "";
      if (by) return by.split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      if (e.labels?.length) return [...e.labels].map((l) => l.textContent ?? "").join(" ").trim();
      return (e.textContent ?? "").replace(/\s+/g, " ").trim();
    });
    const visible = await el.evaluate((n) => (n.tagName === "INPUT" ? "" : (n as HTMLElement).innerText.replace(/\s+/g, " ").trim()));
    out.push({ desc, name, visible });
  }
  return out;
}

const describeActive = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || a === document.body) return "body";
    const inPanel = !!a.closest("#settings-panel-machines");
    return `${inPanel ? "panel:" : ""}${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ""}[${(a.textContent ?? "").trim().slice(0, 30)}]`;
  });

async function audit(page: Page, state: string) {
  const items = await controls(page);
  // Start on the Machines tab itself, then walk forward and back.
  await page.locator("#settings-tab-machines").focus();
  const forward: string[] = [await describeActive(page)];
  for (let i = 0; i < MAX_TABS; i++) {
    await page.keyboard.press("Tab");
    const now = await describeActive(page);
    forward.push(now);
    if (!now.startsWith("panel:") && forward.some((f) => f.startsWith("panel:"))) break;
  }
  const backward: string[] = [];
  for (let i = 0; i < MAX_TABS; i++) {
    await page.keyboard.press("Shift+Tab");
    const now = await describeActive(page);
    backward.push(now);
    if (now.includes("#settings-tab-machines")) break;
  }
  const headings = await page.locator("#settings-panel-machines").evaluate((p) =>
    [...p.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent ?? "").trim() })),
  );
  const dots = await page.locator("#settings-panel-machines .aya-machine-dot").evaluateAll((ds) =>
    ds.map((d) => ({ ariaHidden: d.getAttribute("aria-hidden"), text: (d.parentElement?.textContent ?? "").trim().slice(0, 60) })),
  );
  const page_ = await page.locator("#settings-panel-machines").evaluate((p) => ({
    animated: [...p.querySelectorAll("*")].filter((n) => getComputedStyle(n).animationName !== "none").map((n) => n.className),
    imgs: p.querySelectorAll("img, svg, [role=img]").length,
    icons: [...p.querySelectorAll(".aya-settings-material")].map((n) => n.getAttribute("aria-hidden")),
    lists: { ul: p.querySelectorAll("ul").length, dl: p.querySelectorAll("dl").length },
    inputs: [...p.querySelectorAll("input")].map((i) => ({ id: i.id, labelFor: !!document.querySelector(`label[for="${i.id}"]`) })),
    alerts: p.querySelectorAll("[role=alert]").length,
    live: p.querySelectorAll("[aria-live]").length,
    dialog: (() => {
      const d = p.closest("[role=dialog]");
      return d ? { label: d.getAttribute("aria-label"), modal: d.getAttribute("aria-modal") } : null;
    })(),
    tab: (() => {
      const t = document.getElementById("settings-tab-machines");
      return { role: t?.getAttribute("role"), selected: t?.getAttribute("aria-selected") };
    })(),
  }));
  const evidence = { state, ...page_, items, forward, backward, headings, dots, lang: await page.evaluate(() => document.documentElement.lang), title: await page.title() };
  if (process.env.AYA_WCAG_OUT) writeFileSync(join(process.env.AYA_WCAG_OUT, `wcag-evidence-${state}.json`), JSON.stringify(evidence, null, 2));
  return evidence;
}

function assertA(e: Awaited<ReturnType<typeof audit>>) {
  // 4.1.2: every control has a name; 2.5.3: the name contains the visible label.
  for (const c of e.items) {
    expect(c.name, `${c.desc} has an accessible name`).not.toBe("");
    if (c.visible) expect(c.name.toLowerCase(), `${c.desc}: name contains its visible label`).toContain(c.visible.toLowerCase());
  }
  // 2.1.1: every control in the panel is reached by Tab.
  const reached = new Set(e.forward.filter((f) => f.startsWith("panel:")).map((f) => f.slice("panel:".length)));
  for (const c of e.items) expect(reached.has(c.desc), `${c.desc} is reached by Tab`).toBe(true);
  // 2.1.2: Tab leaves the panel forward, Shift+Tab gets back to the tab.
  expect(e.forward.at(-1)?.startsWith("panel:"), "Tab leaves the panel").toBe(false);
  expect(e.backward.at(-1), "Shift+Tab returns to the Machines tab").toContain("#settings-tab-machines");
  // 1.3.1: headings start at h2 under the dialog and never skip a level.
  expect(e.headings[0]).toEqual({ level: 2, text: "Machines" });
  for (let i = 1; i < e.headings.length; i++) expect(e.headings[i].level - e.headings[i - 1].level).toBeLessThanOrEqual(1);
  // 1.4.1: a dot is decoration next to text that says the same.
  for (const d of e.dots) {
    expect(d.ariaHidden).toBe("true");
    expect(d.text).toMatch(/Connected|Unreachable|Reachable|Not reachable/);
  }
}

test.describe("empty", () => {
  test.use({ seedOptions: seedBase });
  test("Settings > Machines, empty: names, Tab order, headings, no trap", async ({ app, window }) => {
    const panel = await openMachines(window, app);
    await panel.getByRole("button", { name: "Check gpu-box" }).click();
    await expect(panel.getByTestId("machine-found")).toBeVisible();
    assertA(await audit(window, "empty"));
    // 2.1.1: Space and Enter run a control; 2.1.2: Escape leaves the dialog from inside a field.
    await panel.getByRole("button", { name: "Check old-server" }).focus();
    await window.keyboard.press("Space");
    await expect(panel.getByTestId("machine-suggestion").nth(2)).toContainText("Not reachable");
    await panel.getByRole("button", { name: "Check mini-lab" }).focus();
    await window.keyboard.press("Enter");
    await expect(panel.getByTestId("machine-suggestion").nth(1)).toContainText("Ollama not answering");
    await panel.getByLabel("Add machines in one sentence").focus();
    await window.keyboard.press("Enter");
    await expect(panel.getByRole("alert")).toContainText("Write which machines to add");
    await window.keyboard.press("Escape");
    await expect(window.locator(".aya-modal--settings")).toHaveCount(0);
  });
});

test.describe("added", () => {
  test.use({ seedOptions: { ...seedBase, ayaHomeFiles: { ...seedBase.ayaHomeFiles, "machines.json": TWO_MACHINES } } });
  test("Settings > Machines, added: names, Tab order, headings, no trap", async ({ app, window }) => {
    const panel = await openMachines(window, app);
    await expect(panel.getByTestId("machine-card")).toHaveCount(2);
    await expect(panel.getByTestId("machine-state").first()).toContainText("Connected");
    assertA(await audit(window, "added"));
  });
});
