import { test, expect } from "./fixtures";

test.describe("with a usage snapshot", () => {
  // Seed the usage.json a user hook would write, so the account-wide chip
  // renders. updatedAt is fresh so it isn't dimmed as stale.
  test.use({
    seedOptions: {
      usage: {
        fiveHour: { pct: 30, resetsAt: "2026-12-01T17:20:00Z" },
        sevenDay: { pct: 55, resetsAt: "2026-12-06T15:00:00Z" },
        updatedAt: new Date().toISOString(),
      },
    },
  });

  test("chip shows the weekly percent and an account-wide popover", async ({
    window,
  }) => {
    // The chip shows the weekly (account-cap) percent at a glance.
    const chip = window.getByRole("button", { name: /account-wide/i });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("55%");

    // Opening it reveals the breakdown, explicitly framed as account-wide (not
    // this project) — the whole point, so the global numbers aren't misread as
    // per-project. Both windows' percentages are shown.
    await chip.click();
    await expect(window.getByText("Claude — account-wide")).toBeVisible();
    await expect(
      window.getByText("all sessions, not this project"),
    ).toBeVisible();
    await expect(window.getByText("5h", { exact: true })).toBeVisible();
    await expect(window.getByText("week", { exact: true })).toBeVisible();
    await expect(window.getByText("30%")).toBeVisible();
  });

  test("clicking the chip does not steal focus from the terminal", async ({
    window,
  }) => {
    const inTerminal = () =>
      window.evaluate(() => {
        const panes = Array.from(document.querySelectorAll(".aya-pane"));
        const a = document.activeElement;
        return (
          !!a &&
          a.tagName.toLowerCase() === "textarea" &&
          panes.some((p) => p.contains(a))
        );
      });

    await window.locator(".aya-pane").first().locator(".aya-xterm-host").click();
    await expect.poll(inTerminal).toBe(true); // terminal has focus

    // Open the chip popover; focus must stay in the terminal (the old
    // Settings-style lost-focus bug — peeking at usage shouldn't force a
    // re-click to resume typing).
    await window.getByRole("button", { name: /account-wide/i }).click();
    await expect(window.getByText("Claude — account-wide")).toBeVisible();
    expect(await inTerminal()).toBe(true);
  });

  test("settings can hide harness names in usage icons", async ({ window }) => {
    const chip = window.getByRole("button", {
      name: /claude usage, account-wide/i,
    });
    await expect(chip).toContainText("Claude");
    await expect(chip).toContainText("55%");

    await window.getByRole("button", { name: "Settings" }).click();
    await window
      .getByRole("button", { name: "Compact rings" })
      .click();
    // The Settings modal closes on Escape (no Cancel button in the shell);
    // pressing Escape leaves the "Compact rings" choice persisted.
    await window.keyboard.press("Escape");

    await expect(chip).not.toContainText("Claude");
    await expect(chip).toContainText("55%");
  });
});

test.describe("without a usage snapshot", () => {
  test.use({ seedOptions: {} });

  test("no chip when the snapshot file is absent", async ({ window }) => {
    // File absent → chip hidden, never a broken empty button.
    await expect(
      window.getByRole("button", { name: /account-wide/i }),
    ).toHaveCount(0);
  });
});

test.describe("with multiple Claude usage accounts", () => {
  test.use({
    seedOptions: {
      usage: {
        accounts: [
          {
            id: "work",
            label: "Work",
            usage: {
              fiveHour: { pct: 10 },
              sevenDay: { pct: 0 },
              updatedAt: new Date().toISOString(),
            },
          },
          {
            id: "personal",
            label: "Personal",
            usage: {
              fiveHour: { pct: 80 },
              sevenDay: { pct: 100 },
              updatedAt: new Date().toISOString(),
            },
          },
        ],
      },
    },
  });

  test("Claude chip shows average weekly percent and dropdown splits accounts", async ({
    window,
  }) => {
    const chip = window.getByRole("button", {
      name: /claude usage, account-wide/i,
    });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("50%");
    await expect(
      window.getByRole("button", { name: /claude usage, account-wide/i }),
    ).toHaveCount(1);

    await chip.click();
    await expect(window.getByText("2 accounts, all sessions, not this project")).toBeVisible();
    await expect(window.getByText("Work", { exact: true })).toBeVisible();
    await expect(window.getByText("Personal", { exact: true })).toBeVisible();
    await expect(window.getByText("0%", { exact: true })).toBeVisible();
    await expect(window.getByText("100%", { exact: true })).toBeVisible();
  });
});

test.describe("with a Codex rollout", () => {
  // Codex usage comes from its local rollout (no hook/token). Seed one with a
  // rate_limits event; the Codex chip should render its weekly percent.
  test.use({
    seedOptions: {
      codexRateLimits: {
        primary: { used_percent: 12, window_minutes: 300, resets_at: 1780523078 },
        secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1780851308 },
      },
    },
  });

  test("Codex chip shows the weekly percent and its own popover", async ({
    window,
  }) => {
    const chip = window.getByRole("button", {
      name: /codex usage, account-wide/i,
    });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("40%");
    await chip.click();
    await expect(window.getByText("Codex — account-wide")).toBeVisible();
  });
});
