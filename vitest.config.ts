import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@uptime402/domain": `${root}packages/domain/src/index.ts`,
      "@uptime402/policy": `${root}packages/policy/src/index.ts`,
      "@uptime402/payments": `${root}packages/payments/src/index.ts`,
      "@uptime402/persistence": `${root}packages/persistence/src/index.ts`,
      "@uptime402/vendor-agent": `${root}services/vendor-agent/src/index.ts`,
      "@uptime402/payment-executor": `${root}services/payment-executor/src/index.ts`,
      "server-only": `${root}tests/fixtures/server-only.ts`
    }
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    sequence: { concurrent: false },
    coverage: { reporter: ["text", "json-summary"] }
  }
});
