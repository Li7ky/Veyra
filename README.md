# Veyra-omini

[![Version](https://img.shields.io/badge/version-1.1.9--beta.4-blue)](https://github.com/Li7ky/Veyra-omini/releases/tag/v1.1.9-beta.6)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D4)](https://github.com/Li7ky/Veyra-omini/releases)
[![Core](https://img.shields.io/badge/core-mihomo-0B7A75)](https://github.com/MetaCubeX/mihomo)
[![Status](https://img.shields.io/badge/status-测试版-orange)](https://github.com/Li7ky/Veyra-omini/releases/tag/v1.1.9-beta.6)

适用于 Windows 10/11 x64 的本地代理客户端。界面基于 Electron 与 React，转发内核为 mihomo，可直接导入已有的 Clash / Mihomo 订阅和节点链接。

当前版本 **1.1.9-beta.6** 为测试版。安装包未做代码签名，不作为稳定版的兼容性承诺。本软件不提供节点或订阅服务。

**[下载 Windows x64 安装包（约 137 MB）](https://github.com/Li7ky/Veyra-omini/releases/download/v1.1.9-beta.6/Veyra-omini-Setup-1.1.9-beta.6-x64.exe)** · [发布说明](https://github.com/Li7ky/Veyra-omini/releases/tag/v1.1.9-beta.6)

## 为什么选择 Veyra-omini

| 优点 | 说明 |
| --- | --- |
| 兼容现有订阅 | 支持 Clash / Mihomo 订阅与节点链接，订阅名称、流量和到期信息从机场响应头读取，无需改用专用格式 |
| 数据留在本机 | 订阅、节点和运行配置保存在本地；软件只负责接入与切换，不代售节点 |
| 一条路径完成日常操作 | 实时流量、延迟、出口 IP、连接查看、节点切换、规则编辑和 YAML 修改都在同一客户端内完成 |
| 接入方式可按场景选择 | 系统代理、PAC 与 TUN 可按需要开启；托盘可在窗口关闭后继续控制 |
| 降低与本机代理冲突 | 检测到外部系统代理时会提示并拦截覆盖，避免安装后冲掉正在使用的系统代理 |
| 界面适合日常使用 | 提供浅色与深色主题；订阅、节点、连接和规则均可在图形界面中完成 |

## 功能概览

- **订阅管理**：导入、更新、编辑、删除订阅，并在多条订阅之间切换。
- **节点与测速**：延迟测试、代理模式切换、实时上下行速率。
- **连接与规则**：查看活跃连接、断开单条连接、可视化编辑规则。
- **系统接入**：系统代理、PAC、TUN、DNS、开机启动、热键与配置备份。
- **进阶能力**：配置增强预览、YAML 编辑、内核日志；实验性 sing-box 支持（安装包仅附带 mihomo）。

## 快速开始

1. 下载并运行安装包。发布页只提供安装包本体，请确认来源为本仓库的 Releases。
2. 导入自己的订阅或本地配置。
3. 选择节点后，按需开启系统代理或 TUN。

升级前建议备份配置。提交 Issue 时请附上 Windows 版本和复现步骤，并去掉订阅令牌、节点密码和个人信息。仓库页面的 **Code → Download ZIP** 下载的是源码，不是安装包。

## 测试版说明

自动化测试不能代替不同 Windows 版本、网络环境和真实订阅下的兼容性验证。以下项目尚未完成实际环境验证：

- Windows 11
- 应用接管系统代理后的端到端联网
- PAC、TUN、服务模式、sing-box
- 逐页人工交互验收

本次测试版已在 Windows 10 x64 上完成安装、卸载、应用接口检查，以及附带 mihomo 的本地 HTTP 转发验证。详细结果见 [发布说明](https://github.com/Li7ky/Veyra-omini/releases/tag/v1.1.9-beta.6)。

## 开发与构建

需要 Node.js 22、npm 和 Windows 10/11 x64。

```powershell
cd src
npm ci
npm run dev
```

仅做静态检查时，可执行 `npm ci --ignore-scripts`。

```powershell
npm run verify
npm run dist
```

`npm run verify` 包含类型检查、ESLint、单元测试、IPC 契约检查和前端构建。`npm run dist` 生成的安装包位于仓库根目录的 `release/`。

默认代理端口 `17897`，控制端口 `19097`，可在设置中修改。默认控制密钥仅供本机使用，对局域网开放前应自行更换。

## 第三方组件

第三方组件的完整许可证清单位于 [src/resources/licenses/THIRD_PARTY_NOTICES.md](src/resources/licenses/THIRD_PARTY_NOTICES.md)，并随安装包内的 `resources/licenses` 一并分发。本项目自有代码的开源许可证尚未指定，第三方许可证不自动授予本项目自有代码的使用授权。
