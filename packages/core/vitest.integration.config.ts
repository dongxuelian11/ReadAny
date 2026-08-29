import { defineConfig } from "vitest/config";

// Integration-only config for the pinned-TKG real pipeline test. Deliberately
// NOT matched by the main vitest config (src/**/*.test.ts) so the blocking
// quality suite keeps its exact file/test truth; CI runs this config in the
// dedicated blocking-tkg-integration job.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/book-skill/integration/**/*.int.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    passWithNoTests: false,
  },
});
