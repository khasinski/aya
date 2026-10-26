import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { formatHarnessSearchCoverage } = await import(
  "../dist-test/harness-search-coverage.js"
);
const { beginHistorySearch } = await import("../dist-test/harness-search-sequence.js");
const { FindBarCoverageLine } = await import("../dist-test/components/FindBarCoverageLine.js");

const date = "2026-10-26T14:05:00.000Z";
const localDate = "Oct 26, 2026, 3:05 PM";
const formatDate = () => localDate;

test("History results render the partial-coverage line beneath hits", () => {
  assert.equal(
    formatHarnessSearchCoverage({ partial: true, searchedBackTo: date }, true, "Codex", formatDate),
    "Searched back to Oct 26, 2026, 3:05 PM",
  );
});

test("History empty state names the date boundary and agent when coverage is partial", () => {
  assert.equal(
    formatHarnessSearchCoverage({ partial: true, searchedBackTo: date }, false, "Claude", formatDate),
    "No matches since Oct 26, 2026, 3:05 PM in recent Claude sessions for this directory",
  );
});

test("History explains when long messages were skipped", () => {
  assert.equal(
    formatHarnessSearchCoverage({ partial: true, searchedBackTo: date, longMessagesSkipped: true }, false, "Claude", formatDate),
    "No matches since Oct 26, 2026, 3:05 PM in recent Claude sessions for this directory (very long messages were not searched)",
  );
});

test("History says when its deadline expires before any transcript was read", () => {
  assert.equal(
    formatHarnessSearchCoverage({ partial: true }, false, "Codex", formatDate),
    "Search timed out before reading recent Codex sessions",
  );
});

test("a too-short query advances the sequence and invalidates its prior response", () => {
  const sequence = { current: 0 };
  const prior = beginHistorySearch(sequence, "needle", 2);
  const shortened = beginHistorySearch(sequence, "n", 2);
  assert.equal(prior.shouldSearch, true);
  assert.equal(shortened.shouldSearch, false);
  assert.notEqual(sequence.current, prior.id);
});

test("complete History searches have no coverage line", () => {
  assert.equal(formatHarnessSearchCoverage({ partial: false }, true, "Codex", formatDate), null);
  assert.equal(
    formatHarnessSearchCoverage({ partial: true }, false, "Codex", formatDate),
    "Search timed out before reading recent Codex sessions",
  );
});

test("the rendered History results line appears only for partial coverage", () => {
  const partial = renderToStaticMarkup(createElement(FindBarCoverageLine, {
    coverage: { partial: true, searchedBackTo: date },
    hasHits: true,
    agentLabel: "Claude",
  }));
  assert.match(partial, /class="aya-findbar-coverage"[^>]*>Searched back to/);
  const complete = renderToStaticMarkup(createElement(FindBarCoverageLine, {
    coverage: { partial: false },
    hasHits: true,
    agentLabel: "Claude",
  }));
  assert.equal(complete, "");
});
