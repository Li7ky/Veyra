import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyTheme, cachedTheme } from "./theme";

// 首帧用缓存的主题（上次选择/系统偏好），getSettings 返回后再用真实设置校准；
// 之前硬编码 dark，浅色用户启动时会先闪一下深色。
applyTheme(cachedTheme());

// 不用 StrictMode：开发模式双渲染会让 1.5s 轮询下的重渲染翻倍，切换 tab 明显卡顿
createRoot(document.getElementById("root")!).render(<App />);
