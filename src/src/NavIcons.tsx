// 导航图标：线性几何风格，几何感、圆润收角。
// 颜色一律走 currentColor，由容器决定（.nav-item = --text-400 中性 / .nav-item.active = --accent）。
import type { ReactNode } from "react";

function Ico({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={22}
      height={22}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

// 此前每个 tab 硬编码专属色（8 色相）：色彩不承载状态信息，只是噪音，
// 且激活态的品牌蓝底会与紫 / 青图标撞色。现统一交给容器着色。

export function NavHomeIcon() {
  return (
    <Ico>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10.5V20h12v-9.5" />
      <path d="M10 20v-5h4v5" />
    </Ico>
  );
}

export function NavProxiesIcon() {
  // 重设计：服务器层叠 + 信号弧线，代表代理节点
  return (
    <Ico>
      <rect x="4" y="4" width="16" height="6" rx="2" />
      <rect x="4" y="14" width="16" height="6" rx="2" />
      <path d="M8 7h.01" strokeWidth={2.8} />
      <path d="M8 17h.01" strokeWidth={2.8} />
      <path d="M12 10v4" strokeDasharray="1.5 2" />
    </Ico>
  );
}

export function NavProfilesIcon() {
  return (
    <Ico>
      <rect x="4" y="3.5" width="16" height="7" rx="2.5" />
      <rect x="4" y="13.5" width="16" height="7" rx="2.5" />
      <path d="M8 7h4" />
      <path d="M8 17h4" />
    </Ico>
  );
}

export function NavConnectionsIcon() {
  return (
    <Ico>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.8 2.3 4.2 5.2 4.2 8.5s-1.4 6.2-4.2 8.5c-2.8-2.3-4.2-5.2-4.2-8.5s1.4-6.2 4.2-8.5z" />
    </Ico>
  );
}

export function NavRulesIcon() {
  return (
    <Ico>
      <path d="M5 6h14" />
      <path d="M5 12h14" />
      <path d="M5 18h9" />
      <circle cx="18.5" cy="18" r="2.3" />
    </Ico>
  );
}

export function NavLogsIcon() {
  return (
    <Ico>
      <path d="M6 3.5h9l4 4v13H6z" />
      <path d="M15 3.5v4h4" />
      <path d="M9.5 12h6" />
      <path d="M9.5 15.5h6" />
    </Ico>
  );
}

export function NavTestsIcon() {
  return (
    <Ico>
      <path d="M10 3.5h4" />
      <path d="M11 3.5v5.2L5.8 17a2.4 2.4 0 0 0 2.1 3.5h8.2a2.4 2.4 0 0 0 2.1-3.5L13 8.7V3.5" />
      <path d="M8.2 14.5h7.6" />
    </Ico>
  );
}

export function NavSettingsIcon() {
  return (
    <Ico>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v3M12 18.2v3M2.8 12h3M18.2 12h3M5.5 5.5l2.1 2.1M16.4 16.4l2.1 2.1M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1" />
    </Ico>
  );
}

// ===== 首页卡片图标：同风格定制 =====
function CardIco({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      aria-hidden="true"
      fill="none"
      stroke={color}
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function CardSubIcon() {
  // 订阅：链环
  return (
    <CardIco color="#7c3aed">
      <path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1.5 1.5" />
      <path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1.5-1.5" />
    </CardIco>
  );
}

export function CardNodeIcon() {
  // 当前节点：纸飞机
  return (
    <CardIco color="#0ea5e9">
      <path d="M21 3 10 14" />
      <path d="M21 3 14 21l-4-7-7-4 18-7z" />
    </CardIco>
  );
}

export function CardNetIcon() {
  // 网络设置：枢纽节点 + 连接
  return (
    <CardIco color="#2c71e8">
      <circle cx="12" cy="12" r="3" />
      <circle cx="5" cy="5" r="1.5" />
      <circle cx="19" cy="5" r="1.5" />
      <circle cx="5" cy="19" r="1.5" />
      <circle cx="19" cy="19" r="1.5" />
      <path d="M6.5 6.5 10 10M17.5 6.5 14 10M6.5 17.5 10 14M17.5 17.5 14 14" />
    </CardIco>
  );
}

export function CardModeIcon() {
  // 代理模式：齿轮
  return (
    <CardIco color="#f59e0b">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
    </CardIco>
  );
}

export function CardTrafficIcon() {
  // 流量统计：脉冲
  return (
    <CardIco color="#14b8a6">
      <path d="M3 12h4l2-6 4 12 2-6h6" />
    </CardIco>
  );
}

export function CardIpIcon() {
  // IP信息：地球
  return (
    <CardIco color="#6366f1">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z" />
    </CardIco>
  );
}

export function CardCoreIcon() {
  // 内核信息：芯片
  return (
    <CardIco color="#6b7280">
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </CardIco>
  );
}

export function CardSysIcon() {
  // 系统信息：显示器
  return (
    <CardIco color="#64748b">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16v4" />
    </CardIco>
  );
}

export function CardWebIcon() {
  // 网站测试：闪电
  return (
    <CardIco color="#ec4899">
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" />
    </CardIco>
  );
}

// 网站测试服务图标（简化版）
export function WebGoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
    </svg>
  );
}

export function WebGithubIcon() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true" fill="#24292f">
      <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.93c.58.11.79-.25.79-.56v-2c-3.2.7-3.87-1.54-3.87-1.54-.53-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12v3.15c0 .31.21.68.8.56A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z" />
    </svg>
  );
}

export function WebYoutubeIcon() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="4" fill="#FF0000" />
      <path d="M10 9.5v5l4.5-2.5L10 9.5z" fill="#fff" />
    </svg>
  );
}

export function WebXIcon() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true" fill="#000">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}
