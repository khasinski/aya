const PLACEHOLDER = "@SUMMARY_MAX_CHARS@";

/** Fill the Swift helper template with the main process's summary cap. */
function renderLocalSummarySource(template, maxChars) {
  if (!template.includes(PLACEHOLDER)) {
    throw new Error(`aya-local-summary template has no ${PLACEHOLDER}`);
  }
  return template.replaceAll(PLACEHOLDER, String(maxChars));
}

module.exports = { renderLocalSummarySource };
