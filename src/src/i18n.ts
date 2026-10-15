export type Locale = "zh" | "en" | "ja" | "ru" | "es" | "de" | "pt" | "ko" | "fr" | "id" | "tr" | "fa" | "ar";

type Dict = Record<string, string>;

const zh: Dict = {
  "nav.home": "首页",
  "nav.proxies": "代理",
  "nav.profiles": "订阅",
  "nav.connections": "连接",
  "nav.rules": "规则",
  "nav.logs": "日志",
  "nav.tests": "测试",
  "nav.settings": "设置",
  "tab.home.title": "概览",
  "tab.home.sub": "实时掌握代理运行状态与流量",
  "tab.proxies.title": "节点",
  "tab.proxies.sub": "选择最低延迟的出站节点",
  "tab.profiles.title": "订阅",
  "tab.profiles.sub": "订阅、增强、Provider 与运行时配置",
  "tab.rules.title": "规则",
  "tab.rules.sub": "可视化编辑路由规则",
  "tab.connections.title": "连接",
  "tab.connections.sub": "筛选、排序与单条断开",
  "tab.logs.title": "日志",
  "tab.logs.sub": "查看内核实时输出",
  "home.versionUnknown": "版本未知",
  "home.configureCards": "自定义首页卡片",
  "tab.tests.title": "测试",
  "tab.tests.sub": "延迟检测、出口 IP、流媒体解锁",
  "tab.settings.title": "设置",
  "tab.settings.sub": "网络 / TUN / DNS / 备份 / 热键",
  "sec.core": "内核",
  "sec.network": "网络",
  "sec.tun": "TUN",
  "sec.dns": "DNS",
  "sec.system": "系统",
  "sec.hotkeys": "热键",
  "sec.appearance": "外观",
  "sec.backup": "备份",
  "sec.tools": "工具",
  "sec.about": "关于",
  "common.refresh": "刷新",
  "common.save": "保存",
  "common.cancel": "取消",
  "exit.ip": "出口 IP",
  "exit.click": "点击检测",
  "unlock.run": "流媒体检测",
  "lightweight.on": "轻量模式已开启",
  "lightweight.off": "轻量模式已关闭",
};

const en: Dict = {
  "nav.home": "Home",
  "nav.proxies": "Proxies",
  "nav.profiles": "Profiles",
  "nav.tests": "Tests",
  "nav.rules": "Rules",
  "nav.connections": "Connections",
  "nav.logs": "Logs",
  "nav.settings": "Settings",
  "tab.home.title": "Overview",
  "tab.home.sub": "Live traffic and proxy status",
  "tab.proxies.title": "Proxies",
  "tab.proxies.sub": "Pick the lowest-latency outbound",
  "tab.profiles.title": "Profiles",
  "tab.profiles.sub": "Subscriptions, enhance, providers, runtime",
  "tab.rules.title": "Rules",
  "tab.rules.sub": "Visual rule editor",
  "tab.connections.title": "Connections",
  "tab.connections.sub": "Filter, sort, close",
  "tab.logs.title": "Logs",
  "tab.logs.sub": "Core output",
  "home.versionUnknown": "Version unknown",
  "home.configureCards": "Customize cards",
  "tab.tests.title": "Tests",
  "tab.tests.sub": "Delay, exit IP, streaming unlock",
  "tab.settings.title": "Settings",
  "tab.settings.sub": "Network / TUN / DNS / Backup / Hotkeys",
  "sec.core": "Core",
  "sec.network": "Network",
  "sec.tun": "TUN",
  "sec.dns": "DNS",
  "sec.system": "System",
  "sec.hotkeys": "Hotkeys",
  "sec.appearance": "Appearance",
  "sec.backup": "Backup",
  "sec.tools": "Tools",
  "sec.about": "About",
  "common.refresh": "Refresh",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "exit.ip": "Exit IP",
  "exit.click": "Detect",
  "unlock.run": "Unlock check",
  "lightweight.on": "Lightweight mode on",
  "lightweight.off": "Lightweight mode off",
};

/** 其余语言先回落英文，保证 13 语种入口齐全 */
function fallback(base: Dict, overlay: Partial<Dict>): Dict {
  return { ...base, ...(overlay as Dict) };
}

const catalogs: Record<Locale, Dict> = {
  zh,
  en,
  ja: fallback(en, { "nav.home": "ホーム", "nav.settings": "設定", "nav.proxies": "プロキシ" }),
  ru: fallback(en, { "nav.home": "Главная", "nav.settings": "Настройки" }),
  es: fallback(en, { "nav.home": "Inicio", "nav.settings": "Ajustes" }),
  de: fallback(en, { "nav.home": "Start", "nav.settings": "Einstellungen" }),
  pt: fallback(en, { "nav.home": "Início", "nav.settings": "Configurações" }),
  ko: fallback(en, { "nav.home": "홈", "nav.settings": "설정" }),
  fr: fallback(en, { "nav.home": "Accueil", "nav.settings": "Paramètres" }),
  id: fallback(en, { "nav.home": "Beranda", "nav.settings": "Pengaturan" }),
  tr: fallback(en, { "nav.home": "Ana sayfa", "nav.settings": "Ayarlar" }),
  fa: fallback(en, { "nav.home": "خانه", "nav.settings": "تنظیمات" }),
  ar: fallback(en, { "nav.home": "الرئيسية", "nav.settings": "الإعدادات" }),
};

let current: Locale = "zh";

export function setLocale(locale: string) {
  const l = (locale || "zh") as Locale;
  current = catalogs[l] ? l : "zh";
  try {
    document.documentElement.lang = current;
  } catch {
    /* 非浏览器环境（SSR/测试）无 document，忽略 */
  }
}

export function getLocale(): Locale {
  return current;
}

export function t(key: string, fallbackText?: string): string {
  return catalogs[current][key] || catalogs.en[key] || catalogs.zh[key] || fallbackText || key;
}

export const LOCALE_OPTIONS: { id: Locale; label: string }[] = [
  { id: "zh", label: "简体中文" },
  { id: "en", label: "English" },
  { id: "ja", label: "日本語" },
  { id: "ru", label: "Русский" },
  { id: "es", label: "Español" },
  { id: "de", label: "Deutsch" },
  { id: "pt", label: "Português" },
  { id: "ko", label: "한국어" },
  { id: "fr", label: "Français" },
  { id: "id", label: "Bahasa Indonesia" },
  { id: "tr", label: "Türkçe" },
  { id: "fa", label: "فارسی" },
  { id: "ar", label: "العربية" },
];
