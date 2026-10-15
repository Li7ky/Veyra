import { memo, useEffect, useState } from "react";
import {
  Copy,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Download,
  Power,
  Sun,
  Moon,
  Monitor,
  Square,
  Server,
  Palette,
  Info,
  Network,
  Shield,
  Globe2,
  Keyboard,
  Cloud,
} from "lucide-react";
import type { ThemeMode } from "./theme";
import type { AppSettings } from "./vite-env";
import { LOCALE_OPTIONS, setLocale, t } from "./i18n";

/** 与主进程 DEFAULT_SETTINGS 对齐 */
const DEFAULTS: AppSettings = {
  mixedPort: 17897,
  controllerPort: 19097,
  secret: "veyra-secret",
  allowLan: false,
  logLevel: "info",
  autoTest: true,
  autoPick: true,
  autoTestIntervalSec: 300,
  subAutoUpdateMin: 0,
  closeToTray: true,
  startWithWindows: false,
  startMinimized: false,
  proxyBypass: "localhost;127.*;10.*;192.168.*;<local>",
  theme: "system",
  core: "mihomo",
  proxyMode: "system",
  proxyGuard: false,
  disconnectOnProxyOff: true,
  bindAddress: "127.0.0.1",
  tunEnable: false,
  tunStack: "gvisor",
  tunAutoRoute: true,
  tunStrictRoute: false,
  tunAutoDetect: true,
  tunSniff: true,
  tunMtu: 9000,
  tunDevice: "Veyra",
  serviceMode: false,
  dnsOverride: false,
  dnsEnable: true,
  dnsListen: "0.0.0.0:1053",
  dnsIpv6: false,
  dnsMode: "fake-ip",
  dnsFakeIpRange: "198.18.0.1/16",
  dnsNameserver: ["https://doh.pub/dns-query", "tls://dns.alidns.com"],
  dnsFallback: ["tls://1.1.1.1", "tls://8.8.8.8"],
  hotkeyToggleProxy: "Alt+P",
  hotkeyToggleWindow: "Alt+`",
  hotkeyModeRule: "Alt+R",
  hotkeyModeGlobal: "Alt+G",
  hotkeyModeDirect: "Alt+D",
  lightweightMode: false,
  locale: "zh",
  themeColor: "",
  customCss: "",
  webdavUrl: "",
  webdavUser: "",
  webdavPass: "",
  webdavRemote: "veyra-backup.zip",
  logMaxLines: 2000,
  logAutoCleanDays: 0,
  mihomoChannel: "stable",
  webuiPrefer: "metacubexd",
  unifiedDelay: true,
  tcpConcurrent: true,
  subRetry: 3,
  subTimeoutSec: 30,
  subUpdateViaProxy: true,
  nodeSort: "delay",
  updateUrl: "",
};

type CoreInfo = {
  path: string;
  exists: boolean;
  size: number;
  fileVersion: string | null;
  build: string;
  buildAsset: string;
  cpu: string;
  cpuCount: number;
  arch: string;
  pid: number | null;
};

type AppInfo = {
  name: string;
  version: string;
  electron: string;
  platform: string;
  arch: string;
  isDev: boolean;
};

function formatBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(2)} MB`;
}

type Sec =
  | "core"
  | "network"
  | "tun"
  | "dns"
  | "system"
  | "hotkeys"
  | "appearance"
  | "backup"
  | "about";

const SECTIONS: { id: Sec; label: string; icon: typeof Server }[] = [
  { id: "core", label: "内核", icon: Server },
  { id: "network", label: "网络", icon: Network },
  { id: "tun", label: "TUN", icon: Shield },
  { id: "dns", label: "DNS", icon: Globe2 },
  { id: "system", label: "系统", icon: Monitor },
  { id: "hotkeys", label: "热键", icon: Keyboard },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "backup", label: "备份", icon: Cloud },
  { id: "about", label: "关于", icon: Info },
];

type Props = {
  running: boolean;
  mixedPort: number;
  controller: string;
  version: string;
  autoPick: boolean;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  onToast: (msg: string) => void;
  onBusy: (v: boolean) => void;
  onPorts: (mixed: number, controller: string) => void;
  onPrefs: (p: {
    autoTest?: boolean;
    autoPick?: boolean;
    autoTestIntervalSec?: number;
    subAutoUpdateMin?: number;
  }) => void;
  onRefresh: () => void;
  onCoreChange?: (c: string) => void;
};

function Row({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="s-row">
      <div className="s-row-text">
        <div className="s-row-label">{label}</div>
        {desc ? <div className="s-row-desc">{desc}</div> : null}
      </div>
      <div className="s-row-ctrl">{children}</div>
    </div>
  );
}

function Card({
  title,
  icon,
  extra,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="s-card">
      <div className="s-card-hd">
        <h2>
          {icon}
          {title}
        </h2>
        {extra}
      </div>
      <div className="s-card-bd">{children}</div>
    </section>
  );
}

function SettingsPanel(props: Props) {
  const {
    running,
    mixedPort,
    controller,
    version,
    autoPick,
    themeMode,
    onThemeChange,
    onToast,
    onBusy,
    onPorts,
    onPrefs,
    onRefresh,
    onCoreChange,
  } = props;

  const [sec, setSec] = useState<Sec>("core");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [core, setCore] = useState<CoreInfo | null>(null);
  const [cores, setCores] = useState<{
    active: string;
    mihomo: { installed: boolean; version: string };
    singbox: { installed: boolean; version: string };
  } | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [latestTag, setLatestTag] = useState("");
  const [svc, setSvc] = useState({ installed: false });
  const [draftPort, setDraftPort] = useState(String(DEFAULTS.mixedPort));
  const [draftCtrl, setDraftCtrl] = useState(String(DEFAULTS.controllerPort));
  const [draftSecret, setDraftSecret] = useState(DEFAULTS.secret);
  const [draftBypass, setDraftBypass] = useState(DEFAULTS.proxyBypass);
  const [draftSubMin, setDraftSubMin] = useState(String(DEFAULTS.subAutoUpdateMin));
  const [draftNs, setDraftNs] = useState("");
  const [draftHosts, setDraftHosts] = useState("");
  const [draftCss, setDraftCss] = useState("");
  const [draftColor, setDraftColor] = useState("");
  // WebDAV 密码与热键：本地草稿 + 失焦提交。
  // 不能 onChange 直接提交 —— 主进程会把密码转成 enc: 存储并回传，
  // 实时回写会让输入框内容被加密串覆盖；热键则会每敲一个字符就重新注册一次。
  const [draftWebdavPass, setDraftWebdavPass] = useState("");
  const [draftHotkeys, setDraftHotkeys] = useState<Record<string, string>>({});
  const [draftUpdateUrl, setDraftUpdateUrl] = useState("");
  const [updateStatus, setUpdateStatus] = useState("");
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  async function reload() {
    if (!window.veyra) return;
    const [s, c, a, cl] = await Promise.all([
      window.veyra.getSettings(),
      window.veyra.coreInfo(),
      window.veyra.appInfo(),
      window.veyra.coreList(),
    ]);
    const full = { ...DEFAULTS, ...s } as AppSettings;
    setSettings(full);
    setCore(c);
    setAppInfo(a);
    setCores(cl);
    setDraftPort(String(full.mixedPort));
    setDraftCtrl(String(full.controllerPort));
    setDraftSecret(full.secret || DEFAULTS.secret);
    setDraftBypass(full.proxyBypass || DEFAULTS.proxyBypass);
    setDraftSubMin(String(full.subAutoUpdateMin));
    setDraftNs((full.dnsNameserver || []).join(", "));
    setDraftHosts(
      full.dnsHosts && typeof full.dnsHosts === "object"
        ? Object.entries(full.dnsHosts)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")
        : ""
    );
    setDraftCss(full.customCss || "");
    setDraftColor(full.themeColor || "");
    setDraftWebdavPass("");
    setDraftHotkeys({});
    setDraftUpdateUrl(full.updateUrl || "");
    try {
      setSvc((await window.veyra.serviceStatus?.()) || { installed: false });
    } catch {
      setSvc({ installed: false });
    }
  }

  useEffect(() => {
    reload().catch(() => {});
  }, [running, mixedPort, version]);

  async function patchSettings(patch: Partial<AppSettings>) {
    if (!window.veyra) {
      // 预览版无 Electron 接口，本地直接应用视觉效果
      const next = { ...DEFAULTS, ...settings, ...patch } as AppSettings;
      setSettings(next);
      if (patch.customCss != null || patch.themeColor != null) applyCustomLook(next);
      return;
    }
    const next = await window.veyra.setSettings(patch);
    setSettings({ ...DEFAULTS, ...next } as AppSettings);
    if (
      "autoTest" in patch ||
      "autoPick" in patch ||
      "autoTestIntervalSec" in patch ||
      "subAutoUpdateMin" in patch
    ) {
      onPrefs({
        autoTest: next.autoTest,
        autoPick: next.autoPick,
        autoTestIntervalSec: next.autoTestIntervalSec,
        subAutoUpdateMin: next.subAutoUpdateMin,
      });
    }
    if (patch.customCss != null || patch.themeColor != null) applyCustomLook(next as AppSettings);
    return next;
  }

  function applyCustomLook(s: AppSettings) {
    let el = document.getElementById("veyra-custom-css") as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement("style");
      el.id = "veyra-custom-css";
      document.head.appendChild(el);
    }
    const color = s.themeColor ? `:root{--accent:${s.themeColor};--brand:${s.themeColor};--accent-2:${s.themeColor};--accent-3:${s.themeColor};--accent-grad:${s.themeColor};}` : "";
    el.textContent = color + "\n" + (s.customCss || "");
  }

  async function applyNetwork() {
    if (!window.veyra) return;
    onBusy(true);
    try {
      const r = await window.veyra.applyNetwork({
        mixedPort: Number(draftPort) || DEFAULTS.mixedPort,
        controllerPort: Number(draftCtrl) || DEFAULTS.controllerPort,
        secret: draftSecret.trim() || DEFAULTS.secret,
        allowLan: !!settings?.allowLan,
        logLevel: settings?.logLevel || DEFAULTS.logLevel,
        bindAddress: settings?.bindAddress || DEFAULTS.bindAddress,
      });
      setSettings(r.settings as AppSettings);
      onPorts(r.mixedPort, r.controller);
      onToast("网络设置已应用");
      onRefresh();
      await reload();
    } catch (e) {
      onToast(String((e as Error).message || e));
    } finally {
      onBusy(false);
    }
  }

  async function copy(text: string) {
    await window.veyra?.copyText(text);
    onToast("已复制");
  }

  async function setTheme(mode: ThemeMode) {
    await patchSettings({ theme: mode });
    onThemeChange(mode);
  }

  const activeCore = cores?.active || settings?.core || "mihomo";
  const activeCoreInstalled =
    activeCore === "singbox" ? !!cores?.singbox?.installed : !!cores?.mihomo?.installed;

  async function switchCore(next: string) {
    if (!window.veyra || next === activeCore) return;
    onBusy(true);
    try {
      await window.veyra.switchCore(next);
      setCores(await window.veyra.coreList());
      onCoreChange?.(next);
      onToast(next === "singbox" ? "已切换到 sing-box（实验）" : "已切换到 mihomo");
      onRefresh();
      await reload();
    } catch (e) {
      onToast(String((e as Error).message || e));
    } finally {
      onBusy(false);
    }
  }

  function coreVerText(c: { installed: boolean; version: string } | undefined, name: string) {
    if (!c || !c.installed) return `${name} 未安装`;
    return `${name} v${c.version || "?"}`;
  }

  const s = settings || DEFAULTS;

  return (
    <div className="s-page s-page-split">
      <aside className="s-nav">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button key={id} type="button" className={sec === id ? "active" : ""} onClick={() => setSec(id)}>
            <Icon size={14} /> {t(`sec.${id}`, label)}
          </button>
        ))}
      </aside>

      <div className="s-main">
        <div className="s-hint" style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 10, background: "var(--warn-bg)", border: "1px solid var(--warn-border)", fontSize: 13, color: "var(--warn)" }}>
          💡 温馨提示：不清楚的功能请保持默认，不要随意开启，以免影响正常使用
        </div>
        {sec === "core" && (
          <Card
            title="内核运行状态"
            icon={<Server size={15} />}
            extra={<span className={`pill ${running ? "on" : ""}`}>{running ? "运行中" : "已停止"}</span>}
          >
            <Row label="版本">
              <span className="s-mono">{version}</span>
            </Row>
            <Row label="内核引擎" desc="mihomo 稳定全功能 · sing-box 实验">
              <div className="seg">
                {(["mihomo", "singbox"] as const).map((c) => (
                  <button key={c} type="button" className={activeCore === c ? "active" : ""} onClick={() => switchCore(c)}>
                    {c === "mihomo" ? "mihomo" : "sing-box"}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="mihomo 通道" desc="稳定版 / 测试版发行通道（更新时使用）">
              <div className="seg">
                {([["stable", "稳定版"], ["alpha", "测试版"]] as const).map(([ch, label]) => (
                  <button
                    key={ch}
                    type="button"
                    className={s.mihomoChannel === ch ? "active" : ""}
                    onClick={() => patchSettings({ mihomoChannel: ch })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Row>
            <div className="s-foot">
              {coreVerText(cores?.mihomo, "mihomo")} · {coreVerText(cores?.singbox, "sing-box")}
            </div>
            {!activeCoreInstalled && (
              <div className="s-warn" style={{ marginTop: 8, padding: "10px 14px", borderRadius: 10, background: "var(--warn-bg, #fef3c7)", border: "1px solid var(--warn-border, #fcd34d)", fontSize: 13 }}>
                ⚠️ 当前内核未安装，无法启动代理服务。请点击下方"安装内核"按钮下载安装。
              </div>
            )}
            <div className="s-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={!running && !activeCoreInstalled}
                title={!running && !activeCoreInstalled ? "请先安装内核" : undefined}
                onClick={async () => {
                  onBusy(true);
                  try {
                    if (running) await window.veyra?.restartCore();
                    else await window.veyra?.startCore();
                    onToast(running ? "已重启" : "已启动");
                    onRefresh();
                    await reload();
                  } catch (e) {
                    onToast(String((e as Error).message || e));
                  } finally {
                    onBusy(false);
                  }
                }}
              >
                {running ? <RotateCcw size={13} /> : <Power size={13} />}
                {running ? "重启" : "启动"}
              </button>
              <button
                type="button"
                className="btn danger btn-sm"
                disabled={!running}
                onClick={async () => {
                  await window.veyra?.stopCore();
                  onToast("已停止");
                  onRefresh();
                }}
              >
                <Square size={12} /> 停止
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  onBusy(true);
                  try {
                    const r = await window.veyra!.checkCoreUpdate();
                    setLatestTag(r.latest);
                    onToast(`最新 ${r.latest}`);
                  } catch (e) {
                    onToast(String((e as Error).message || e));
                  } finally {
                    onBusy(false);
                  }
                }}
              >
                检查内核更新
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  onBusy(true);
                  try {
                    const wasInstalled = activeCoreInstalled;
                    await window.veyra!.updateCore();
                    onRefresh();
                    await reload();
                    if (!wasInstalled) {
                      // 首次安装后自动启动
                      try {
                        await window.veyra?.startCore();
                        onToast("内核已安装并启动");
                      } catch {
                        onToast("内核已安装，请手动启动");
                      }
                      onRefresh();
                    } else {
                      onToast("内核已更新");
                    }
                  } catch (e) {
                    onToast(String((e as Error).message || e));
                  } finally {
                    onBusy(false);
                  }
                }}
              >
                <Download size={13} /> {activeCoreInstalled ? "更新" : "安装内核"}
              </button>
            </div>
            {latestTag ? <div className="s-foot">GitHub：{latestTag}</div> : null}
            <div className="s-path" title={core?.path}>
              {core?.path || "—"}
            </div>
          </Card>
        )}

        {sec === "network" && (
          <Card title="网络与系统代理" icon={<Network size={15} />}>
            <div className="s-fields">
              <label>
                混合端口
                <input className="s-input" value={draftPort} onChange={(e) => setDraftPort(e.target.value)} />
              </label>
              <label>
                控制端口
                <input className="s-input" value={draftCtrl} onChange={(e) => setDraftCtrl(e.target.value)} />
              </label>
              <label>
                Secret
                <input className="s-input" value={draftSecret} onChange={(e) => setDraftSecret(e.target.value)} />
              </label>
              <label>
                绑定地址（WSL/局域网）
                <select
                  className="s-input"
                  value={s.bindAddress || "127.0.0.1"}
                  onChange={(e) => patchSettings({ bindAddress: e.target.value })}
                >
                  <option value="127.0.0.1">127.0.0.1</option>
                  <option value="0.0.0.0">0.0.0.0</option>
                </select>
              </label>
              <label>
                日志级别
                <select
                  className="s-input"
                  value={s.logLevel || "info"}
                  onChange={(e) => patchSettings({ logLevel: e.target.value })}
                >
                  {["silent", "error", "warning", "info", "debug"].map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <Row label="允许局域网" desc="allow-lan">
              <input type="checkbox" checked={!!s.allowLan} onChange={(e) => patchSettings({ allowLan: e.target.checked })} />
            </Row>
            <Row label="代理模式" desc="系统代理 / PAC / 关闭">
              <div className="seg">
                {(
                  [
                    ["system", "系统代理"],
                    ["pac", "PAC"],
                    ["off", "关闭"],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    className={s.proxyMode === m ? "active" : ""}
                    onClick={async () => {
                      await patchSettings({ proxyMode: m });
                      await window.veyra?.setProxyMode?.(m);
                      onRefresh();
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="系统代理守护" desc="被其他软件改掉后自动恢复">
              <input
                type="checkbox"
                checked={!!s.proxyGuard}
                onChange={(e) => patchSettings({ proxyGuard: e.target.checked })}
              />
            </Row>
            <Row label="关闭代理时断连" desc="关掉系统代理时自动断开全部连接">
              <input
                type="checkbox"
                checked={s.disconnectOnProxyOff !== false}
                onChange={(e) => patchSettings({ disconnectOnProxyOff: e.target.checked })}
              />
            </Row>
            <Row label="代理绕过">
              <button
                type="button"
                className="btn ghost btn-sm"
                onClick={async () => {
                  await patchSettings({ proxyBypass: draftBypass || DEFAULTS.proxyBypass });
                  onToast("已保存");
                }}
              >
                保存
              </button>
            </Row>
            <input className="s-input full" value={draftBypass} onChange={(e) => setDraftBypass(e.target.value)} />
            <Row label="UWP 回环" desc="启用 Windows UWP 应用本地回环">
              <button
                type="button"
                className="btn ghost btn-sm"
                onClick={async () => {
                  onBusy(true);
                  try {
                    await window.veyra?.enableUwpLoopback?.();
                    onToast("已请求启用 UWP 回环");
                  } catch (e) {
                    onToast(String((e as Error).message || e));
                  } finally {
                    onBusy(false);
                  }
                }}
              >
                一键启用
              </button>
            </Row>
            <Row label="复制代理环境变量">
              <button
                type="button"
                className="btn ghost btn-sm"
                onClick={async () => {
                  const r = await window.veyra?.proxyEnvText?.();
                  if (r?.text) {
                    await copy(r.text);
                  }
                }}
              >
                <Copy size={13} /> 复制
              </button>
            </Row>
            <div className="s-actions">
              <button type="button" className="btn primary btn-sm" onClick={applyNetwork}>
                应用网络
              </button>
              <button type="button" className="btn ghost btn-sm" onClick={() => copy(`127.0.0.1:${mixedPort}`)}>
                复制 {mixedPort}
              </button>
              <button type="button" className="btn ghost btn-sm" onClick={() => copy(controller)}>
                复制控制地址
              </button>
            </div>
          </Card>
        )}

        {sec === "tun" && (
          <Card title="TUN 虚拟网卡" icon={<Shield size={15} />}>
            <Row label="启用 TUN" desc="全局接管流量（需管理员/服务模式）">
              <input
                type="checkbox"
                checked={!!s.tunEnable}
                onChange={(e) => patchSettings({ tunEnable: e.target.checked })}
              />
            </Row>
            <Row label="Stack">
              <select
                className="s-input"
                value={s.tunStack || "gvisor"}
                onChange={(e) => patchSettings({ tunStack: e.target.value })}
              >
                {["gvisor", "system", "mixed"].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="自动路由">
              <input
                type="checkbox"
                checked={s.tunAutoRoute !== false}
                onChange={(e) => patchSettings({ tunAutoRoute: e.target.checked })}
              />
            </Row>
            <Row label="严格路由">
              <input
                type="checkbox"
                checked={!!s.tunStrictRoute}
                onChange={(e) => patchSettings({ tunStrictRoute: e.target.checked })}
              />
            </Row>
            <Row label="自动检测接口">
              <input
                type="checkbox"
                checked={s.tunAutoDetect !== false}
                onChange={(e) => patchSettings({ tunAutoDetect: e.target.checked })}
              />
            </Row>
            <Row label="Sniff 嗅探">
              <input
                type="checkbox"
                checked={s.tunSniff !== false}
                onChange={(e) => patchSettings({ tunSniff: e.target.checked })}
              />
            </Row>
            <Row label="服务模式" desc={`计划任务提权运行内核 · ${svc.installed ? "已安装" : "未安装"}`}>
              <div className="s-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={async () => {
                    onBusy(true);
                    try {
                      await window.veyra?.serviceInstall?.();
                      onToast("服务模式已安装");
                      await reload();
                    } catch (e) {
                      onToast(String((e as Error).message || e));
                    } finally {
                      onBusy(false);
                    }
                  }}
                >
                  安装
                </button>
                <button
                  type="button"
                  className="btn danger btn-sm"
                  onClick={async () => {
                    await window.veyra?.serviceUninstall?.();
                    onToast("已卸载服务模式");
                    await reload();
                  }}
                >
                  卸载
                </button>
              </div>
            </Row>
          </Card>
        )}

        {sec === "dns" && (
          <Card title="DNS" icon={<Globe2 size={15} />}>
            <Row label="覆盖订阅 DNS" desc="开启后用下方配置强制覆盖">
              <input
                type="checkbox"
                checked={!!s.dnsOverride}
                onChange={(e) => patchSettings({ dnsOverride: e.target.checked })}
              />
            </Row>
            <Row label="增强模式">
              <select
                className="s-input"
                value={s.dnsMode || "fake-ip"}
                onChange={(e) => patchSettings({ dnsMode: e.target.value })}
              >
                <option value="fake-ip">fake-ip</option>
                <option value="redir-host">redir-host</option>
              </select>
            </Row>
            <Row label="IPv6">
              <input type="checkbox" checked={!!s.dnsIpv6} onChange={(e) => patchSettings({ dnsIpv6: e.target.checked })} />
            </Row>
            <label className="s-field-block">
              Nameserver（逗号分隔）
              <input className="s-input full" value={draftNs} onChange={(e) => setDraftNs(e.target.value)} />
            </label>
            <div className="s-actions">
              <button
                type="button"
                className="btn primary btn-sm"
                onClick={async () => {
                  const list = draftNs
                    .split(/[,;\n]/)
                    .map((x) => x.trim())
                    .filter(Boolean);
                  await patchSettings({ dnsNameserver: list, dnsOverride: true });
                  onToast("DNS 已保存");
                }}
              >
                保存 Nameserver
              </button>
              <button
                type="button"
                className="btn ghost btn-sm"
                onClick={async () => {
                  const first = draftNs.split(/[,;\n]/)[0]?.trim();
                  const r = await window.veyra?.validateDns?.(first || "");
                  onToast(r?.ok ? `校验通过：${r.host}` : `校验失败：${r?.error || "?"}`);
                }}
              >
                校验
              </button>
            </div>
            <label className="s-field-block">
              Hosts（每行 host=ip）
              <textarea className="s-input full" rows={4} value={draftHosts} onChange={(e) => setDraftHosts(e.target.value)} />
            </label>
            <button
              type="button"
              className="btn ghost btn-sm"
              onClick={async () => {
                const hosts: Record<string, string> = {};
                for (const line of draftHosts.split("\n")) {
                  const m = line.trim().match(/^([^=\s]+)\s*=\s*(.+)$/);
                  if (m) hosts[m[1]] = m[2].trim();
                }
                await patchSettings({ dnsHosts: hosts, dnsOverride: true });
                onToast("Hosts 已保存");
              }}
            >
              保存 Hosts
            </button>
          </Card>
        )}

        {sec === "system" && (
          <>
          <Card title="系统" icon={<Monitor size={15} />}>
            <Row label="开机自启">
              <input
                type="checkbox"
                checked={!!s.startWithWindows}
                onChange={(e) => patchSettings({ startWithWindows: e.target.checked })}
              />
            </Row>
            <Row label="启动最小化">
              <input
                type="checkbox"
                checked={!!s.startMinimized}
                onChange={(e) => patchSettings({ startMinimized: e.target.checked })}
              />
            </Row>
            <Row label="关闭到托盘">
              <input
                type="checkbox"
                checked={s.closeToTray !== false}
                onChange={(e) => patchSettings({ closeToTray: e.target.checked })}
              />
            </Row>
            <Row label="轻量模式" desc="缩小窗口、降低资源占用">
              <input
                type="checkbox"
                checked={!!s.lightweightMode}
                onChange={(e) => patchSettings({ lightweightMode: e.target.checked })}
              />
            </Row>
            <Row label={t("sec.system") === "系统" ? "界面语言" : "Language"}>
              <select
                className="s-input"
                value={s.locale || "zh"}
                onChange={(e) => {
                  const v = e.target.value;
                  setLocale(v);
                  patchSettings({ locale: v });
                }}
              >
                {LOCALE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="统一延迟" desc="写入运行时配置">
              <input
                type="checkbox"
                checked={s.unifiedDelay !== false}
                onChange={(e) => patchSettings({ unifiedDelay: e.target.checked })}
              />
            </Row>
            <Row label="TCP 并发" desc="TCP 并发连接">
              <input
                type="checkbox"
                checked={s.tcpConcurrent !== false}
                onChange={(e) => patchSettings({ tcpConcurrent: e.target.checked })}
              />
            </Row>
            <Row label="订阅重试次数">
              <input
                className="s-input"
                style={{ width: 80 }}
                value={String(s.subRetry ?? 3)}
                onChange={(e) => patchSettings({ subRetry: Math.max(1, Number(e.target.value) || 3) })}
              />
            </Row>
            <Row label="订阅超时（秒）">
              <input
                className="s-input"
                style={{ width: 80 }}
                value={String(s.subTimeoutSec ?? 30)}
                onChange={(e) => patchSettings({ subTimeoutSec: Math.max(5, Number(e.target.value) || 30) })}
              />
            </Row>
            <Row label="经代理更新订阅">
              <input
                type="checkbox"
                checked={s.subUpdateViaProxy !== false}
                onChange={(e) => patchSettings({ subUpdateViaProxy: e.target.checked })}
              />
            </Row>
            <Row label="VC++ 运行库">
              <button
                type="button"
                className="btn ghost btn-sm"
                onClick={async () => {
                  const r = await window.veyra?.vcRuntime?.();
                  if (r?.installed) onToast("已检测到 VC Runtime");
                  else {
                    onToast("未检测到，正在打开下载页");
                    await window.veyra?.downloadVc?.();
                  }
                }}
              >
                检测 / 下载
              </button>
            </Row>
            <Row label="便携模式" desc="exe 旁放置 portable.txt 即可把数据写到 ./data">
              <span className="s-muted">{s.portableMode ? "已启用" : "未启用（放置 portable.txt）"}</span>
            </Row>
            <Row label="自动测速" desc="后台静默保持最优节点，不弹提示；每 20 秒只快检当前节点">
              {/* 该功能已下线（App.tsx 不再消费 autoTest），开关保留会变成一个
                  写进去却没有任何效果的假设置，因此连同下方「全量测速间隔」一并移除。 */}
              <span className="s-muted">已下线，测速为手动触发</span>
            </Row>
            <Row label="选用最低延迟" desc="自动切到延迟最低的节点；新节点需快 25% 以上才切换，避免来回跳">
              <input type="checkbox" checked={autoPick} onChange={(e) => patchSettings({ autoPick: e.target.checked })} />
            </Row>
            <div className="s-fields">
              <label>
                订阅更新（分钟，0=关）
                <input
                  className="s-input"
                  value={draftSubMin}
                  onChange={(e) => setDraftSubMin(e.target.value)}
                  onBlur={async () => {
                    const n = Math.max(0, Number(draftSubMin) || 0);
                    setDraftSubMin(String(n));
                    await patchSettings({ subAutoUpdateMin: n });
                  }}
                />
              </label>
              <label>
                日志保留天数（0=不自动清文件）
                <input
                  className="s-input"
                  value={String(s.logAutoCleanDays || 0)}
                  onChange={(e) => patchSettings({ logAutoCleanDays: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
            </div>
          </Card>
          </>
        )}

        {sec === "hotkeys" && (
          <Card title="全局热键" icon={<Keyboard size={15} />}>
            {(
              [
                ["hotkeyToggleProxy", "切换系统代理"],
                ["hotkeyToggleWindow", "显示/隐藏窗口"],
                ["hotkeyModeRule", "规则模式"],
                ["hotkeyModeGlobal", "全局模式"],
                ["hotkeyModeDirect", "直连模式"],
              ] as const
            ).map(([key, label]) => (
              <Row key={key} label={label}>
                <input
                  className="s-input"
                  style={{ width: 140 }}
                  value={String(draftHotkeys[key] ?? s[key] ?? "")}
                  onChange={(e) => setDraftHotkeys((prev) => ({ ...prev, [key]: e.target.value }))}
                  onBlur={async (e) => {
                    const v = e.target.value.trim();
                    if (v === String(s[key] || "")) return;
                    await patchSettings({ [key]: v } as Partial<AppSettings>);
                  }}
                  placeholder="Alt+P"
                />
              </Row>
            ))}
            <div className="s-foot">失焦后立即注册；留空则禁用该项</div>
          </Card>
        )}

        {sec === "appearance" && (
          <Card title="外观" icon={<Palette size={15} />}>
            <Row label="主题模式">
              <div className="theme-seg">
                {(
                  [
                    ["light", Sun],
                    ["dark", Moon],
                    ["system", Monitor],
                  ] as const
                ).map(([mode, Icon]) => (
                  <button key={mode} type="button" className={themeMode === mode ? "active" : ""} onClick={() => setTheme(mode)}>
                    <Icon size={14} />
                  </button>
                ))}
              </div>
            </Row>
            <Row label="主题色">
              <div className="s-actions" style={{ gap: 8 }}>
                {[
                  ["#2c71e8", "品牌蓝"],
                  ["#0ea5e9", "天蓝"],
                  ["#14b8a6", "青瓷"],
                  ["#7c3aed", "葡萄紫"],
                  ["#ec4899", "樱花粉"],
                  ["#f59e0b", "琥珀"],
                ].map(([c, name]) => (
                  <button
                    key={c}
                    type="button"
                    title={name}
                    onClick={() => {
                      setDraftColor(c);
                      patchSettings({ themeColor: c });
                    }}
                    style={{
                      width: 28, height: 28, borderRadius: "50%", background: c, cursor: "pointer",
                      border: draftColor === c ? "2px solid var(--text)" : "2px solid transparent",
                      outline: "1px solid var(--line)",
                    }}
                  />
                ))}
                <input
                  type="color"
                  title="自定义颜色"
                  style={{ width: 32, height: 28, padding: 2, border: "1px dashed var(--line)", borderRadius: 8, cursor: "pointer", background: "transparent" }}
                  value={/^#[0-9a-fA-F]{6}$/.test(draftColor) ? draftColor : "#2c71e8"}
                  onChange={(e) => {
                    setDraftColor(e.target.value);
                    patchSettings({ themeColor: e.target.value });
                  }}
                />
              </div>
            </Row>
            <label className="s-field-block">
              自定义 CSS 注入
              <textarea className="s-input full" rows={6} value={draftCss} onChange={(e) => setDraftCss(e.target.value)} />
            </label>
            <button type="button" className="btn primary btn-sm" onClick={() => patchSettings({ customCss: draftCss })}>
              保存 CSS
            </button>
          </Card>
        )}

        {sec === "backup" && (
          <Card title="备份与同步" icon={<Cloud size={15} />}>
            <Row label="本地 ZIP 备份">
              <div className="s-actions">
                <button
                  type="button"
                  className="btn primary btn-sm"
                  onClick={async () => {
                    onBusy(true);
                    try {
                      const r = await window.veyra?.backupExport?.();
                      onToast(`已导出 ${r?.path || ""}`);
                    } catch (e) {
                      onToast(String((e as Error).message || e));
                    } finally {
                      onBusy(false);
                    }
                  }}
                >
                  导出
                </button>
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  onClick={async () => {
                    onBusy(true);
                    try {
                      const r = await window.veyra?.backupImport?.();
                      if (!r?.canceled) {
                        onToast("导入完成，请重启或刷新");
                        onRefresh();
                        await reload();
                      }
                    } catch (e) {
                      onToast(String((e as Error).message || e));
                    } finally {
                      onBusy(false);
                    }
                  }}
                >
                  导入
                </button>
                <button type="button" className="btn ghost btn-sm" onClick={() => window.veyra?.backupReveal?.()}>
                  <FolderOpen size={13} /> 打开备份目录
                </button>
              </div>
            </Row>
            <div className="s-fields">
              <label>
                WebDAV URL
                <input
                  className="s-input"
                  value={s.webdavUrl || ""}
                  onChange={(e) => patchSettings({ webdavUrl: e.target.value })}
                />
              </label>
              <label>
                用户名
                <input
                  className="s-input"
                  value={s.webdavUser || ""}
                  onChange={(e) => patchSettings({ webdavUser: e.target.value })}
                />
              </label>
              <label>
                密码
                <input
                  className="s-input"
                  type="password"
                  value={draftWebdavPass}
                  placeholder={s.webdavPass ? "已保存（输入新密码可覆盖）" : "密码"}
                  onChange={(e) => setDraftWebdavPass(e.target.value)}
                  onBlur={async () => {
                    if (!draftWebdavPass) return;
                    await patchSettings({ webdavPass: draftWebdavPass });
                    setDraftWebdavPass("");
                    onToast("WebDAV 密码已保存");
                  }}
                />
              </label>
              <label>
                远程文件名
                <input
                  className="s-input"
                  value={s.webdavRemote || "veyra-backup.zip"}
                  onChange={(e) => patchSettings({ webdavRemote: e.target.value })}
                />
              </label>
            </div>
            <div className="s-actions">
              <button
                type="button"
                className="btn primary btn-sm"
                onClick={async () => {
                  onBusy(true);
                  try {
                    await window.veyra?.webdavUpload?.();
                    onToast("WebDAV 上传成功");
                  } catch (e) {
                    onToast(String((e as Error).message || e));
                  } finally {
                    onBusy(false);
                  }
                }}
              >
                上传到 WebDAV
              </button>
              <button
                type="button"
                className="btn ghost btn-sm"
                onClick={async () => {
                  onBusy(true);
                  try {
                    await window.veyra?.webdavDownload?.();
                    onToast("WebDAV 恢复完成");
                    onRefresh();
                    await reload();
                  } catch (e) {
                    onToast(String((e as Error).message || e));
                  } finally {
                    onBusy(false);
                  }
                }}
              >
                从 WebDAV 恢复
              </button>
            </div>
          </Card>
        )}

        {sec === "about" && (
          <>
          <Card title="软件更新" icon={<RefreshCw size={15} />}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>当前版本</span>
              <span className="pill">v{appInfo?.version || "1.1.0"}</span>
              {updateStatus && (
                <span style={{ fontSize: 13 }} className="s-muted">{updateStatus}</span>
              )}
            </div>
            <label className="s-field-block">
              更新源 URL（GitHub Releases latest 接口，留空则关闭检查）
              <input
                className="s-input full"
                value={draftUpdateUrl}
                placeholder="https://api.github.com/repos/<owner>/<repo>/releases/latest"
                onChange={(e) => setDraftUpdateUrl(e.target.value)}
                onBlur={async () => {
                  const v = draftUpdateUrl.trim();
                  if (v !== String(s.updateUrl || "")) await patchSettings({ updateUrl: v });
                }}
              />
            </label>
            <div className="s-actions">
              <button
                type="button"
                className="btn primary btn-sm"
                disabled={checkingUpdate}
                onClick={async () => {
                  // 之前这里硬编码了一个不存在的仓库地址，点「检查更新」必然 404；
                  // 改为读取用户配置的更新源，未配置时给出明确提示。
                  const url = String(s.updateUrl || "").trim();
                  if (!/^https?:\/\//i.test(url)) {
                    setUpdateStatus("");
                    onToast("请先填写有效的更新源 URL");
                    return;
                  }
                  setCheckingUpdate(true);
                  setUpdateStatus("正在检查…");
                  try {
                    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const data = await res.json();
                    const latest = String(data.tag_name || data.version || "").replace(/^v/, "");
                    const current = String(appInfo?.version || "1.1.0");
                    if (latest && latest !== current) {
                      setUpdateStatus(`发现新版本 v${latest}`);
                      onToast(`发现新版本 v${latest}`);
                    } else {
                      setUpdateStatus("已是最新版本");
                    }
                  } catch (e) {
                    setUpdateStatus(`检查失败：${(e as Error).message || e}`);
                  }
                  setCheckingUpdate(false);
                }}
              >
                <RefreshCw size={13} /> {checkingUpdate ? "检查中…" : "检查更新"}
              </button>
            </div>
          </Card>
          <Card title="关于" icon={<Info size={15} />}>
            <Row label="配置目录">
              <button type="button" className="btn ghost btn-sm" onClick={() => window.veyra?.openPath("config")}>
                <FolderOpen size={13} /> 打开
              </button>
            </Row>
            <Row label="用户数据">
              <button type="button" className="btn ghost btn-sm" onClick={() => window.veyra?.openPath("userdata")}>
                打开
              </button>
            </Row>
            <div className="s-meta">
              <div>
                <span>应用</span>
                <b>
                  {appInfo?.name || "Veyra"} {appInfo?.version}
                </b>
              </div>
              <div>
                <span>Electron</span>
                <b>{appInfo?.electron}</b>
              </div>
              <div>
                <span>平台</span>
                <b>
                  {appInfo?.platform}/{appInfo?.arch}
                </b>
              </div>
            </div>
            <button
              type="button"
              className="btn danger btn-sm"
              style={{ display: "inline-block", height: "36px", lineHeight: "36px", padding: "0 14px", marginTop: "14px", fontFamily: "'PingFang SC','Microsoft YaHei','Noto Sans SC',sans-serif" }}
              onClick={async () => {
                const { core: _omit, ...rest } = DEFAULTS;
                await window.veyra?.setSettings(rest);
                onToast("已恢复默认");
                await reload();
                onRefresh();
              }}
            >
              <RotateCcw size={13} style={{ verticalAlign: "middle", marginRight: 6 }} />
              <span style={{ verticalAlign: "middle" }}>恢复默认设置</span>
            </button>
          </Card>
          </>
        )}
      </div>
    </div>
  );
}

export default memo(SettingsPanel);
