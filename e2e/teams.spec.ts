// A team message goes from one real pane to another through the real app:
// role lookup, the pane id from the local assignments, the dated header.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

const NODE = process.execPath;
const AGENT = join(__dirname, "helpers", "team-agent.cjs");
const AYA = join(__dirname, "..", "bin", "aya");

const TEAM = `# ux-review

## Role: tester
Sends to: implementer
Must not: edit code
Plays the build each round.

## Role: implementer
Sends to: tester
Must not: skip a report
Fixes findings.
`;

test.use({
  seedOptions: {
    presetList: [
      { id: "shell", name: "Agent", icon: "a", color: "", command: `'${NODE}' '${AGENT}' '${AYA}'` },
    ],
    projectFiles: { ".aya/teams/ux-review.md": TEAM },
    ayaHomeFiles: {
      "teams/e2e-proj/ux-review/assignments.json": JSON.stringify({ tester: "tab-left", implementer: "tab-right" }),
    },
  },
});

test("tester's aya team send reaches the implementer's pane with the team header", async ({ window, seeded }) => {
  await expect(window.getByTestId("xterm-host").first()).toBeVisible();
  const read = (pane: string) => {
    const file = join(seeded.projectDir, `team-${pane}.log`);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  await expect.poll(() => read("tab-left"), { timeout: 30_000 }).toMatch(/SENT written to implementer's pane/);
  await expect
    .poll(() => read("tab-right"), { timeout: 15_000 })
    .toMatch(/\[team ux-review \| from tester \| \d\d:\d\d\] round 5 ready/);
});

test.describe("an implementer on an approval prompt", () => {
  test.use({
    seedOptions: {
      presetList: [
        { id: "shell", name: "Agent", icon: "a", color: "", agent: "claude", command: `'${NODE}' '${AGENT}' '${AYA}' ask` },
      ],
      projectFiles: { ".aya/teams/ux-review.md": TEAM },
      ayaHomeFiles: {
        "teams/e2e-proj/ux-review/assignments.json": JSON.stringify({ tester: "tab-left", implementer: "tab-right" }),
      },
    },
  });

  test("is not typed into: Enter would answer the prompt", async ({ window, seeded }) => {
    await expect(window.getByTestId("xterm-host").first()).toBeVisible();
    const read = (pane: string) => {
      const file = join(seeded.projectDir, `team-${pane}.log`);
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    };
    await expect.poll(() => read("tab-left"), { timeout: 30_000 }).toMatch(/FAIL .*implementer's pane shows an approval prompt/);
    expect(read("tab-right")).not.toMatch(/round 5 ready/);
  });
});

test.describe("an implementer pane that runs a plain shell", () => {
  test.use({
    seedOptions: {
      presetList: [{ id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" }],
      projectFiles: { ".aya/teams/ux-review.md": TEAM },
      ayaHomeFiles: {
        "teams/e2e-proj/ux-review/assignments.json": JSON.stringify({ tester: "tab-left", implementer: "tab-right" }),
      },
    },
  });

  test("is not typed into: Enter would run the text as a command", async ({ window, seeded }) => {
    await expect(window.getByTestId("xterm-host").first()).toBeVisible();
    const send = () => {
      try {
        execFileSync(AYA, ["team", "send", "implementer", "touch should-not-exist"], {
          env: { ...process.env, AYA_SOCKET: join(seeded.ayaHome, "aya.sock"), AYA_TERMINAL_ID: "tab-left" },
          stdio: "pipe",
        });
        return "sent";
      } catch (err) {
        return String((err as { stderr?: Buffer }).stderr ?? err);
      }
    };
    await expect.poll(send, { timeout: 30_000 }).toMatch(/implementer's pane runs a shell/);
    expect(existsSync(join(seeded.projectDir, "should-not-exist"))).toBe(false);
  });
});
