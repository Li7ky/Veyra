import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "scripts/**/*.{test,spec}.{cjs,js,mjs}",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["**/*.d.ts", "**/*.test.*", "**/node_modules/**"],
      thresholds: {
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
  },
});
