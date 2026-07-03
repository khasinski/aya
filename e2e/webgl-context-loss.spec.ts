import { test, expect } from "./fixtures";

// The white-terminal-after-returning bug: a WebGL context held by a hidden /
// occluded window is what the GPU evicts under memory pressure (e.g. a
// headless-Chrome PDF render running in a terminal); the compositor paints the
// missing canvas texture as a WHITE quad and the throttled renderer can't
// react - the user comes back to a white terminal area (side/top panels
// intact) for 2-5s. Reported live, reproduced by forcing WEBGL_lose_context
// on a hidden window.
//
// The fix is PREVENTIVE: on visibilitychange->hidden the terminal drops its
// WebGL addon entirely (the DOM renderer's layers survive eviction - nothing
// evictable remains), and on ->visible it attaches a FRESH context and
// repaints. This spec drives the real production signal (visibilitychange;
// Chromium flips it on macOS window occlusion and on hide) deterministically
// via an overridable visibilityState, because an automation harness delivers
// no native occlusion events.

// No-split seed => enableWebgl=true (matches the projects-left layout where
// split is disabled - the reporter's setup).
test.use({ seedOptions: { split: false } });

/** State of the terminal's WebGL canvas: "healthy" | "lost" | "none". */
async function webglState(window: import("@playwright/test").Page): Promise<string> {
  return window.evaluate(() => {
    const frame = document.querySelector('[data-testid="xterm-frame"]');
    if (!frame) return "no-frame";
    for (const c of Array.from(frame.querySelectorAll("canvas"))) {
      const gl = (c.getContext("webgl2") ||
        c.getContext("webgl")) as WebGLRenderingContext | null;
      if (gl) return gl.isContextLost() ? "lost" : "healthy";
    }
    return "none";
  });
}

async function setDocVisibility(
  window: import("@playwright/test").Page,
  state: "hidden" | "visible",
) {
  await window.evaluate((s) => {
    (window as unknown as { __vis: string }).__vis = s;
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
}

test("WebGL is dropped while hidden and comes back fresh on visibility - nothing evictable in the background", async ({
  window,
  app,
}) => {
  await window.emulateMedia({ colorScheme: "dark" }); // match the reporter's setup
  // The app force-disables WebGL under automation (navigator.webdriver); mask
  // it so the REAL user's render path runs. Make visibilityState drivable -
  // the harness gets no native occlusion signals.
  await window.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    (window as unknown as { __vis: string }).__vis = "visible";
    Object.defineProperty(document, "visibilityState", {
      get: () => (window as unknown as { __vis: string }).__vis,
    });
  });
  await window.reload();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());

  // Skip ONLY when the ENVIRONMENT has no WebGL at all (probed independently
  // of the app) - if the env has GL but the terminal didn't attach, that is a
  // mount-attach regression and must FAIL, not skip (test-honesty audit: the
  // old app-derived skip swallowed exactly that mutation).
  await window.waitForTimeout(2000);
  const envHasGl = await window.evaluate(() => {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    const ok = !!gl;
    // Release the probe context right away instead of waiting for GC.
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return ok;
  });
  test.skip(!envHasGl, "no WebGL in this environment");
  const initial = await webglState(window);
  expect(initial).toBe("healthy");

  // While hidden, zero frames are painted - the context is RELEASED (not
  // "GPU disabled": no visible frame is ever rendered without it), so there
  // is nothing for the GPU to evict into a white quad.
  await setDocVisibility(window, "hidden");
  await expect.poll(() => webglState(window), { timeout: 1_000 }).toBe("none");

  // Whatever happens in the background (GPU pressure etc.), there is nothing
  // to lose now. THE claim on return: flip to visible and read the state IN
  // THE SAME TASK - before the event loop can paint a single frame. "healthy"
  // here proves the FIRST visible frame is already GPU-rendered: WebGL is
  // never disabled for anything the user sees; the context is merely not held
  // while zero frames are painted (the strategy Chromium's own canvas
  // hibernation applies to 2D canvases of hidden pages).
  const rightAfterDispatch = await window.evaluate(() => {
    (window as unknown as { __vis: string }).__vis = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    const frame = document.querySelector('[data-testid="xterm-frame"]');
    for (const c of Array.from(frame?.querySelectorAll("canvas") ?? [])) {
      const gl = ((c as HTMLCanvasElement).getContext("webgl2") ||
        (c as HTMLCanvasElement).getContext("webgl")) as WebGLRenderingContext | null;
      if (gl) return gl.isContextLost() ? "lost" : "healthy";
    }
    return "none";
  });
  expect(rightAfterDispatch, "first visible frame must already be WebGL-rendered").toBe("healthy");
});
