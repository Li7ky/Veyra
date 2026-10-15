export type ThemeMode = "light" | "dark" | "system";

const THEME_CACHE_KEY = "veyra-theme";

/** 读取上次应用的主题（启动首帧用，避免设置回传前闪一下默认主题） */
export function cachedTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_CACHE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* localStorage 不可用时回退到系统主题，不影响渲染 */
  }
  return "system";
}

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return "dark";
}

export function applyTheme(mode: ThemeMode) {
  const resolved = resolveTheme(mode);
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.style.colorScheme = resolved;
  try {
    localStorage.setItem(THEME_CACHE_KEY, mode);
  } catch {
    /* 写入失败只影响下次启动的首帧主题，主题本身已应用到 DOM */
  }
  return resolved;
}
