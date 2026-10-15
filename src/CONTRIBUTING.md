# 工程规范与质量门禁

> 本文件面向团队全员。目标是把「靠自觉」变成「靠机制」——让低级问题在提交前就被拦住，
> 让代码评审专注于设计和逻辑，而不是格式和拼写。

## 一、日常命令

```bash
cd src

npm run dev          # 开发（Vite + Electron）
npm run typecheck    # 类型检查（tsc -b）
npm run lint         # 代码规范检查
npm run lint:fix     # 自动修复可修复的问题
npm run format       # Prettier 格式化
npm run test         # 单元测试（Vitest）
npm run test:watch   # 测试监听模式
npm run test:coverage# 测试覆盖率
npm run check:ipc    # IPC 契约一致性校验
npm run verify       # 全部检查 + 构建（提交前跑一遍）
```

**提交前请跑 `npm run verify`。** 装了 pre-commit 钩子后会自动执行大部分检查。

## 二、质量门禁（三层）

| 层级 | 时机 | 检查内容 | 命令 |
|---|---|---|---|
| 本地钩子 | `git commit` | 类型 + 规范 + 测试 + IPC 契约 | `.git/hooks/pre-commit` |
| CI | push / PR | 同上 + 格式检查 + 构建 | `.github/workflows/ci.yml` |
| 手动 | 需要时 | 全量 | `npm run verify` |

### 启用本地钩子（每人首次需执行一次）

```bash
cd src
node scripts/install-git-hooks.mjs
```

钩子由 `scripts/pre-commit` 提供，安装在仓库根的 `.git/hooks/pre-commit`。

> 紧急情况可 `git commit --no-verify` 跳过，但 CI 仍会拦——**跳过钩子不能绕过 CI**。

## 三、IPC 契约：三处必须同步

Veyra 的渲染进程 ↔ 主进程通信契约分散在三处，任何一处漏改都会产生静默 Bug：

| 位置 | 作用 |
|---|---|
| `electron/preload.cjs` | 实际暴露给渲染进程的 API |
| `electron/main.cjs` | `ipcMain.handle(...)` 注册的 channel |
| `src/vite-env.d.ts` | 渲染进程看到的 TypeScript 类型 |

**历史教训**：`onCoreProgress` 曾在 preload 与主进程都实现完整，但类型定义漏了，
直接导致 `tsc` 报错、构建中断（因为 `npm run build` 第一步就是 `tsc -b`）。

因此新增/修改 IPC 时，**三处必须一起改**，然后跑：

```bash
npm run check:ipc
```

该脚本会比对三处的 channel 与 API 名，不一致直接报错退出。

### 新增一个 IPC 的正确步骤

1. `electron/main.cjs` 中加 `ipcMain.handle("域:动作", async (_e, ...args) => {...})`
2. `electron/preload.cjs` 中加对应包装函数 `动作: (args) => ipcRenderer.invoke("域:动作", args)`
3. `src/vite-env.d.ts` 的 `VeyraAPI` 接口中补类型声明
4. 跑 `npm run check:ipc` 与 `npm run typecheck` 确认一致

## 四、测试约定

### 优先测什么

按投入产出比排序：

1. **纯函数**（无 IO、无 DOM）——最快、最稳、最有价值
2. **配置转换逻辑**——例如 `clash2singbox`，出错会导致用户全部断网
3. **解析逻辑**——例如 `uri-import`，输入来源不可控
4. **数据字典完整性**——例如 i18n，缺失项难以人工发现

不建议一开始就给 React 组件写测试：本项目的组件与全局状态强耦合，
测试成本高且容易变成「改一次实现就要改一次测试」的负担。
**先拆组件、再测组件。**

### 测试文件命名

- 与被测文件同名 + `.test.mjs` 后缀（如 `uri-import.test.mjs`）
- 使用 ESM（`import`/`export`）——`.cjs` 会被解析为 CommonJS，导致 `import` 报错
- TypeScript 测试用 `.test.ts`

### 已有测试基线（58 个用例）

| 文件 | 覆盖内容 |
|---|---|
| `electron/uri-import.test.mjs` | 节点 URI 解析（SS/VMess/VLESS/Trojan）、YAML 生成、重名去重、信息节点过滤 |
| `electron/clash2singbox.test.mjs` | Clash→sing-box 转换：出站、保底、分组、端口、日志级别、异常输入 |
| `src/i18n.test.ts` | 回退链、key 完整性、locale 元数据 |
| `scripts/verify-checksum.test.mjs` | 校验文件解析（多种排版兼容） |

### 一个真实收获

写 `uri-import` 测试时，最初的断言假设「非法输入返回 `null`」，
实际实现是**抛异常**。测试失败暴露了这个契约差异——
这类认知偏差正是测试的价值所在：**它记录真实行为，而不是你以为的行为。**

## 五、安全约定

### 渲染进程（重要）

订阅内容来自不可信来源（用户粘贴的 URL / 配置文件），必须假设其中可能含恶意载荷：

- **禁止** `innerHTML` 渲染订阅/配置内容
- 项目已设置 `contextIsolation: true` / `nodeIntegration: false`，**不要改动这两个值**
- 已加导航护栏（`will-navigate` + `setWindowOpenHandler`），阻止窗口被导航到外部站点
- `open:external` 只放行 `http:` / `https:`，会拒绝 `file:` / `ms-*:` 等协议

### 主进程

- 外部命令一律用 `execFile` / `execFileSync` 传**参数数组**，不要拼字符串走 shell
  （现有代码 `taskkill`/`reg`/`powershell` 调用已是正确写法，请保持）
- 涉及用户输入的路径，落盘前用 `safeName` 之类做字符过滤
- 新增 IPC 入参应做类型/范围校验，不要直接信任渲染层传来的值

### 依赖与内核

- 内核下载已加 sha256 校验（`scripts/verify-checksum.mjs`）
- 拿到官方摘要时**校验失败会直接中止安装**，不会执行可疑二进制
- 拿不到官方摘要时会**显式告警**而非静默放行

## 六、已知技术债（按优先级）

这些是当前已知问题，按建议顺序处理：

### P0 —— 影响可维护性，建议优先

1. **`electron/main.cjs` 2670 行 / 95KB**
   78 个函数、76 个 IPC handler 全在一个文件。
   建议按域拆分：`ipc/`（注册与参数校验）、`core/`（内核生命周期）、
   `proxy/`（系统代理与端口）、`settings/`（配置读写）。

2. **`src/App.tsx` 2198 行**
   68 个 `useState`、14 个 `useEffect`、121 个 hooks 调用集中在单个组件。
   建议先抽自定义 hook（`useTraffic`、`useSpeedTest`、`useProfiles`），
   再拆页面级组件，最后把纯函数移到 `utils/`。

### P1 —— 一致性

3. **74 个 lint 警告**，其中 65 个是未使用的变量/导入
   （含 12 个未使用的图标导入、`InfoRow` 组件、多个已废弃的 setter）。
   大多是重构残留，删除即可。

4. **`react-hooks/exhaustive-deps` 警告 2 处**
   （`App.tsx` 的 `useCallback` 缺 `applyStatus`、`useEffect` 缺 `showToast`）。
   依赖缺失是闭包 Bug 的经典来源，建议逐个确认后显式补全或加说明注释。

5. **i18n 覆盖率**
   声明 13 种语言，实际 `zh` 130 条、`en` 65 条，其余 11 种仅少量词条 + 回落英文。
   要么补齐翻译，要么在 UI 上标注「部分翻译」，避免用户预期落差。

### P2 —— 优化

6. **`styles.css` 2068 行单文件**，同时 `App.tsx` 内还有 69 处行内样式。
   建议行内样式下沉到 CSS 类，样式文件按页面拆分。

7. **构建产物体积**：`YamlEditor` chunk 4.0MB（Monaco 编辑器）。
   已做懒加载，可进一步用 `manualChunks` 拆分 Monaco 语言包，
   或换用更轻量的编辑器（本项目只需要 YAML 高亮）。

8. **子路径重复**：仓库结构是 `veyra-latest/src/src/App.tsx`，
   `src` 下又有一个 `src`，容易在路径引用上出错。建议理顺目录层级。

## 七、代码评审检查清单

提交 PR 前自查，评审人也按此检查：

- [ ] `npm run verify` 通过
- [ ] 新增 IPC 的三处（preload / main / 类型）已同步
- [ ] 新增纯逻辑有对应测试
- [ ] 没有引入新的 `any`（存量 `any` 见 P2 清单）
- [ ] 没有新增未使用的变量/导入
- [ ] 涉及外部输入的代码做了校验或过滤
- [ ] 没有改动 `contextIsolation` / `nodeIntegration`
- [ ] 大文件改动考虑过是否应拆分模块
