import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      // 排除 Rust 编译输出目录，防止文件锁冲突（EBUSY）
      ignored: ["**/src-tauri/target/**", "**/target/**"],
    },
  },
  base: "./",
});
