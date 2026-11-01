
    import { appendFileSync, writeFileSync } from "node:fs";
    import { test } from "./fixtures";
    import { appEnv } from "./helpers/seed";
    test("missing event kind is a fixture failure", async ({ seeded }) => {
      const env = appEnv(seeded);
      writeFileSync(process.env.E2E_HEADLESS_UI_PROBE_ROOT_FILE!, seeded.root);
      appendFileSync(env.AYA_E2E_HEADLESS_UI_LOG!, JSON.stringify({ expected: true }) + "\n");
    });
  