import path from "path";
import { defineConfig } from "vitest/config";

// Vitest config for klik_spa unit tests. Pure-logic utilities (money math, cart pricing)
// need no DOM, so the default environment is node. Add jsdom + a separate project later
// if component tests are introduced.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: false,
  },
});
