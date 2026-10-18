# 开发与验证

在 src/ 目录执行 npm ci，提交前执行 npm run verify。
CI 执行类型检查、ESLint、单元测试、IPC 契约检查及前端构建。

新增 IPC 时同步修改 electron/main.cjs、electron/preload.cjs 和 src/vite-env.d.ts，并运行 npm run check:ipc。
涉及订阅解析、配置转换、状态恢复等纯逻辑时补充针对实际行为的测试。
渲染进程保持 contextIsolation: true 和 nodeIntegration: false。
订阅、配置文件和 IPC 入参需要验证，外部命令使用参数数组调用。

发布前检查安装包、真实 preload、内核资源和独立配置目录中的启动/退出行为。
不要提交个人订阅、密码、令牌、运行日志、截图中的个人信息或本地工具记忆。
不要将本机盘符或用户目录写入构建配置。
源码发布使用审核后的独立快照，原开发仓库的历史可能包含个人配置，不应直接推送。
