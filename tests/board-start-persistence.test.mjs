import { test } from "node:test";
import assert from "node:assert/strict";
import { tabFromTerminal } from "../dist-test/worktree.js";
import { hydrateProjectTerminalStates } from "../dist-test/project-persistence.js";
import { normalizeTab } from "../dist-electron/config.js";
import { validateProjectConfig } from "../dist-electron/validation.js";

test("a reserved board start survives tab persistence, normalization and renderer hydration", () => {
  const initialBoardCard = { cardId: "t-1", since: "2026-11-12T10:00:00.000Z", previousColumn: "todo", previousAssignee: "Planner" };
  const terminal = { id: "pane", projectSlug: "demo", presetId: "claude", name: "Claude", cwd: "/repo", initialBoardCard };
  const validated = validateProjectConfig({ slug: "demo", name: "Demo", directory: "/repo", tabs: [tabFromTerminal(terminal, "/repo")] });
  const tab = normalizeTab(validated.tabs[0]);
  assert.deepEqual(tab.initialBoardCard, initialBoardCard);
  const project = { slug: "demo", name: "Demo", directory: "/repo", tabs: [tab] };
  assert.deepEqual(hydrateProjectTerminalStates({}, project, "/repo").pane.initialBoardCard, initialBoardCard);
});
