import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const browserVtEngine = createHash("sha256").update(readFileSync(createRequire(import.meta.url).resolve("@xterm/xterm"))).digest("hex");

// The Electron window loads only its own files: a script injected through text it
// shows (an agent's output, a team message) can neither run nor send data out.
// 'unsafe-inline' styles: index.html's <style> and the ones xterm.js adds itself.
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "media-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

// Build only: in dev the React plugin injects an inline script that this CSP would
// block. Only index.html (the Electron window); web.html is served by Aya Web.
function rendererCsp(): Plugin {
  return {
    name: "aya-renderer-csp",
    apply: "build",
    transformIndexHtml(html, ctx) {
      if (!ctx.path.endsWith("/index.html")) return html;
      return [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: RENDERER_CSP }, injectTo: "head-prepend" }];
    },
  };
}

export default defineConfig({
  plugins: [react(), rendererCsp()],
  define: { __AYA_XTERM_ENGINE__: JSON.stringify(browserVtEngine) },
  base: "./",
  server: {
    // Non-default port so Aya doesn't fight other Vite projects on 5173.
    port: 5183,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rolldownOptions: {
      // Three entry points: the Electron renderer, Aya Web (served by
      // electron/web-server.ts) and the emulator.
      input: {
        main: "./index.html",
        web: "./web.html",
        // Aya Emulator (emulator.html): the same renderer + CSS driven by a
        // fully mocked window.aya, for screenshotting arbitrary UI states.
        emulator: "./emulator.html",
      },
      output: {
        chunkFileNames: "assets/[name]-[hash].js",
        codeSplitting: {
          groups: [
            {
              name: "xterm-addons",
              test: /node_modules[\\/]@xterm[\\/]addon-/,
              priority: 40,
            },
            {
              name: "xterm-core",
              test: /node_modules[\\/]@xterm[\\/]xterm[\\/]/,
              priority: 30,
            },
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 20,
            },
            {
              name: "vendor",
              test: /node_modules[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
