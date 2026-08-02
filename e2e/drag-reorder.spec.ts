import { test, expect } from "./fixtures";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

// Drag-to-reorder (useDragReorder). Chromium doesn't synthesize HTML5 DnD from
// Playwright's synthetic mouse, so we dispatch the drag events ourselves with a
// shared DataTransfer and a pointer coordinate that lands in the target's
// requested half (the hook derives before/after from clientX/Y vs the midpoint).

async function dragReorder(
  window: Page,
  sourceSel: string,
  targetSel: string,
  half: "before" | "after",
  axis: "x" | "y",
) {
  // Dispatch each DnD event in its own tick so React commits dragId/dropTarget
  // between them (a single evaluate would batch all three and drop would read
  // stale state). A shared DataTransfer is stashed on window across the steps.
  const step = (which: "dragstart" | "dragover" | "drop" | "dragend") =>
    window.evaluate(
      ({ sourceSel, targetSel, half, axis, which }) => {
        const w = window as unknown as { __dt?: DataTransfer };
        if (which === "dragstart") w.__dt = new DataTransfer();
        const onSource = which === "dragstart" || which === "dragend";
        const el = document.querySelector(onSource ? sourceSel : targetSel)!;
        const r = (document.querySelector(targetSel) as Element).getBoundingClientRect();
        const clientX =
          axis === "x" ? (half === "before" ? r.left + r.width * 0.25 : r.left + r.width * 0.75) : r.left + r.width / 2;
        const clientY =
          axis === "y" ? (half === "before" ? r.top + r.height * 0.25 : r.top + r.height * 0.75) : r.top + r.height / 2;
        const ev = new DragEvent(which, { bubbles: true, cancelable: true, clientX, clientY });
        Object.defineProperty(ev, "dataTransfer", { value: w.__dt });
        el.dispatchEvent(ev);
      },
      { sourceSel, targetSel, half, axis, which },
    );
  await step("dragstart");
  await step("dragover");
  await step("drop");
  await step("dragend");
}

const sidebarNames = (window: Page) =>
  window.getByTestId("sidebar-terminal").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-terminal-name")),
  );

test("dragging a sidebar terminal reorders it and persists the new tab order", async ({
  window,
  seeded,
}) => {
  await expect(window.getByTestId("sidebar-terminal")).toHaveCount(2);
  expect(await sidebarNames(window)).toEqual(["shell 1", "shell 2"]);

  // Drag shell 1 below shell 2 -> order becomes [shell 2, shell 1].
  await dragReorder(
    window,
    '[data-testid="sidebar-terminal"][data-terminal-name="shell 1"]',
    '[data-testid="sidebar-terminal"][data-terminal-name="shell 2"]',
    "after",
    "y",
  );

  await expect.poll(() => sidebarNames(window)).toEqual(["shell 2", "shell 1"]);

  // Persisted to the project's tabs order on disk (tab-right before tab-left).
  await expect
    .poll(() => {
      try {
        const cfg = JSON.parse(readFileSync(join(seeded.ayaHome, "projects", "e2e-proj.json"), "utf8"));
        return (cfg.tabs as Array<{ id: string }>).map((t) => t.id);
      } catch {
        return [];
      }
    })
    .toEqual(["tab-right", "tab-left"]);

  // And the project-state order file is NOT touched by a terminal reorder.
  const state = JSON.parse(readFileSync(join(seeded.ayaHome, "projects-state.json"), "utf8"));
  expect(state.order).toEqual(["e2e-proj"]);
});
