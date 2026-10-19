import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

/**
 * Veyra 代码规范基线（ESLint 9 flat config）
 *
 * 设计原则：
 * 1. 渲染层用严格档（react-hooks 全开），主进程用务实档——主进程大量使用
 *    Node 回调式 API，过度严格会逼出大量无意义改动。
 * 2. 先以 warn 落地存量问题，不阻塞构建；新代码由 CI 的 --max-warnings 收紧。
 */
export default tseslint.config(
  { ignores: ["dist", "dist-electron", "node_modules", "resources", "outputs", "playwright-report", "scripts/bin", "src-tauri"] },

  // ── 渲染进程（src/**）──────────────────────────────────────────
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // react-hooks v7 起 recommended 把 React Compiler 规则设为 error：存量代码里
      // effect 内同步 setState（ConnectionsPage / RulesPage / SettingsPanel / YamlEditor）
      // 与渲染期取时间戳（TestsPage）会被一次性判死。按本项目「先以 warn 落地存量问题，
      // 不阻塞构建」的基线降级为告警，避免门禁反向锁死所有提交。
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      // 本项目 UI 文案直出中文，禁止遗留调试语句
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // any 是技术债的主要来源，新代码禁止，存量逐步清理
      "@typescript-eslint/no-explicit-any": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      eqeqeq: ["warn", "smart"],
      "prefer-const": "warn",
    },
  },

  // ── 构建脚本（scripts/**，ESM）─────────────────────────────────
  {
    files: ["scripts/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-console": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-useless-escape": "warn",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  // ── 浏览器内执行的注入脚本（scripts/**/*.cjs，用 page.evaluate 求值）──
  {
    files: ["scripts/**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-console": "off",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },

  // ── 配置文件 ─────────────────────────────────────────────────
  {
    files: ["*.config.js", "*.config.ts"],
    languageOptions: { globals: globals.node },
  }
);
