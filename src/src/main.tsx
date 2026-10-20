import { createRoot } from "react-dom/client";
// 中英文字体随应用打包（可变字重 100–900），不再依赖系统是否装了 Geist / 苹方：
// 全站只用这一族，中文与拉丁的字重、字宽、基线和 emoji 回退都统一
import "@fontsource-variable/noto-sans-sc";
import App from "./App";
import "./styles.css";
import "./ui/v2.css";
import "./ui/v3.css";
import { applyTheme, cachedTheme } from "./theme";
import { installTauriBridge } from "./tauri-bridge";

// 纯浏览器预览（npm run dev:web）：注入 mock IPC，并允许用 ?theme= 固定主题。
// 仅 DEV 生效，正式构建里这段会被 tree-shake 掉。
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  const q = new URLSearchParams(location.search);
  const theme = q.get("theme");
  if (theme === "light" || theme === "dark") {
    try {
      localStorage.setItem("veyra-theme", theme);
    } catch {
      /* 忽略 */
    }
  }
  await new Promise<void>((resolve) => {
    const s = document.createElement("script");
    s.src = "/mock-ipc.js";
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.head.appendChild(s);
  });
}

// Tauri 没有 preload，用同形状的桥接层注入 window.veyra。
installTauriBridge();

// 首帧用缓存的主题（上次选择/系统偏好），getSettings 返回后再用真实设置校准；
// 之前硬编码 dark，浅色用户启动时会先闪一下深色。
applyTheme(cachedTheme());

// 不用 StrictMode：开发模式双渲染会让 1.5s 轮询下的重渲染翻倍，切换 tab 明显卡顿
createRoot(document.getElementById("root")!).render(<App />);
