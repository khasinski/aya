import { defineConfig } from "vite";

// The window's preload, bundled into one file: a sandboxed preload can require only
// `electron` and a few built-ins, never its own modules (./open-project-buffer and the rest).
// tsc still type-checks electron/preload.ts; the window loads this bundle (main.ts).

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist-electron",
    emptyOutDir: false,
    minify: false,
    target: "es2022",
    lib: { entry: { preload: "electron/preload.ts", "artifact-preview-preload": "electron/artifact-preview-preload.ts" }, formats: ["cjs"], fileName: (_format, name) => `${name}.bundle.js` },
    rollupOptions: { external: ["electron"] },
  },
});
