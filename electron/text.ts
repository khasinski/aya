// Small text helpers shared across the main process.

/** Normalize a display name into a URL/id-safe slug. Falls back to `fallback`
 *  when the name reduces to nothing usable. */
export function slugifyName(name: string, fallback: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}
