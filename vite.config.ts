import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
