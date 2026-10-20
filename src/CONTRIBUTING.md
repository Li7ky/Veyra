# 开发与验证

在 src/ 目录执行 npm ci，提交前执行 npm run verify。

CI 执行类型检查、ESLint、前端单元测试、IPC 契约检查、Rust 单元测试及前端构建。

新增 IPC 时同步修改 src-tauri/src/commands.rs（dispatch 分支）、src/tauri-bridge.ts（事件映射）和 src/vite-env.d.ts（类型），并运行 npm run check:ipc。

涉及订阅解析、配置转换、状态恢复等纯逻辑时补充针对实际行为的测试（前端 Vitest 或 Rust #[cfg(test)]）。

渲染进程保持与后端隔离：不得直接访问文件系统或执行外部命令，统一走 window.veyra。

订阅、配置文件和 IPC 入参需要校验，外部命令使用参数数组调用。

发布前检查安装包、真实 WebView2、内核资源和独立配置目录中的启动/退出行为。

不要提交个人订阅、密码、令牌、运行日志、截图中的个人信息或本地工具记忆。

不要将本机盘符或用户目录写入构建配置。
