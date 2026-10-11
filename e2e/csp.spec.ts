import { test, expect } from "./fixtures";

// The built window carries a CSP (vite.config.ts) and its own fonts: nothing it loads may be
// refused, and a script injected through text it shows must not run.
test("the built window loads everything under its CSP, fonts included, and refuses an injected script", async ({ window }) => {
  const refused: string[] = [];
  window.on("console", (msg) => {
    if (/Refused to/.test(msg.text())) refused.push(msg.text());
  });
  // A reload with the listener attached sees the whole boot, the terminals' styles included.
  await window.reload();
  await expect(window.getByTestId("terminal-pane")).toHaveCount(2);

  const policy = await window.evaluate(
    () => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "",
  );
  expect(policy).toContain("script-src 'self'");

  const loaded = await window.evaluate(async () => {
    const count = async (font: string, text?: string) => (await document.fonts.load(font, text)).length;
    return {
      sans: await count('600 14px "Source Sans 3"'),
      mono: await count('14px "JetBrains Mono"'),
      icons: await count('24px "Material Symbols Outlined"', "dns"),
    };
  });
  expect(loaded.sans, "Source Sans 3 loaded").toBeGreaterThan(0);
  expect(loaded.mono, "JetBrains Mono loaded").toBeGreaterThan(0);
  expect(loaded.icons, "Material Symbols loaded").toBeGreaterThan(0);
  expect(refused).toEqual([]);

  const ran = await window.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__ayaCspProbe = true;";
    document.head.appendChild(script);
    return (window as unknown as { __ayaCspProbe?: boolean }).__ayaCspProbe === true;
  });
  expect(ran).toBe(false);
});
