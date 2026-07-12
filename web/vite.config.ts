import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The server proxies /api and /events to the Felix API during `npm run dev:web`.
// In production the built bundle is served by the Felix HTTP server itself.
export default defineConfig({
  // Relative asset URLs so the built bundle also works when a fronting proxy
  // mounts the console under a path prefix (it rewrites the <base href> tag).
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3000", changeOrigin: true },
      "/events": { target: "http://localhost:3000", changeOrigin: true },
    },
  },
});
