import { test } from "node:test";
import assert from "node:assert/strict";

const { formatHarnessSearchCoverage } = await import(
  "../dist-test/harness-search-coverage.js"
);

const date = "2026-10-26T14:05:00.000Z";
const localDate = "Oct 26, 2026, 3:05 PM";
const formatDate = () => localDate;

test("History results render the partial-coverage line beneath hits", () => {
  assert.equal(
    formatHarnessSearchCoverage({ partial: true, searchedBackTo: date }, true, "Codex", formatDate),
    "Searched back to Oct 26, 2026, 3:05 PM in long sessions",
  );
});

test("History empty state names the date boundary and agent when coverage is partial", () => {
  assert.equal(
    formatHarnessSearchCoverage({ partial: true, searchedBackTo: date }, false, "Claude", formatDate),
    "No matches since Oct 26, 2026, 3:05 PM in recent Claude sessions for this directory",
  );
});

test("complete History searches have no coverage line", () => {
  assert.equal(formatHarnessSearchCoverage({ partial: false }, true, "Codex", formatDate), null);
  assert.equal(formatHarnessSearchCoverage({ partial: true }, false, "Codex", formatDate), null);
});
