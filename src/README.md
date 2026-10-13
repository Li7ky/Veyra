# Veyra (Electron · Legacy)

> **本目录为 legacy。** 新功能请到同级的 `veyra-tauri/`（Tauri 2 + Rust）开发。  
> Electron 版仍可打包使用，但不再作为主线迭代。

独立代理客户端，基于 **mihomo（Clash Meta）** 内核。

## 特性

- 混合端口：`127.0.0.1:17897`
- 控制面板：`127.0.0.1:19097`（secret: `veyra-secret`）
- 一键系统代理 / 规则·全局·直连
- 订阅链接导入、节点测速与自动选用最低延迟
- 流量统计、托盘、自定义图标
- 旧版（Aurora / MoonCat / Crescent）数据目录自动迁移，订阅不丢失

## 环境

- Node.js 20+
- Windows 10/11

## 启动

```powershell
cd aurora-proxy
npm install
npm run download-core
npm run build-icons
npm run dev
```

仅预览 UI：

```powershell
npm run dev:web
```

下载内核如需走代理，自行设置环境变量（可选）：

```powershell
$env:HTTP_PROXY="http://127.0.0.1:17897"
$env:HTTPS_PROXY="http://127.0.0.1:17897"
```

## 打包安装包（Windows）

```powershell
# 免安装目录版（可直接运行 D:\Veyra\win-unpacked\Veyra.exe）
npm run dist:dir

# NSIS 安装包（需能访问 GitHub 下载 nsis 工具）
npm run dist
```

产物输出到 `D:\Veyra`（写在 `electron-builder.yml` 的 `directories.output`）：  
- 目录版：`D:\Veyra\win-unpacked\Veyra.exe`  
- 安装包：`Veyra-Setup-1.0.0-x64.exe`（网络不佳时可先用目录版）

> 输出目录刻意放在项目之外：工作区内的构建产物会被编辑器文件监视占用，导致下次打包无法清理旧目录而失败。

## 使用

1. 「订阅」粘贴 Clash/Meta 订阅链接并导入  
2. 「概览」确认代理服务运行 → 点击「打开系统代理」  
3. 「节点」自动测速并选用最优线路  

停止「代理服务」时会自动关闭本软件设置的系统代理，避免指向死端口。  
Veyra 只使用自有端口 `17897` / `19097`，与其它代理软件互不绑定。
## 图标

`scripts/build-icons.mjs` 会从上级目录优先读取 `代理软件图标设计.png`（其次 `图标.png`），居中裁切生成全套应用图标、托盘状态图标（连接=绿点 / 断开=灰点）和 favicon。
