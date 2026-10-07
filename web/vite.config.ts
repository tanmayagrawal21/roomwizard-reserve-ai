import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * GitHub Pages serves a project site from `/<repo>/`, so production asset URLs
 * need that prefix or they 404. Dev is served from the root, because a subpath
 * there just means `localhost:5173/` redirects and every link is noisier.
 *
 * Override with VITE_BASE for a custom domain (`VITE_BASE=/`).
 */
export default defineConfig(({ command }) => ({
  base: process.env.VITE_BASE ?? (command === "build" ? "/roomwizard-reserve-ai/" : "/"),
  plugins: [react(), tailwindcss()],
  server: { port: 5173 },
}));
