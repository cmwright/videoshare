import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/e2e.minio.test.ts", "tests/e2e.gateway.test.ts"],
    // MinIO round-trips move ~10 MB per case; the default 5 s is not enough.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
