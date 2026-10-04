import type { ElectronApplication, Page } from "@playwright/test";
import { closeAndWait, launchApp as launchBuiltApp, test } from "../fixtures";
import type { SeededEnv } from "./seed";

/** The fixture's launch, with its first window; calling it again after `app.close()`
 *  is a real quit and relaunch. The caller closes the app. */
export async function launchApp(seeded: SeededEnv): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await launchBuiltApp(seeded);
  return { app, window: await app.firstWindow() };
}

/** Apps a spec has launched, closed after each test; `quit` closes one mid-test, as a user quitting. */
export function trackLaunches() {
  const launched: ElectronApplication[] = [];
  test.afterEach(async () => {
    for (const app of launched.splice(0)) await closeAndWait(app);
  });
  return {
    async launch(seeded: SeededEnv): Promise<{ app: ElectronApplication; window: Page }> {
      const started = await launchApp(seeded);
      launched.push(started.app);
      return started;
    },
    async quit(app: ElectronApplication) {
      launched.splice(launched.indexOf(app), 1);
      await closeAndWait(app);
    },
  };
}
