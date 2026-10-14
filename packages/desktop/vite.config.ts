import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// Browser-only dev (no Tauri window): `/daemon/*` is proxied to the daemon so the UI can be
// developed and tested in a normal browser. Inside Tauri, calls go through the Rust `api` command instead.
const DAEMON = process.env.DAEMON_URL ?? `http://127.0.0.1:${process.env.PORT || 5777}`;
const TOKEN = process.env.TOKEN ?? "";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
    proxy: {
      "/daemon": {
        target: DAEMON,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/daemon/, ""),
        headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      },
    },
  },
});
