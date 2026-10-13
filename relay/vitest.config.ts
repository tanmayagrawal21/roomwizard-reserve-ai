import { defineConfig } from "vitest/config";

/** Plain Node environment; the relay has no DOM dependencies. */
export default defineConfig({
  test: {
    environment: "node",
  },
});
