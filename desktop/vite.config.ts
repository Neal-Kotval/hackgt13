import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";
import path from "node:path";

let electronStarted = false;

export default defineConfig({
  root: ".",
  // Serve the same self-hosted font files Next uses so /fonts/* resolves in Electron.
  publicDir: path.resolve(__dirname, "../public"),
  resolve: {
    alias: {
      "@agentcloud-tokens": path.resolve(__dirname, "../app/tokens.css"),
    },
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname, "..")],
    },
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: "electron/main.ts",
        onstart({ startup }) {
          // Do not kill the live BrowserWindow when the main bundle rebuilds.
          // Renderer Vite HMR still works. Restart `just desktop` after main edits.
          if (electronStarted) {
            console.log(
              "[desktop] main process bundle rebuilt. UI stays up; restart `just desktop` to apply main-process changes.",
            );
            return;
          }
          electronStarted = true;
          startup();
        },
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              // ssh2 loads optional native bindings at runtime; keep it a
              // node_modules dependency instead of bundling it.
              external: ["electron", "ssh2"],
            },
          },
        },
      },
      preload: {
        input: "electron/preload.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: {
              external: ["electron"],
              output: {
                format: "cjs",
                entryFileNames: "preload.cjs",
                inlineDynamicImports: true,
              },
            },
          },
        },
      },
      renderer: {},
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
