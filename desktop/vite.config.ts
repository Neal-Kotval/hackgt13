import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";
import path from "node:path";
import { readFileSync } from "node:fs";

// Electron cannot resolve CSS variables. Derive its initial canvas from the
// shared light theme during bundling instead of maintaining a second palette.
const tokens = readFileSync(path.resolve(__dirname, "../app/tokens.css"), "utf8");
const lightTheme = tokens.match(/\.alto-web\s*\{([^}]+)\}/)?.[1];
const canvasToken = lightTheme?.match(/--color-bg:\s*var\((--[\w-]+)\)/)?.[1];
const windowBackground = canvasToken
  ? tokens.match(new RegExp(`${canvasToken}:\\s*(#[\\da-fA-F]+)\\s*;`))?.[1]
  : undefined;
if (!windowBackground) throw new Error("The shared light canvas token is missing");

let electronStarted = false;

export default defineConfig({
  root: ".",
  // Packaged renderers load over file://; public font URLs must stay relative.
  base: "./",
  // Serve and package the same self-hosted fonts as the website.
  publicDir: path.resolve(__dirname, "../public"),
  resolve: {
    // Shared web primitives must use the renderer's React instance.
    dedupe: ["react", "react-dom", "@radix-ui/react-select", "@phosphor-icons/react"],
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
          define: {
            "process.env.ALTO_WINDOW_BACKGROUND": JSON.stringify(windowBackground),
          },
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
