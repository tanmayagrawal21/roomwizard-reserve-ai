import { defineConfig } from "vite";

/**
 * Separate from vite.config.ts deliberately — the React/Tailwind plugins
 * there are build concerns the pure-logic tests in lib/ don't need, and
 * loading them would slow the test run for no benefit.
 */
export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
