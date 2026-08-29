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

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

void (async () => {
  // Scenario selection: ?scenario=<name> (falls back to the default). Kept out
  // of the DOM so nothing non-Aya lands in a screenshot.
  const params = new URLSearchParams(window.location.search);
  const scenario = pickScenario(params.get("scenario"));
  document.title = `Aya Emulator — ${scenario.name}`;

  window.aya = createEmulatorAya(scenario);

  const { App } = await import("../App");
  createRoot(container).render(<App />);
})();
