# Veyra 页签切换性能优化

项目：`D:/veyra-latest/src`
测量方式：Electron 窗口接入远程调试（CDP），脚本真实点击导航按钮并计时。`scripts/bench-robust.cjs` 可复现。

## 一、根因

CPU Profile（`scripts/profile-tab.cjs`）显示切换耗时的绝对大头是：

| 采样占比最高的函数 | 性质 |
| --- | --- |
| `exports.jsxDEV`（react_jsx-dev-runtime） | React **开发模式**专用 JSX 工厂 |
| `validateProperty` / `validatePropertiesInDevelopment` | React 开发模式属性校验 |
| `StrictMode` 双次渲染 | 开发模式下每个组件渲染两遍 |

也就是说，卡顿的主要来源是 **dev 模式本身**，不是业务逻辑。

叠加三个真实的代码瓶颈：

1. **规则页把每条规则都渲染成 DOM**：真实数据下 5710 个节点（约 800 条规则），列表容器却只有 280px 高。
2. **订阅页用 CSS `display:none` 隐藏子标签，但全部区块始终挂载**：每次打开都重建 Monaco 编辑器和两个可视化编辑器。
3. **代理页节点一次性补齐**：`pxNodeLimit` 从 30 直接跳到全量，185 张卡片挤在一次提交里 → 51ms 长任务卡顿。

## 二、已做的改动

| 文件 | 改动 |
| --- | --- |
| `src/RulesPage.tsx` | 规则列表改为虚拟滚动，只渲染可视区 + 上下缓冲；行高实测自适应 |
| `src/App.tsx` | 订阅页子标签「首次访问才挂载」；代理页节点改为逐帧分批（30 + 60/帧）；`nodeSort` 等设置写回 |
| `src/App.tsx` | `changeTheme` / `onPorts` / `onPrefs` 用 `useCallback` 稳定引用，使 memo 生效 |
| `src/ConnectionsPage.tsx`、`RulesPage.tsx`、`TestsPage.tsx`、`SettingsPanel.tsx` | 加 `memo` 包裹，父组件重渲染时不再连带重渲染 |
| `scripts/bench-robust.cjs`、`scripts/profile-tab.cjs` | 新增性能测量脚本 |

### 曾尝试但已回滚

页签保活（保留已访问页签、用 `hidden` 切换）**实测更慢**：总 DOM 从 334 涨到 7353，每次切换约 300ms。原因是父组件重渲染时会连带协调所有保活页签。已完全移除。

## 三、测量结果

### DOM 节点数（同一份真实数据）

| 页面 | 优化前 | 优化后 |
| --- | --- | --- |
| 规则 | 5710 | **266** |
| 订阅 | 202 | **97** |
| 代理 | 321 | 316 ~ 554（分批补齐后） |

### 切换耗时（当前代码，同一套测量工具）

单位 ms，`冷`=本次启动后首次进入，`热`=再次进入。阻塞=点击后主线程同步阻塞时间。

| 页面 | dev 冷 | dev 热 | prod 冷 | prod 热 |
| --- | --- | --- | --- | --- |
| 首页 | 5 | 75 | 30 | 7 |
| 代理 | 111 | 226 | 24 | 40 |
| 订阅 | 24 | 60 | 6 | 4 |
| 连接 | 74 | 25 | 6 | 5 |
| 规则 | 21 | 29 | 5 | 5 |
| 日志 | 58 | 10 | 5 | 5 |
| 测试 | 35 | 19 | 7 | 6 |
| 设置 | 24 | 22 | 9 | 5 |

两种模式下同步阻塞均约 0~1ms；生产构建比开发模式快约 **2~5 倍**，全部页签稳定在 **4~40ms**。

## 四、建议

1. **日常使用请跑生产构建**，不要用 `npm run dev`。开发模式带有 `jsxDEV`、属性校验和 StrictMode 双次渲染，这部分开销无法通过业务代码消除。
   - 打包：`npm run dist`（生成安装包）或 `npm run dist:dir`（生成免安装目录）
2. 若仍需在 dev 下调试并希望更快，可临时移除 `src/main.tsx` 中的 `<StrictMode>`，但会失去开发期的副作用检查。
3. `scripts/bench-robust.cjs` 可随时复测：先以 `--remote-debugging-port=9222` 启动应用，再运行该脚本。
