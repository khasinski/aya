/** Only local file references. Never interpret an unknown URL scheme as a path. */
function workspaceLink(raw) {
  if (typeof raw !== 'string' || !raw.trim() || /[\0-\x1f]/.test(raw)) return null;
  let value = raw.trim();
  if (value.startsWith('#') || value.startsWith('//')) return null;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return null;
      value = url.pathname + url.hash;
    } catch { return null; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^:]*[./][^:]*:\d+(?::\d+)?$/.test(value)) return null;
  let line = 1;
  const suffix = value.match(/(?::([1-9]\d*)(?::\d+)?|#L([1-9]\d*)(?:-L?\d+)?)$/);
  if (suffix) { line = Number(suffix[1] || suffix[2]); value = value.slice(0, -suffix[0].length); }
  if (!Number.isSafeInteger(line) || line > 10000000) return null;
  try { value = decodeURIComponent(value); } catch { return null; }
  if (!value || /[\0-\x1f]/.test(value)) return null;
  return { path: value, line };
}
module.exports = { workspaceLink };
