// Aya Emulator — entry point.
//
// Boots the REAL Aya renderer (../App and every component + CSS it uses)
// against a fully mocked window.aya, so a screenshot of this page is
// pixel-identical to the desktop app but shows any state you script.
//
// Boot order mirrors src/web/main.tsx: window.aya MUST exist before App's
// module tree runs (ptyEventBus and many components read it at import time),
// so App is imported dynamically only after the mock bridge is installed.

import "@xterm/xterm/css/xterm.css";
import "../styles/armillary.css";
import "../styles/app.css";
import "../styles/overrides.css";

import { createRoot } from "react-dom/client";
import { createEmulatorAya } from "./bridge";
import { pickScenario } from "./scenarios";
import type { EmScenario } from "./scenario";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

// App reads these localStorage keys at boot (usePersistentPreference / the
// summary cache), so they MUST be seeded before ../App is imported. Codec
// formats match src/hooks/usePersistentPreference.ts: enum → raw string,
// bool → "1"/"0".
function seedPreferences(scenario: EmScenario, themeOverride: string | null) {
  const set = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore — private mode / storage disabled */
    }
  };

  // App chrome appearance. Emulator defaults to dark.
  const theme = themeOverride || scenario.theme || "dark";
  set("aya:app-theme", theme);

  // Apple Intelligence: pre-seed the local-summary cache from the scenario so
  // tab/project summaries render exactly as if a provider had labelled them.
  // (The default provider is already "apple" — see DEFAULT_AYA_INTELLIGENCE.)
  const terminal: Record<string, { summary: string; updatedAt: number }> = {};
  const project: Record<string, { summary: string; updatedAt: number }> = {};
  const now = Date.now();
  let hasSummary = false;
  for (const p of scenario.projects) {
    if (p.summary) {
      project[p.slug] = { summary: p.summary, updatedAt: now };
      hasSummary = true;
    }
    for (const t of p.tabs) {
      if (t.summary) {
        terminal[t.id] = { summary: t.summary, updatedAt: now };
        hasSummary = true;
      }
    }
  }
  if (hasSummary) {
    set("aya:local-summaries", "1");
    set("aya:local-summary-cache", JSON.stringify({ terminal, project }));
  } else {
    set("aya:local-summaries", "0");
  }
}

void (async () => {
  // Scenario selection: ?scenario=<name> (falls back to the default). Kept out
  // of the DOM so nothing non-Aya lands in a screenshot.
  const params = new URLSearchParams(window.location.search);
  const scenario = pickScenario(params.get("scenario"));
  document.title = `Aya Emulator — ${scenario.name}`;

  seedPreferences(scenario, params.get("theme"));
  window.aya = createEmulatorAya(scenario);

  const { App } = await import("../App");
  createRoot(container).render(<App />);
})();
