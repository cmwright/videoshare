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
      },
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    // The MinIO end-to-end suite needs a running bucket; `npm run test:e2e` opts in.
    exclude: [...configDefaults.exclude, "tests/e2e.minio.test.ts"],
  },
});
