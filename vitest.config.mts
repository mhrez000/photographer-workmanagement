import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: false,
    env: { DATABASE_PATH: ":memory:", SESSION_SECRET: "test-secret-test-secret-test-secret-test-secret" },
  },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
});
