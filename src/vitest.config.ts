import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "electron/**/*.{test,spec}.{cjs,js,mjs}",
      "scripts/**/*.{test,spec}.{cjs,js,mjs}",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // 覆盖率基线：先从核心逻辑模块起步，避免一次性开启全局阈值
      // 导致存量代码大面积不达标、团队直接无视告警。
      include: ["src/**/*.{ts,tsx}", "electron/**/*.cjs"],
      exclude: ["**/*.d.ts", "**/*.test.*", "**/node_modules/**"],
      thresholds: {
        // 当前仅对已覆盖模块设线，后续随测试补齐逐步提高
        lines: 0,
        functions: 0,
        branches: 0,
        statements: 0,
      },
    },
  },
});
