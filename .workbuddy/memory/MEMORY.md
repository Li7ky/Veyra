# Veyra-omini 项目长期约定（跨会话）

## 技术栈与启动
- Electron + React 19 + Vite，源码在 `src/`（渲染层 `src/src/`，主进程 `src/electron/`）。
- 启动 GUI（沙箱内 bash 直启会被杀）：PowerShell 工具 `Start-Process`，
  `$env:ELECTRON_RUN_AS_NODE=$null`，参数 `. --disable-gpu --disable-gpu-compositing --no-sandbox --remote-debugging-port=9223`，cwd=`src`。
- 运行中应用可用 Playwright 连 CDP 调试；截图必须用 CDP 原生 `Page.captureScreenshot` + `fromSurface:false`
  （Playwright 的 page.screenshot 会卡在 "waiting fonts"）。
- 主进程改动（electron/*.cjs、preload）需重启应用生效；渲染层走 HMR。

## 用户设置（%APPDATA%/Veyra/settings.json）
- `secret=aurora-secret`、`theme=light`、`startMinimized=true`（手动启动不会最小化，仅开机自启生效）、`proxyMode=off`。
- 本机常年跑 Clash Verge Rev（E:\Clash）；`blockConflict` 守卫会正确阻止 Veyra 内核启动。
  验证 Veyra 内核功能时需先退出 Clash Verge 或临时关守卫。

## 代码约定（2026-10-15 修复后新增，勿回退）
- **侧栏高度预算**：`.col-sidebar .card-body` 是滚动容器（overflow-y:auto）；860 高窗口下
  导航(8×38)+状态面板 的总高必须 ≤ ~641px 内容区。v12 起状态面板是自然高度贴底（不再拉伸），
  但往侧栏加内容/加内边距前仍必须复测 `body.scrollHeight > body.clientHeight`（溢出会裁底部内容）。
- **面板内文字层级（2026-10-16 v12 修订）**：紧凑贴底状态卡——标签 10px、速率值 13px mono 700、
  facts 值 10.5px mono、状态字 12px、时长胶囊 9.5px。10px 仅限标签/附录层级，数值必须比标签大。
- **侧栏状态面板（v12 定稿结构，勿回退成拉伸式）**：自然高度 + margin-top:auto 贴侧栏底；
  flex:1 拉伸会把 600px+ 面板均摊出四五处 100px 空隙（历史八轮「丑」的最大来源）。
  速率必须用紧凑格式（App.tsx formatRateShort，≤5 字符；title 悬停给全格式）——窄轨道下
  任何「0 B/s」级全格式都会截断（实测 「0 B/s」40px > 列宽 29px 的教训）。
  趋势图是通栏贴底「图带」（负边距 + 面板 overflow:hidden 裁圆角）、常驻 25/50/75% 网格线；
  零流量不画火花线（railHasTraffic 守卫——两条 0 值平线会叠成一条深色横线）。
  98px 内容宽是硬约束：状态行（点+运行中+时长胶囊）的 zh/en 两语言零溢出实测见 `_rail_verify.py`。
- **侧栏局部重设计必看整体语言**：全应用是「白色浮起卡片」语言，左栏子块用 inset 卡
  （bg-soft + radius-md、无边框）；裸排文字/半透明深底是与整体脱节的根源。
  窄轨道（~98px 内容宽）下禁止 2 列以上布局或带空格的文本值（「71 MB」必截断），
  facts 一律单列行式（label 左、值右对齐）。
- **页面保留挂载**：页签切换用 `hidden={tab !== "x"}`（组件常驻），不要再写 `{tab === "x" && (...)}`——
  否则规则/节点编辑草稿、测试结果会静默丢失。前提：CSS 必须有 `[hidden]{display:none!important}`。
- **子标签包裹层**：`.pf-pane { display: contents; }`，保证子元素仍是 `.pane` 的 flex 子项（gap 布局不破）。
- **危险操作**：必须走 `ConfirmDialog`（src/ConfirmDialog.tsx，含 useFocusTrap），默认焦点在「取消」。
- **弹窗**：必须 `useFocusTrap`（Tab 不逃逸）+ Esc 关闭 + 焦点归还入口按钮。
- **字体**：Geist 本地自托管（src/assets/fonts/*.woff2），禁止引外网 CDN 字体。
- **Monaco 主题**：必须跟随 `data-theme`（vs/vs-dark），禁止硬编码。
- **冲突检测排除自家进程**：`conflictGuard.setOwnCorePids()` 由 main.cjs 在 spawn/exit/stop/adopt 时同步；
  adopt 场景经 netstat+wmic 路径核对。排除规则：该进程名的**所有**实例都是自家才跳过（真外部必须照报）。
- **i18n**：日期等本地化文本用 `getLocale()`，不要硬编码 en-US。
- **内核名显示（2026-10-16 统一）**：界面文案一律「Mihomo」（专有名词形式，与内核自报 `Mihomo Meta` 一致）；
  技术标识保持小写 mihomo（`activeCore`/`core` 配置值、`mihomo.exe`、`core-mihomo.txt`、`MIHOMO_CHANNEL`、仓库 MetaCubeX/mihomo）。
  `sing-box` 任何场合保持官方小写；冲突检测里的「Clash Mihomo」是第三方进程名，勿改。

## 验证脚本（项目根目录）
- `_verify_conflict_fix.cjs`：冲突检测误报修复的单元回归（造 mihomo.exe 假进程），6 项断言。
- `_verify_draft.py`：运行中应用的草稿保留实测（需 GUI + CDP 9223）。
- `_ui_audit.py`：全页面截图审计（Web 渲染层，无需 Electron）。
