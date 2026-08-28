import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const page = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

export default defineConfig({
  // Relative asset URLs so dist/ works from any path (domain root, subpath, or the bucket itself).
  base: "./",
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        index: page("index.html"),
        view: page("view.html"),
        stats: page("stats.html"),
      },
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    // The end-to-end suites need a running bucket; `npm run test:e2e` opts in.
    // Both are listed: either one left in would be collected and reported as
    // skipped, which reads like a failing guard rather than a suite that is off.
    exclude: [
      ...configDefaults.exclude,
      "tests/e2e.minio.test.ts",
      "tests/e2e.gateway.test.ts",
    ],
  },
});
