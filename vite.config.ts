import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
// Pin the actual bundled artifact. The package's separate `module` entry has
// different bytes; do not hash CJS while silently importing that ESM branch.
const browserVtArtifact = createRequire(import.meta.url).resolve("@xterm/xterm");
const browserVtEngine = createHash("sha256").update(readFileSync(browserVtArtifact)).digest("hex");

// The Electron window loads only its own files: a script injected through text it
// shows (an agent's output, a team message) can neither run nor send data out.
// 'unsafe-inline' styles: index.html's <style> and the ones xterm.js adds itself.
const RENDERER_CSP = [
  "default-src 'self'",
  "frame-src aya-widget:",
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


// Dev only: Vite serves the renderer's shared/*.cjs files untransformed, so their named imports fail in the browser
// (the build converts them). Wrap each in a module: its local requires become imports, its exports named exports.
function sharedCommonJsInDev(): Plugin {
  return {
    name: "aya-shared-cjs-dev",
    apply: "serve",
    transform(code, id) {
      const file = id.split("?")[0];
      if (!/\/shared\/[^/]+\.cjs$/.test(file)) return;
      const imports: string[] = [];
      const body = code.replace(/require\((["'])(\.\/[^"']+\.cjs)\1\)/g, (_match, _quote, path: string) => {
        imports.push(`import __aya_require_${imports.length} from ${JSON.stringify(path)};`);
        return `__aya_require_${imports.length - 1}`;
      });
      const names = new Set<string>();
      for (const m of body.matchAll(/^exports\.([A-Za-z_$][\w$]*)\s*=/gm)) names.add(m[1]);
      const literal = /module\.exports\s*=\s*\{([^}]*)\}/.exec(body);
      for (const part of literal ? literal[1].split(",") : []) {
        const name = part.trim().split(":")[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
      return [
        ...imports,
        "const module = { exports: {} }; let exports = module.exports;",
        body,
        "const __aya_exports = module.exports;",
        "export default __aya_exports;",
        ...[...names].map(name => `export const ${name} = __aya_exports.${name};`),
      ].join("\n");
    },
  };
}

export default defineConfig({
  plugins: [react(), rendererCsp(), sharedCommonJsInDev(), {
    name: "aya-woff2-only", enforce: "pre",
    transform(code, id) {
      if (id.includes("@fontsource/") && id.endsWith(".css")) return code.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, "");
    },
  }],
  define: { __AYA_XTERM_ENGINE__: JSON.stringify(browserVtEngine) },
  resolve: { alias: [{ find: /^@xterm\/xterm$/, replacement: browserVtArtifact }] },
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
            // Keep the diagram engine and its layout dependencies out of the
            // eagerly loaded vendor chunk. It loads on the first Mermaid block.
            { name: "mermaid", test: /node_modules[\\/]mermaid[\\/]/, priority: 60, includeDependenciesRecursively: true, entriesAware: true },
            { name: "syntax-highlight", test: /node_modules[\\/]highlight\.js[\\/]/, priority: 50 },
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
              entriesAware: true,
            },
          ],
        },
      },
    },
  },
});
