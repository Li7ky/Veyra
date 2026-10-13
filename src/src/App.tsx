import { startTransition, useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  Building2,
  Cable,
  CalendarClock,
  Check,
  Clock,
  Cpu,
  Database,
  Globe,
  HardDrive,
  Layers3,
  Link2,
  ListTree,
  MapPin,
  Minus,
  Monitor,
  Network,
  PieChart,
  PanelRight,
  Plus,
  Power,
  Route,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  X,
  Zap,
  RefreshCw,
  Settings,
  type LucideIcon,
} from "lucide-react";
import {
  NavHomeIcon,
  NavProxiesIcon,
  NavProfilesIcon,
  NavConnectionsIcon,
  NavRulesIcon,
  NavLogsIcon,
  NavTestsIcon,
  NavSettingsIcon,
} from "./NavIcons";
import { CardSubIcon, CardNodeIcon, CardNetIcon, CardModeIcon, CardTrafficIcon, CardIpIcon, CardCoreIcon, CardSysIcon, CardWebIcon, WebGoogleIcon, WebGithubIcon, WebYoutubeIcon, WebXIcon } from "./NavIcons";
import type { ConnectionItem, ProfileRich, ProxyNode } from "./vite-env";
import SettingsPanel from "./SettingsPanel";
import ConnectionsPage from "./ConnectionsPage";
import RulesPage from "./RulesPage";
import TestsPage from "./TestsPage";
// Monaco 体积占主包的绝大部分（约 4.4MB）；改为懒加载，首屏 JS 解析时间大幅下降，
// 只有用户首次切到「YAML」子标签时才加载编辑器 chunk。
const YamlEditor = lazy(() => import("./YamlEditor"));
import { ProxiesVisualEditor, GroupsVisualEditor } from "./VisualEditors";
import { applyTheme, type ThemeMode } from "./theme";
import { setLocale, t } from "./i18n";

type Tab = "home" | "proxies" | "profiles" | "connections" | "rules" | "logs" | "tests" | "settings";
type EnhanceKind = "merge" | "script" | "rules" | "proxies" | "groups";

const GROUP_TYPES = new Set([
  "Selector",
  "URLTest",
  "Fallback",
  "LoadBalance",
  "Relay",
  "selector",
  "url-test",
  "fallback",
  "load-balance",
  "relay",
]);

// 代理页节点渲染分批：首批保证页面立即出现，其余每帧补一批
const PX_NODE_FIRST = 30;
const PX_NODE_BATCH = 60;

function formatBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatRate(bps: number) {
  if (bps < 1024) return `${Math.max(0, Math.round(bps))} B/s`;
  if (bps < 1024 ** 2) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 ** 2).toFixed(2)} MB/s`;
}

function formatUptime(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function delayClass(d?: number) {
  if (d == null) return "na";
  if (d <= 0) return "bad";
  if (d < 200) return "good";
  if (d < 500) return "mid";
  return "bad";
}

function delayText(d?: number) {
  if (d == null) return "—";
  if (d <= 0) return "超时";
  return `${d}`;
}

function isTestableNode(name: string) {
  return !["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"].includes(name) && !isInfoNode(name);
}

// 机场信息节点：伪装成节点名展示流量/到期时间（如"剩余流量：79.29 GB"、"套餐到期：2026-10-28"）。
// 它们不是真正的代理节点——混在代理页列表里会让人困惑，也不应参与测速与自动选优。
const INFO_NODE_RE = /剩余流量|已用流量|套餐到期|到期时间|距离.*重置|有效期|重置剩余|流量.*(GB|TB|MB)/i;
function isInfoNode(name: string) {
  return INFO_NODE_RE.test(String(name || ""));
}

// 系统出站（DIRECT/REJECT 等）：可以选中，但需要在卡片上标记，避免被当成普通节点
const SYSTEM_OUTBOUNDS = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);
function isSystemOutbound(name: string) {
  return SYSTEM_OUTBOUNDS.has(name);
}

function sortNodesByDelay(names: string[], delays: Record<string, number>) {
  return [...names].sort((a, b) => {
    const da = delays[a];
    const db = delays[b];
    const sa = da == null ? 2 : da <= 0 ? 1 : 0;
    const sb = db == null ? 2 : db <= 0 ? 1 : 0;
    if (sa !== sb) return sa - sb;
    if (sa === 0) return da - db;
    return a.localeCompare(b, "zh");
  });
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

const MODE_LABEL: Record<string, string> = {
  rule: "规则",
  global: "全局",
  direct: "直连",
};

// 首页卡片信息行：图标点缀 + 标签/值居中 + 明显描边框
function InfoRow({
  icon: Icon,
  label,
  mono,
  children,
}: {
  icon: LucideIcon;
  label: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="info-row">
      <span className="info-row-ico"><Icon size={15} /></span>
      <div className="info-row-main">
        <em>{label}</em>
        <b className={mono ? "mono" : ""}>{children}</b>
      </div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
  // 右栏（时钟/快捷操作/流量）默认只在首页展开；其余页面主区吃满宽度，
  // 避免连接页表格(min-width 820)与节点页分组标签被裁切。手动切换只在当前页生效。
  const [railOverride, setRailOverride] = useState<boolean | null>(null);
  const showRail = railOverride === null ? tab === "home" : railOverride;
  // 切页时回到「按页自动」策略
  useEffect(() => { setRailOverride(null); }, [tab]);
  const [pfTab, setPfTab] = useState<"sub"|"enhance"|"nodes"|"yaml">("sub");
  // 订阅页子标签首次访问后才挂载，之后保活：避免每次打开订阅页都重建 Monaco 与可视化编辑器
  const [pfSeen, setPfSeen] = useState<Record<string, boolean>>({ sub: true });
  const [running, setRunning] = useState(false);
  const [coreVersion, setCoreVersion] = useState("");
  const [coreType, setCoreType] = useState("mihomo");
  const [coreStartTime, setCoreStartTime] = useState<number | null>(null);
  const appStartTime = useRef(Date.now());
  const [ruleCount, setRuleCount] = useState<number | null>(null);
  const [sysProxy, setSysProxy] = useState(false);
  const [mode, setMode] = useState("rule");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [mixedPort, setMixedPort] = useState(17897);
  const [controller, setController] = useState("127.0.0.1:19097");
  const [version, setVersion] = useState("-");
  const [upload, setUpload] = useState(0);
  const [download, setDownload] = useState(0);
  const [coreMemMB, setCoreMemMB] = useState<number | null>(null);
  const [upRate, setUpRate] = useState(0);
  const [downRate, setDownRate] = useState(0);
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [connCount, setConnCount] = useState(0);
  const [groups, setGroups] = useState<ProxyNode[]>([]);
  const [proxyMap, setProxyMap] = useState<Record<string, ProxyNode>>({});
  const [selectedGroup, setSelectedGroup] = useState("PROXY");
  const [delays, setDelays] = useState<Record<string, number>>({});
  const [delayHistory, setDelayHistory] = useState<Record<string, { t: number; ms: number }[]>>(() => {
    try {
      return JSON.parse(localStorage.getItem("veyra-delay-history") || "{}");
    } catch {
      return {};
    }
  });
  const [query, setQuery] = useState("");
  const [profileText, setProfileText] = useState("");
  const [profileName, setProfileName] = useState("subscription.yaml");
  const [subUrl, setSubUrl] = useState("");
  const [profiles, setProfiles] = useState<
    { name: string; size: number; uid?: string; type?: string; enabled?: boolean; global?: boolean; url?: string }[]
  >([]);
  const [richProfiles, setRichProfiles] = useState<ProfileRich[]>([]);
  const [subs, setSubs] = useState<{ url: string; name: string; updatedAt: number; nextUpdateAt?: number; userinfo?: { upload: number; download: number; total: number; expire: number } }[]>([]);
  const [nodeSortMode, setNodeSortMode] = useState<"delay" | "name" | "default">("delay");
  // 首屏只渲染前 30 个节点，挂载完成后再补全：消除首页→代理切换的卡顿
  const [pxNodeLimit, setPxNodeLimit] = useState(PX_NODE_FIRST);
  const [enhanceLog, setEnhanceLog] = useState<string[]>([]);
  const [editUid, setEditUid] = useState<string | null>(null);
  const [exitIp, setExitIp] = useState<{
    ip: string | null;
    country?: string;
    countryCode?: string;
    city?: string;
    region?: string;
    isp?: string;
    org?: string;
    as?: string;
    timezone?: string;
    lat?: number;
    lon?: number;
  } | null>(
    null
  );
  const [nodeUri, setNodeUri] = useState("");
  const [providers, setProviders] = useState<{ proxies: string[]; rules: string[] }>({ proxies: [], rules: [] });
  const [editorMode, setEditorMode] = useState<"profile" | "runtime">("profile");
  const [bindTarget, setBindTarget] = useState<string | null>(null);
  // 首页6卡片可见性
  const [homeCards, setHomeCards] = useState({
    subscription: true,
    node: true,
    network: true,
    mode: true,
    traffic: true,
    ip: true,
    core: true,
    system: true,
    webtest: true,
  });
  const [testing, setTesting] = useState(false);
  const [testProgress, setTestProgress] = useState(0);
  const [autoTest, setAutoTest] = useState(true);
  const [autoPick, setAutoPick] = useState(true);
  const [autoTestMs, setAutoTestMs] = useState(300_000);
  const [subAutoUpdateMin, setSubAutoUpdateMin] = useState(0);
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");
  const [activeCore, setActiveCore] = useState("mihomo");
  const [lastTestAt, setLastTestAt] = useState(0);
  const [testingNode, setTestingNode] = useState<string | null>(null);
  const [rateHistory, setRateHistory] = useState<{ up: number[]; down: number[] }>({
    up: [],
    down: [],
  });
  const [banner, setBanner] = useState("");
  const [homeCfgOpen, setHomeCfgOpen] = useState(false);
  const [homeCfgDraft, setHomeCfgDraft] = useState(homeCards);
  // 首页系统信息卡的真实数据（此前版本硬编码「未启用 / v1.1 / Windows 10/11」）
  const [appVersion, setAppVersion] = useState("");
  const [platformLabel, setPlatformLabel] = useState("Windows");
  const [startWithWindows, setStartWithWindows] = useState(false);
  const [mihomoChannel, setMihomoChannel] = useState("stable");

  const toastTimer = useRef<number | null>(null);
  const lastSeqRef = useRef(0);
  const trafficRef = useRef<{ up: number; down: number; t: number } | null>(null);
  // 速率显示平滑：轮询间隔抖动会让差值速率忽大忽小，用 EMA 压平
  const upRateRef = useRef(0);
  const downRateRef = useRef(0);
  const selectedGroupRef = useRef(selectedGroup);
  const testingRef = useRef(false);
  const delaysRef = useRef(delays);
  const autoPickRef = useRef(autoPick);
  const groupsRef = useRef(groups);
  // 启动自动测速只跑一次：内核启动后等节点数据真正就绪再测，停止内核时重置
  const bootTestedRef = useRef(false);
  const tabRef = useRef<Tab>(tab);
  // applyStatus 是稳定引用（空依赖），不能直接读 state 里的 running ——
  // 那样闭包会永远捕获初始值 false，把每次状态推送都当成「刚启动」，运行时间被反复清零。
  const runningStateRef = useRef(false);
  const logBufRef = useRef<string[]>([]);
  // 性能：显示值未变化就跳过 setState，避免 1.5s 轮询每次都全应用重渲染（切 tab 卡顿主因）
  const lastUpStrRef = useRef("");
  const lastDownStrRef = useRef("");
  const lastUpTotalRef = useRef("");
  const lastDownTotalRef = useRef("");
  const lastMemRef = useRef<number | null>(null);
  const proxiesFpRef = useRef("");
  const connsFpRef = useRef("");
  selectedGroupRef.current = selectedGroup;
  delaysRef.current = delays;
  autoPickRef.current = autoPick;
  groupsRef.current = groups;
  tabRef.current = tab;

  const showToast = useCallback((msg: string, ms = 2400) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), ms);
  }, []);

  const applyStatus = useCallback(
    (data: { running?: boolean; seq?: number; version?: { version?: string } }) => {
      if (typeof data.seq === "number") {
        if (data.seq < lastSeqRef.current) return;
        lastSeqRef.current = data.seq;
      }
      const r = !!data.running;
      const wasRunning = runningStateRef.current;
      runningStateRef.current = r;
      setRunning(r);
      if (r && !wasRunning) {
        // 内核刚启动，记录启动时间
        setCoreStartTime(Date.now());
      }
      if (!r) {
        setCoreStartTime(null);
        setRuleCount(null);
      }
      if (data.version && typeof data.version === "object" && "version" in data.version) {
        setVersion(String(data.version.version));
      }
      if (!r) {
        window.veyra
          ?.systemProxyStatus()
          .then((s) => setSysProxy(!!s.enabled))
          .catch(() => {});
      }
    },
    []
  );

  const refresh = useCallback(async () => {
    if (!window.veyra) return;
    try {
      const st = await window.veyra.coreStatus();
      applyStatus(st as { running?: boolean; seq?: number; version?: { version?: string } });
      // heavy：首页/代理页需要连接列表与流量历史；另外「首次还没拿到代理组」时也必须拉一次，
      // 否则用户启动后直接切到别的标签页，节点数据永远为空、启动自动测速也就永远不会触发
      const heavy = tabRef.current === "home" || tabRef.current === "proxies" || groupsRef.current.length === 0;
      if (!st.running) {
        upRateRef.current = 0;
        downRateRef.current = 0;
        setUpRate(0);
        setDownRate(0);
        setCoreMemMB(null);
        if (heavy) {
          setRateHistory((h) => ({
            up: [...h.up, 0].slice(-48),
            down: [...h.down, 0].slice(-48),
          }));
          setConnections([]);
          setConnCount(0);
        }
        return;
      }
      const ov = await window.veyra.overview();
      if (ov.mixedPort) setMixedPort(ov.mixedPort);
      if (ov.controller) setController(ov.controller);
      setMode(ov.configs?.mode || "rule");

      const up = ov.connections?.uploadTotal || 0;
      const down = ov.connections?.downloadTotal || 0;
      const now = Date.now();
      const prev = trafficRef.current;
      let ur: number | null = null;
      let dr: number | null = null;
      if (prev && now > prev.t) {
        const dt = (now - prev.t) / 1000;
        // 间隔过短时差值不可靠，跳过本次并保留旧基线，避免速率尖峰
        if (dt >= 0.3) {
          ur = Math.max(0, (up - prev.up) / dt);
          dr = Math.max(0, (down - prev.down) / dt);
        }
      }
      if (ur !== null && dr !== null) {
        // EMA：单次采样抖动只部分影响显示，不再一会大一会小
        upRateRef.current = upRateRef.current * 0.6 + ur * 0.4;
        downRateRef.current = downRateRef.current * 0.6 + dr * 0.4;
        trafficRef.current = { up, down, t: now };
      }
      // 显示字符串没变就不 setState：空闲时完全跳过重渲染
      const upStr = formatRate(upRateRef.current);
      if (upStr !== lastUpStrRef.current) {
        lastUpStrRef.current = upStr;
        setUpRate(upRateRef.current);
      }
      const downStr = formatRate(downRateRef.current);
      if (downStr !== lastDownStrRef.current) {
        lastDownStrRef.current = downStr;
        setDownRate(downRateRef.current);
      }
      const upTotal = formatBytes(up);
      if (upTotal !== lastUpTotalRef.current) {
        lastUpTotalRef.current = upTotal;
        setUpload(up);
      }
      const downTotal = formatBytes(down);
      if (downTotal !== lastDownTotalRef.current) {
        lastDownTotalRef.current = downTotal;
        setDownload(down);
      }
      const mem = typeof ov.coreMemoryMB === "number" ? Math.round(ov.coreMemoryMB) : null;
      if (mem !== lastMemRef.current) {
        lastMemRef.current = mem;
        setCoreMemMB(mem);
      }

      if (heavy) {
        // 流量历史图只在首页用：不在首页时跳过，省一次数组拷贝与重渲染
        if (tabRef.current === "home") {
          setRateHistory((h) => ({
            up: [...h.up, upRateRef.current].slice(-48),
            down: [...h.down, downRateRef.current].slice(-48),
          }));
        }
        const conns = ov.connections?.connections || [];
        const totalCount = typeof ov.connectionsCount === "number" ? ov.connectionsCount : conns.length;
        // 连接列表：空闲（总数与累计流量不变）时跳过，活跃时才刷新
        const cfp = `${totalCount}:${up}:${down}`;
        if (cfp !== connsFpRef.current) {
          connsFpRef.current = cfp;
          setConnections(conns);
          setConnCount(totalCount);
        }
        const px = ov.proxies?.proxies || {};
        const g = Object.values(px).filter((p) => GROUP_TYPES.has(p.type || ""));
        // 节点/分组数据没变（名称与当前选中节点一致）就跳过，proxies 页不再每 1.5s 全量重渲染
        const pfp = `${g.length}|${g.map((x) => `${x.name}:${x.now || ""}`).join(",")}`;
        if (pfp !== proxiesFpRef.current) {
          proxiesFpRef.current = pfp;
          setProxyMap(px);
          setGroups(g);
        }
        if (g.length && !g.find((x) => x.name === selectedGroupRef.current)) {
          setSelectedGroup(g[0].name || "");
        }
      }
      setBanner("");

      window.veyra
        .systemProxyStatus()
        .then((s) => setSysProxy(!!s.enabled))
        .catch(() => {});
    } catch {
      /* transient */
    }
  }, []);

  const goTab = useCallback(
    (id: Tab) => {
      if (id === "logs" && logBufRef.current.length) {
        const buf = logBufRef.current;
        logBufRef.current = [];
        setLogs((prev) => [...prev, ...buf].slice(-400));
      }
      startTransition(() => setTab(id));
      if (id === "proxies") {
        // 先渲染首批节点让页面立即出现，剩余节点由分批 effect 逐帧补齐，避免单次长任务
        setPxNodeLimit(PX_NODE_FIRST);
      }
      if (id === "home" || id === "proxies") {
        // 首帧绘制后再拉数据，避免与页面挂载争抢主线程
        window.setTimeout(() => {
          void refresh();
        }, 60);
      }
      if (id === "home") {
        // 设置页可能刚改过开机自启/内核通道；切回首页时同步一次，避免显示旧值
        window.veyra
          ?.getSettings()
          .then((s) => {
            setStartWithWindows(!!s.startWithWindows);
            setMihomoChannel(s.mihomoChannel === "alpha" ? "alpha" : "stable");
          })
          .catch(() => {});
      }
    },
    [refresh]
  );

  useEffect(() => {
    if (!window.veyra) return;
    // 启动时检测其他代理软件冲突
    window.veyra.detectProxyConflict?.().then((conflicts) => {
      if (conflicts?.length) {
        setBanner(`检测到其他代理软件可能正在运行：${conflicts.join("、")}。建议一次只运行一个代理软件，避免端口冲突。`);
      }
    }).catch(() => {});
    const off1 = window.veyra.onCoreStatus((d) => {
      applyStatus(d as { running?: boolean; seq?: number; version?: { version?: string } });
    });
    const off2 = window.veyra.onCoreLog((line) => {
      if (tabRef.current === "logs") {
        setLogs((prev) => [...prev.slice(-400), line]);
      } else {
        logBufRef.current.push(line);
        if (logBufRef.current.length > 400) {
          logBufRef.current = logBufRef.current.slice(-400);
        }
      }
    });
    const off3 = window.veyra.onCoreError((msg) => {
      setBanner(msg);
      showToast(msg);
    });
    const off4 = window.veyra.onSystemProxyChanged?.((d) => {
      setSysProxy(!!(d as { enabled?: boolean }).enabled);
    });

    refresh();
    window.veyra.readActiveProfile().then(setProfileText).catch(() => {});
    const reloadProfiles = () => {
      window.veyra?.listProfiles().then(setProfiles).catch(() => {});
      window.veyra?.listProfilesRich?.().then(setRichProfiles).catch(() => {});
      window.veyra?.listSubscriptions?.().then(setSubs).catch(() => {});
    };
    reloadProfiles();
    window.veyra
      .systemProxyStatus()
      .then((s) => setSysProxy(!!s.enabled))
      .catch(() => {});
    window.veyra
      .ports()
      .then((p) => {
        setMixedPort(p.mixedPort);
        setController(p.controller);
      })
      .catch(() => {});
    window.veyra
      .appInfo?.()
      .then((a) => {
        setAppVersion(a?.version || "");
        const osName = a?.platform === "win32" ? "Windows" : a?.platform === "darwin" ? "macOS" : "Linux";
        setPlatformLabel(`${osName} · ${a?.arch || ""}`.trim());
      })
      .catch(() => {});
    window.veyra
      .getSettings()
      .then((s) => {
        setAutoTest(!!s.autoTest);
        setAutoPick(!!s.autoPick);
        setAutoTestMs(Math.max(120, s.autoTestIntervalSec || 300) * 1000);
        setSubAutoUpdateMin(Math.max(0, s.subAutoUpdateMin || 0));
        setActiveCore(s.core === "singbox" ? "singbox" : "mihomo");
        setStartWithWindows(!!s.startWithWindows);
        setMihomoChannel(s.mihomoChannel === "alpha" ? "alpha" : "stable");
        if (s.homeCards && typeof s.homeCards === "object") {
          setHomeCards((prev) => ({ ...prev, ...s.homeCards }));
        }
        const m = (s.theme as ThemeMode) || "system";
        setThemeMode(m);
        applyTheme(m);
        if (s.locale) setLocale(s.locale);
        if (s.nodeSort === "name" || s.nodeSort === "default" || s.nodeSort === "delay") {
          setNodeSortMode(s.nodeSort);
        }
        if (s.customCss || s.themeColor) {
          let el = document.getElementById("veyra-custom-css") as HTMLStyleElement | null;
          if (!el) {
            el = document.createElement("style");
            el.id = "veyra-custom-css";
            document.head.appendChild(el);
          }
          el.textContent = (s.themeColor ? `:root{--accent:${s.themeColor};}` : "") + "\n" + (s.customCss || "");
        }
      })
      .catch(() => {
        applyTheme("system");
      });

    const t = window.setInterval(refresh, 1500);
    const onFocus = () => refresh();
    const onVis = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      off1();
      off2();
      off3();
      off4?.();
      window.clearInterval(t);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, [refresh, showToast, applyStatus]);

  // 记录已访问过的订阅子标签，使其挂载后保活（切换子标签不再重建编辑器）
  useEffect(() => {
    setPfSeen((seen) => (seen[pfTab] ? seen : { ...seen, [pfTab]: true }));
  }, [pfTab]);

  const currentGroup = useMemo(
    () => groups.find((g) => g.name === selectedGroup),
    [groups, selectedGroup]
  );

  // 组内可选节点（过滤掉机场信息节点）；代理页列表与首页"节点"下拉共用同一份数据
  const groupNodes = useMemo(
    () => (currentGroup?.all || []).filter((n) => !isInfoNode(n)),
    [currentGroup]
  );

  const nodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groupNodes;
    return groupNodes.filter((n) => n.toLowerCase().includes(q));
  }, [groupNodes, query]);

  const sortedNodes = useMemo(() => {
    if (nodeSortMode === "name") return [...nodes].sort((a, b) => a.localeCompare(b, "zh"));
    if (nodeSortMode === "default") return nodes;
    return sortNodesByDelay(nodes, delays);
  }, [nodes, delays, nodeSortMode]);

  const bestNode = useMemo(() => {
    let best: { name: string; delay: number } | null = null;
    for (const n of nodes) {
      if (!isTestableNode(n)) continue;
      const d = delays[n];
      if (typeof d === "number" && d > 0 && (!best || d < best.delay)) best = { name: n, delay: d };
    }
    return best;
  }, [nodes, delays]);

  const recentConn = useMemo(() => connections.slice(0, 12), [connections]);

  // 代理页节点分批补齐：每帧只新增一批，避免上百张卡片挤在一次提交里造成长任务卡顿
  useEffect(() => {
    if (tab !== "proxies" || pxNodeLimit >= sortedNodes.length) return;
    let raf = 0;
    const timer = window.setTimeout(() => {
      raf = window.requestAnimationFrame(() => {
        setPxNodeLimit((n) => Math.min(sortedNodes.length, n + PX_NODE_BATCH));
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(raf);
    };
  }, [tab, pxNodeLimit, sortedNodes.length]);

  // 切换代理组或筛选条件时回到首批，保证切组立即响应
  useEffect(() => {
    setPxNodeLimit(PX_NODE_FIRST);
  }, [selectedGroup, query, nodeSortMode]);

  const currentNode = useMemo(() => {
    const g = groups.find((x) => x.name === selectedGroup) || groups[0];
    return g?.now || "—";
  }, [groups, selectedGroup]);

  // 当前节点的协议类型 / UDP / 延迟：当前节点卡片展示用
  const currentNodeInfo = useMemo(() => {
    if (!currentNode || currentNode === "—") {
      return { type: "", udp: false, delay: undefined as number | undefined };
    }
    const info = proxyMap[currentNode];
    return { type: info?.type || "", udp: !!info?.udp, delay: delays[currentNode] };
  }, [proxyMap, delays, currentNode]);

  const hasSubscription = groups.length > 0 || profiles.length > 0 || subs.length > 0;
  const totalTraffic = upload + download;
  const statusKey = !running ? "off" : running && sysProxy ? "on" : "idle";
  const statusLabel = !running ? "已停止" : running && sysProxy ? "生效中" : "内核运行中";

  const runSpeedTest = useCallback(
    async (opts?: { silent?: boolean; pickBest?: boolean; only?: string[] }) => {
      if (!window.veyra || testingRef.current) return;
      const groupName = selectedGroupRef.current;
      const group = groupsRef.current.find((g) => g.name === groupName);
      const all = group?.all || [];
      // only 用于「快检」：只测指定节点（通常只有当前节点），不必每次全量扫 80 个
      const batch = opts?.only?.length
        ? opts.only.filter(isTestableNode)
        : all.filter(isTestableNode).slice(0, 80);
      const silent = !!opts?.silent;
      // 非静默时必须给出反馈：否则用户点了「一键测速」/自动触发却毫无动静，不知道到底测没测
      if (!batch.length) {
        if (!silent) showToast("暂无可测速节点：请先导入订阅或等待节点加载完成");
        return;
      }

      testingRef.current = true;
      // 静默模式不进入「测速中」状态：界面不再常驻转圈，用户只会看到延迟数字悄悄更新
      if (!silent) {
        setTesting(true);
        setTestProgress(0);
        showToast(`开始测速 · 共 ${batch.length} 个节点…`, 2600);
      }

      const next = { ...delaysRef.current };
      let done = 0;
      await mapPool(batch, 8, async (n) => {
        if (!silent) setTestingNode(n);
        try {
          const r = await window.veyra!.testDelay(n);
          const d = r.data?.delay;
          next[n] = typeof d === "number" ? d : 0;
        } catch {
          next[n] = 0;
        }
        done += 1;
        // 静默时不做逐节点 setState：一次全量测速最多 80 次提交会持续占住主线程
        if (!silent) {
          setTestProgress(Math.round((done / batch.length) * 100));
          setDelays({ ...next });
        }
      });

      delaysRef.current = next;
      setDelays(next);
      // 记录延迟历史（每个节点保留最近20次）
      setDelayHistory((prev) => {
        const updated = { ...prev };
        const now = Date.now();
        for (const [name, ms] of Object.entries(next)) {
          if (typeof ms === "number" && ms > 0) {
            const arr = [...(updated[name] || []), { t: now, ms }];
            updated[name] = arr.slice(-20);
          }
        }
        try {
          localStorage.setItem("veyra-delay-history", JSON.stringify(updated));
        } catch {}
        return updated;
      });
      setTestingNode(null);
      setTesting(false);
      testingRef.current = false;
      setLastTestAt(Date.now());
      setTestProgress(100);

      const pick = opts?.pickBest ?? autoPickRef.current;
      if (pick && window.veyra && group) {
        let winner: string | null = null;
        let best = Infinity;
        for (const n of batch) {
          const d = next[n];
          if (typeof d === "number" && d > 0 && d < best) {
            best = d;
            winner = n;
          }
        }
        // 迟滞：候选需「快 15% 以上」或「快 40ms 以上」才切换。
        // 放宽到这两个条件是为了让更优节点真的能被切过去；
        // 同时仍能挡住 70ms vs 74ms 这种无意义的来回跳。
        const curName = group.now || "";
        const curRaw = next[curName];
        const curDelay = typeof curRaw === "number" ? curRaw : 0;
        const worthSwitching = curDelay > 0 ? (best <= curDelay * 0.85 || curDelay - best >= 40) : true;
        if (winner && curName !== winner && worthSwitching) {
          try {
            await window.veyra.selectProxy(group.name || "", winner);
            // 静默模式（自动保持最优）不弹提示，否则每隔几分钟就冒一个 toast
            if (!silent) showToast(`测速完成 · 已切换到最低延迟 ${winner}（${best} ms）`, 4200);
            await refresh();
          } catch {
            if (!silent) showToast("测速完成，但自动切换节点失败", 4200);
          }
        } else if (winner && !silent) {
          const curD = typeof curRaw === "number" && curRaw > 0 ? curRaw : 0;
          showToast(
            curName === winner
              ? `测速完成 · 当前节点 ${winner} 已是最优（${best} ms）`
              : `测速完成 · 保持 ${curName || "当前节点"}${curD ? `（${curD} ms）` : ""}，最优 ${winner}（${best} ms）`,
            4200
          );
        } else if (!silent) {
          showToast("测速完成 · 没有可用的低延迟节点", 4200);
        }
      } else if (!silent) {
        showToast(`测速完成 · 已更新 ${batch.length} 个节点延迟`, 4200);
      }
    },
    [refresh, showToast]
  );

  // 自动保持最优节点：两级调度，避免「一直在全量测速」
  //   快检（20s）：只测当前节点，确认它还活着；一旦失效立刻触发全量重扫
  //   全量（≥2 分钟）：扫一遍找更优节点，静默切换，不打扰用户
  useEffect(() => {
    if (!running || !autoTest || !window.veyra) return;
    let cancelled = false;

    const fullScan = () => {
      if (cancelled) return;
      void runSpeedTest({ silent: true, pickBest: autoPickRef.current });
    };
    const quickCheck = async () => {
      if (cancelled) return;
      const cur = groupsRef.current.find((g) => g.name === selectedGroupRef.current)?.now;
      if (!cur || !isTestableNode(cur)) return;
      await runSpeedTest({ silent: true, pickBest: false, only: [cur] });
      const d = delaysRef.current[cur];
      // 当前节点失效（超时/测不到）→ 立即全量重扫换节点，保证「任何时候都在用可用最优」
      if (!(typeof d === "number" && d > 0)) fullScan();
    };

    const quickTimer = window.setInterval(quickCheck, 20_000);
    const fullTimer = window.setInterval(fullScan, Math.max(autoTestMs, 120_000));
    return () => {
      cancelled = true;
      window.clearInterval(quickTimer);
      window.clearInterval(fullTimer);
    };
  }, [running, autoTest, autoTestMs, selectedGroup, runSpeedTest]);

  // 启动后自动测一次速（可见）：不再盲目等 1.2s —— 之前若节点数据还没加载完，
  // 全量测速会因为 batch 为空直接静默返回，用户既看不到进度也看不到结果，
  // 完全不知道到底测没测。改为「等节点数据真正就绪」再触发，保证打开软件必测一次。
  // 内核停止时重置标记，下次启动会重新测。
  useEffect(() => {
    if (!running) {
      bootTestedRef.current = false;
      return;
    }
    if (!autoTest || !window.veyra) return;
    if (bootTestedRef.current) return;
    const g = groups.find((x) => x.name === selectedGroup) || groups[0];
    const ready = (g?.all || []).filter(isTestableNode).length > 0;
    if (!ready) return; // 节点尚未就绪：等 groups 更新后本 effect 会再跑一次
    const t = window.setTimeout(() => {
      bootTestedRef.current = true;
      void runSpeedTest({ silent: false, pickBest: autoPickRef.current });
    }, 400);
    return () => window.clearTimeout(t);
  }, [running, autoTest, groups, selectedGroup, runSpeedTest]);

  useEffect(() => {
    if (themeMode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [themeMode]);

  const changeTheme = useCallback(async (m: ThemeMode) => {
    setThemeMode(m);
    applyTheme(m);
    await window.veyra?.setSettings({ theme: m });
  }, []);

  // 传给 SettingsPanel 的回调保持稳定引用，否则 memo 失效
  const handlePorts = useCallback((m: number, c: string) => {
    setMixedPort(m);
    setController(c);
  }, []);

  const handlePrefs = useCallback((p: {
    autoTest?: boolean;
    autoPick?: boolean;
    autoTestIntervalSec?: number;
    subAutoUpdateMin?: number;
  }) => {
    if (p.autoTest != null) setAutoTest(p.autoTest);
    if (p.autoPick != null) setAutoPick(p.autoPick);
    if (p.autoTestIntervalSec != null) {
      setAutoTestMs(Math.max(120, p.autoTestIntervalSec) * 1000);
    }
    if (p.subAutoUpdateMin != null) {
      setSubAutoUpdateMin(Math.max(0, p.subAutoUpdateMin));
    }
  }, []);

  useEffect(() => {
    if (!running || !window.veyra?.exitIp) return;
    // 服务启动时自动检测出口 IP（真实检测）
    window.veyra.exitIp().then((r) => {
      setExitIp(r || { ip: null });
      if (!r?.ip) showToast("IP 检测失败，请点击重试");
    }).catch(() => {
      setExitIp({ ip: null });
      showToast("IP 检测失败，请点击重试");
    });
  }, [running]);

  useEffect(() => {
    if (!window.veyra) return;
    // 参考 clash-verge-rev：常驻定时检查，只更新到达 nextUpdateAt 的订阅
    // （nextUpdateAt 优先取机场 profile-update-interval 头，其次取设置里的间隔）
    const tick = async () => {
      try {
        const list = (await window.veyra!.listSubscriptions()) as typeof subs;
        const due = list.filter((s) => !!s.nextUpdateAt && Date.now() >= s.nextUpdateAt);
        if (!due.length) return;
        let ok = 0;
        for (const s of due) {
          try {
            await window.veyra!.importProfileUrl({ url: s.url, name: s.name });
            ok += 1;
          } catch (e) {
            showToast(`订阅自动更新失败：${(e as Error).message || e}`, 5000);
          }
        }
        if (ok) showToast(`订阅已自动更新（${ok}/${due.length}），流量信息已同步`, 5000);
        await reloadProfileLists();
        refresh();
      } catch (e) {
        showToast(`订阅自动更新失败：${(e as Error).message || e}`);
      }
    };
    const timer = window.setInterval(tick, 10 * 60_000);
    return () => window.clearInterval(timer);
  }, [refresh, showToast]);

  // 侧栏电源按钮 = 系统代理开关；内核由软件托管常驻，不在按钮里启停
  async function toggleSysProxy() {
    if (!window.veyra) return;
    if (!running) return showToast("内核未运行，无法开启系统代理");
    setBusy(true);
    try {
      const next = !sysProxy;
      const r = await window.veyra.setSystemProxy(next);
      if (r.ok) {
        setSysProxy(!!r.enabled);
        showToast(next ? `系统代理 → 127.0.0.1:${mixedPort}` : "系统代理已关闭", 3200);
      } else {
        showToast("系统代理设置失败");
      }
    } catch (e) {
      showToast(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  async function changeMode(m: string) {
    if (!window.veyra || !running) return;
    await window.veyra.setMode(m);
    setMode(m);
    showToast(`模式：${MODE_LABEL[m] || m}`);
  }

  async function selectNode(name: string) {
    if (!window.veyra || !currentGroup) return;
    await window.veyra.selectProxy(currentGroup.name || "", name);
    showToast(`已切换 → ${name}`);
    refresh();
  }

  async function testAll() {
    await runSpeedTest({ silent: false, pickBest: autoPick });
  }

  async function reloadProfileLists() {
    if (!window.veyra) return;
    setProfiles(await window.veyra.listProfiles());
    setRichProfiles((await window.veyra.listProfilesRich?.()) || []);
    setSubs(await window.veyra.listSubscriptions());
  }

  async function updateSubscriptions() {
    if (!window.veyra || !subs.length) return;
    setBusy(true);
    try {
      let ok = 0;
      for (const s of subs) {
        try {
          await window.veyra.importProfileUrl({ url: s.url, name: s.name });
          ok += 1;
        } catch (e) {
          showToast(`订阅更新失败：${(e as Error).message || e}`, 5000);
        }
      }
      await reloadProfileLists();
      refresh();
      if (ok) showToast(`订阅已更新（${ok}/${subs.length}），流量信息已同步`, 5000);
    } finally {
      setBusy(false);
    }
  }

  async function saveProfile() {
    if (!window.veyra) return;
    if (!profileText.trim()) return showToast("配置内容为空");
    setBusy(true);
    try {
      if (editUid && window.veyra.writeProfile) {
        await window.veyra.writeProfile(editUid, profileText);
        const r = await window.veyra.enhanceApply?.();
        const lines = [...(r?.warnings || []), ...(r?.scriptLogs || [])];
        setEnhanceLog(lines);
        showToast("已保存并重新增强");
      } else {
        const r = await window.veyra.importProfile({ name: profileName, content: profileText });
        if (r.mixedPort) setMixedPort(r.mixedPort);
        if (r.controller) setController(r.controller);
        setEnhanceLog(r.warnings || []);
        showToast("订阅已导入并增强");
      }
      await reloadProfileLists();
      setProfileText(await window.veyra.readActiveProfile());
      setEditUid(null);
      await refresh();
    } catch (e) {
      showToast(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  async function importFromUrl(url = subUrl) {
    if (!window.veyra) return;
    const u = url.trim();
    if (!u) return showToast("请粘贴订阅链接");
    setBusy(true);
    try {
      const r = await window.veyra.importProfileUrl({ url: u, name: profileName });
      if (r.mixedPort) setMixedPort(r.mixedPort);
      if (r.controller) setController(r.controller);
      setProfileText(await window.veyra.readActiveProfile());
      await reloadProfileLists();
      setSubUrl(u);
      setEditUid(null);
      setEnhanceLog(r.warnings || []);
      showToast(`链接导入成功（${r.bytes || 0} 字节）`);
      await refresh();
    } catch (e) {
      showToast(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  async function createEnhance(kind: EnhanceKind, global = false) {
    if (!window.veyra?.createEnhanceProfile) return;
    setBusy(true);
    try {
      const name = global ? `global-${kind}` : kind;
      const item = await window.veyra.createEnhanceProfile(kind, name, global);
      await reloadProfileLists();
      if (item?.uid && window.veyra.readProfile) {
        setEditUid(item.uid);
        setProfileName(item.name);
        setProfileText(await window.veyra.readProfile(item.uid));
        setEditorMode("profile");
      }
      showToast(`已创建 ${kind}${global ? "（全局）" : ""}`);
    } catch (e) {
      showToast(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  async function reloadProviders() {
    try {
      const p = await window.veyra?.listProviders?.();
      setProviders({
        proxies: Object.keys(p?.proxies || {}),
        rules: Object.keys(p?.rules || {}),
      });
    } catch {
      setProviders({ proxies: [], rules: [] });
    }
  }

  async function applyEnhance() {
    if (!window.veyra?.enhanceApply) return;
    setBusy(true);
    try {
      const r = await window.veyra.enhanceApply();
      const lines = [...(r.warnings || []), ...(r.scriptLogs || [])];
      setEnhanceLog(lines);
      setProfileText(await window.veyra.readActiveProfile());
      showToast(lines.length ? `增强完成（${lines.length} 条提示）` : "增强已应用");
      await refresh();
    } catch (e) {
      showToast(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  const navItems = (
    [
      ["home", NavHomeIcon, t("nav.home", "首页"), null],
      ["proxies", NavProxiesIcon, t("nav.proxies", "代理"), nodes.length || groups.reduce((a, g) => a + (g.all?.length || 0), 0) || null],
      ["profiles", NavProfilesIcon, t("nav.profiles", "订阅"), subs.length + profiles.length || null],
      ["connections", NavConnectionsIcon, t("nav.connections", "连接"), connCount || null],
      ["rules", NavRulesIcon, t("nav.rules", "规则"), null],
      ["logs", NavLogsIcon, t("nav.logs", "日志"), null],
      ["tests", NavTestsIcon, t("nav.tests", "测试"), null],
      ["settings", NavSettingsIcon, t("nav.settings", "设置"), null],
    ] as const
  );

  return (
    <div className={`app ${busy ? "busy" : ""} ${running ? "is-on" : ""} ${sysProxy ? "proxy-on" : ""}`}>
      <div className="container">
        {/* Header */}
        <header className="header">
          <div className="header-brand">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="32" height="32" style={{color:'var(--cyan-500)'}}><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2"/><line x1="12" y1="22" x2="12" y2="15.5"/><polyline points="22 8.5 12 15.5 2 8.5"/><polyline points="2 15.5 12 8.5 22 15.5"/><line x1="12" y1="2" x2="12" y2="8.5"/></svg>
            <span className="brand-text">VEYRA PROXY</span>
          </div>
          <div className="header-actions">
            <button
              type="button"
              className={`speed-chip${testing ? " testing" : lastTestAt > 0 ? " done" : " idle"}`}
              onClick={() => {
                if (testing || !running) return;
                void runSpeedTest({ silent: false, pickBest: autoPick });
              }}
              title={
                testing
                  ? `正在测速：${testProgress}%（${nodes.length} 个节点）`
                  : !running
                    ? "内核未运行，启动后才能测速"
                    : lastTestAt > 0
                      ? `上次测速 ${new Date(lastTestAt).toLocaleString()} · 当前节点 ${currentNode} · 点击立即重新测速`
                      : "点击立即测速"
              }
            >
              {testing ? (
                <>
                  <span className="speed-chip-dot spin" />
                  <span>测速中 {testProgress}%</span>
                </>
              ) : lastTestAt > 0 ? (
                <>
                  <span className="speed-chip-dot ok" />
                  <span className="speed-chip-node" title={currentNode}>{currentNode}</span>
                  <b className={delayClass(currentNodeInfo.delay)}>{delayText(currentNodeInfo.delay)}</b>
                  <span className="speed-chip-time">{new Date(lastTestAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
                </>
              ) : (
                <>
                  <span className="speed-chip-dot" />
                  <span>{autoTest ? "等待自动测速…" : "自动测速已关闭"}</span>
                </>
              )}
            </button>
            <div className="header-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input
                type="text"
                placeholder="搜索节点..."
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  if (tabRef.current !== "proxies") goTab("proxies");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") goTab("proxies");
                }}
              />
            </div>
            <div className="header-icons">
              <button
                type="button"
                className={`icon-btn${showRail ? " on" : ""}`}
                title={showRail ? "收起右侧信息栏" : "展开右侧信息栏"}
                aria-pressed={showRail}
                onClick={() => setRailOverride(!showRail)}
              >
                <PanelRight size={18} />
              </button>
              <button type="button" className="icon-btn" onClick={() => window.veyra?.minimize()}><Minus size={18} /></button>
              <button type="button" className="icon-btn" onClick={() => window.veyra?.close()}><X size={18} /></button>
            </div>
          </div>
        </header>

        {banner ? (
          <div className="card" style={{marginBottom:16,borderColor:'color-mix(in srgb, var(--bad) 50%, transparent)',background:'color-mix(in srgb, var(--bad) 10%, transparent)',padding:'10px 16px',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
            <span style={{color:'var(--red-400)',fontSize:13}}>{banner}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBanner("")}>关闭</button>
          </div>
        ) : null}

        {/* 三栏骨架：侧栏 + 主区 + 右栏（可收起） */}
        <div className={`grid-12${showRail ? "" : " no-rail"}`}>
          {/* Left Sidebar */}
          <div className="col-sidebar">
            <div className="card" style={{height:'fit-content',position:'sticky',top:16}}>
              <div className="card-body tight">
                <nav className="nav-list">
                  {navItems.map(([id, Icon, label, badge]) => (
                    <button key={id} type="button" className={`nav-item ${tab === id ? "active" : ""}`} onClick={() => goTab(id)}>
                      <Icon />
                      <span>{label}</span>
                      {typeof badge === "number" && badge > 0 ? (
                        <span className="badge badge-cyan" style={{marginLeft:'auto'}}>{badge > 99 ? "99+" : badge}</span>
                      ) : null}
                    </button>
                  ))}
                </nav>
                <div className="mt-8 pt-6 border-t">
                  <div className="nav-section-title">系统状态</div>
                  <div className="status-item">
                    <div className="status-item-hd"><span>内核</span><span>{running ? "运行中" : "已停止"}</span></div>
                    <div className="status-bar"><i className={running ? "cyan" : "purple"} style={{width:running?"100%":"0%"}}/></div>
                  </div>
                  <div className="status-item">
                    <div className="status-item-hd"><span>网络</span><span>{sysProxy ? "已开启" : "未开启"}</span></div>
                    <div className="status-bar"><i className={sysProxy ? "green" : "blue"} style={{width:sysProxy?"100%":"0%"}}/></div>
                  </div>
                  <div className="status-item">
                    <div className="status-item-hd"><span>连接数</span><span>{connCount}</span></div>
                    <div className="status-bar"><i className="blue" style={{width:`${Math.min(100,connCount*5)}%`}}/></div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Main Content */}
          <div className="col-main">
        <main className="stage">
          {tab === "home" && (
            <div className="pane home" hidden={tab !== "home"}>
              <section className={`overview-strip ${running ? "online" : "offline"}`}>
                <div className="overview-status">
                  <span className="overview-pulse" />
                  <div>
                    <span className="overview-eyebrow">代理服务</span>
                    <strong>{running ? "运行正常" : "服务已停止"}</strong>
                    <small>{running ? `127.0.0.1:${mixedPort} · ${activeCore === "singbox" ? "sing-box" : "mihomo"}` : "启动服务后即可接管系统流量"}</small>
                  </div>
                </div>
                <div className="overview-metrics">
                  <div><span>当前模式</span><b>{MODE_LABEL[mode] || mode}</b></div>
                  <div><span>活动连接</span><b>{connCount}</b></div>
                  <div><span>下载速率</span><b>{formatRate(downRate)}</b></div>
                </div>
                <button type="button" className={`overview-action ${sysProxy ? "enabled" : ""}`} onClick={toggleSysProxy} disabled={busy || !running}>
                  <Power size={16} />
                  {sysProxy ? "系统代理已开启" : "开启系统代理"}
                </button>
              </section>
              {/* 6卡片网格 */}
              <div className="home-cards">
                {homeCards.subscription && (
                  <section className="home-card" style={{ order: 3 }}>
                    <div className="home-card-hd">
                      <h2><CardSubIcon /> 订阅</h2>
                      <div className="home-card-hd-actions">
                        <button type="button" className="home-card-link" onClick={updateSubscriptions}>
                          更新
                        </button>
                        <button type="button" className="home-card-link" onClick={() => goTab("profiles")}>
                          订阅 &gt;
                        </button>
                      </div>
                    </div>
                    <div className="home-card-bd">
                      {(() => {
                        const sub = subs.find((s) => s.userinfo) || subs[0];
                        if (!sub) {
                          return (
                            <>
                              <p className="muted">导入订阅链接后即可测速并选用节点。</p>
                              <button type="button" className="btn primary" onClick={() => goTab("profiles")}>
                                <Plus size={16} />
                                导入订阅
                              </button>
                            </>
                          );
                        }
                        const fmtGB = (b: number) => (b / 1024 ** 3).toFixed(1) + "GB";
                        let host = "";
                        try { host = new URL(sub.url).host; } catch {}
                        const u = sub.userinfo;
                        const used = u ? u.upload + u.download : 0;
                        const pct = u && u.total > 0
                          ? Math.min(100, Math.max(0, Math.round(((u.upload + u.download) / u.total) * 100)))
                          : null;
                        return (
                          <div className="sub-usage">
                            <InfoRow icon={Globe} label="来自" mono>{host || sub.name}</InfoRow>
                            <InfoRow icon={Clock} label="更新时间" mono>
                              {new Date(sub.updatedAt).toLocaleString("zh-CN", { hour12: false })}
                            </InfoRow>
                            {u && (
                              <>
                                <InfoRow icon={PieChart} label="已使用 / 总量" mono>
                                  {fmtGB(used)} / {fmtGB(u.total)}
                                </InfoRow>
                                <InfoRow icon={Database} label="剩余流量" mono>
                                  {fmtGB(Math.max(0, u.total - used))}
                                </InfoRow>
                                <InfoRow icon={CalendarClock} label="到期时间" mono>
                                  {u.expire ? new Date(u.expire * 1000).toLocaleDateString("zh-CN") : "—"}
                                </InfoRow>
                                <div className="sub-quota">
                                  <div className="sub-quota-bar"><i style={{ width: `${pct ?? 0}%` }} /></div>
                                  <span>{pct ?? 0}%</span>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </section>
                )}

                {homeCards.node && (
                  <section className="home-card" style={{ order: 1 }}>
                    <div className="home-card-hd">
                      <h2><CardNodeIcon /> 当前节点</h2>
                      <button type="button" className="home-card-link" onClick={() => goTab("proxies")}>
                        代理 &gt;
                      </button>
                    </div>
                    <div className="home-card-bd">
                      {groups.length === 0 ? (
                        <p className="muted">暂无节点，请先<button type="button" className="link-btn" onClick={() => goTab("profiles")}>导入订阅</button>。</p>
                      ) : (
                        <>
                          <div className="node-hero">
                            <i className={`node-dot ${running ? "on" : ""}`} />
                            <div className="node-hero-main">
                              <b className="node-hero-name" title={currentNode}>{currentNode || "—"}</b>
                              <span className="node-hero-tags">
                                {currentNodeInfo.type ? <em>{currentNodeInfo.type}</em> : null}
                                {currentNodeInfo.udp ? <i>UDP</i> : null}
                              </span>
                            </div>
                            <span className={`node-delay ${delayClass(currentNodeInfo.delay)}`} title="当前节点延迟">
                              {delayText(currentNodeInfo.delay)}
                            </span>
                          </div>
                          <div className="node-selects">
                        <div>
                          <em>代理组</em>
                          <select
                            value={selectedGroup}
                            onChange={(e) => setSelectedGroup(e.target.value)}
                            disabled={!running}
                          >
                            {groups.map((g) => (
                              <option key={g.name} value={g.name}>{g.name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <em>节点</em>
                          <select
                            disabled={!running || !groupNodes.length}
                            value={currentGroup?.now || ""}
                            onChange={(e) => selectNode(e.target.value)}
                            title="切换当前组内的节点"
                          >
                            {groupNodes.length ? (
                              groupNodes.map((n) => (
                                <option key={n} value={n}>{n}</option>
                              ))
                            ) : (
                              <option value="">{currentNode || "—"}</option>
                            )}
                          </select>
                        </div>
                      </div>
                        </>
                      )}
                    </div>
                  </section>
                )}

                {homeCards.network && (
                  <section className="home-card" style={{ order: 4 }}>
                    <div className="home-card-hd">
                      <h2><CardNetIcon /> 网络设置</h2>
                    </div>
                    <div className="home-card-bd">
                      <InfoRow icon={ShieldCheck} label="系统代理">
                        <button
                          type="button"
                          className={`switch ${sysProxy ? "on" : ""}`}
                          onClick={toggleSysProxy}
                          aria-label="系统代理开关"
                        >
                          <i />
                        </button>
                      </InfoRow>
                      <InfoRow icon={Cable} label="混合端口" mono>127.0.0.1:{mixedPort}</InfoRow>
                      <InfoRow icon={Terminal} label="控制端口" mono>{controller.split(":")[1] || "—"}</InfoRow>
                      <InfoRow icon={Cpu} label="内核">{activeCore === "singbox" ? "sing-box" : "mihomo"}</InfoRow>
                    </div>
                  </section>
                )}

                {homeCards.mode && (
                  <section className="home-card" style={{ order: 2 }}>
                    <div className="home-card-hd">
                      <h2><CardModeIcon /> 代理模式</h2>
                    </div>
                    <div className="home-card-bd">
                      <div className="mode-cards text-only">
                        {([
                          ["rule", "规则", "智能分流", "#2c71e8", Route],
                          ["global", "全局", "全部代理", "#10b981", Globe],
                          ["direct", "直连", "直接连接", "#f59e0b", Zap],
                        ] as const).map(([m, label, desc, color, Icon]) => (
                          <button
                            key={m}
                            type="button"
                            className={`mode-tcard${mode === m ? " active" : ""}`}
                            onClick={() => changeMode(m)}
                            disabled={!running}
                          >
                            <span className="mode-tcard-ico"><Icon /></span>
                            <span className="mode-tcard-word" style={{ color: mode === m ? color : undefined }}>{label}</span>
                            <span className="mode-tcard-desc">{desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </section>
                )}

                {homeCards.traffic && (
                  <section className="home-card" style={{ order: 5 }}>
                    <div className="home-card-hd">
                      <h2><CardTrafficIcon /> 流量统计</h2>
                    </div>
                    <div className="home-card-bd">
                      <div className="traffic-grid">
                        <div className="traffic-cell">
                          <em><ArrowUp size={13} /> 上传速度</em>
                          <b>{formatRate(upRate)}</b>
                        </div>
                        <div className="traffic-cell">
                          <em><ArrowDown size={13} /> 下载速度</em>
                          <b>{formatRate(downRate)}</b>
                        </div>
                        <div className="traffic-cell">
                          <em><Network size={13} /> 活跃连接</em>
                          <b>{connCount}</b>
                        </div>
                        <div className="traffic-cell">
                          <em><ArrowUp size={13} /> 上传量</em>
                          <b>{formatBytes(upload)}</b>
                        </div>
                        <div className="traffic-cell">
                          <em><ArrowDown size={13} /> 下载量</em>
                          <b>{formatBytes(download)}</b>
                        </div>
                        <div className="traffic-cell">
                          <em><HardDrive size={13} /> 内核占用</em>
                          <b>{coreMemMB != null ? `${coreMemMB.toFixed(0)} MB` : "—"}</b>
                        </div>
                      </div>
                    </div>
                  </section>
                )}

                {homeCards.ip && (
                  <section className="home-card" style={{ order: 7 }}>
                    <div className="home-card-hd">
                      <h2><CardIpIcon /> IP 信息</h2>
                      <button
                        type="button"
                        className="home-card-link"
                        title="刷新"
                        onClick={async () => {
                          try {
                            const r = await window.veyra?.exitIp?.();
                            setExitIp(r || { ip: null });
                          } catch (e) {
                            showToast(String((e as Error).message || e));
                          }
                        }}
                      >
                        <RefreshCw size={14} />
                      </button>
                    </div>
                    <div className="home-card-bd">
                      {exitIp?.ip ? (
                        <>
                          <div className="ip-main">
                            <span className="ip-flag">{exitIp.countryCode || exitIp.country?.slice(0, 2).toUpperCase() || "—"}</span>
                            <div>
                              <div className="mono ip-addr">{exitIp.ip}</div>
                              <div className="muted ip-loc">{[exitIp.city, exitIp.region, exitIp.country].filter(Boolean).join(", ") || "未知地区"}</div>
                            </div>
                          </div>
                          <InfoRow icon={Building2} label="服务商">{exitIp.isp || "—"}</InfoRow>
                          <InfoRow icon={Layers3} label="组织">{exitIp.org || "—"}</InfoRow>
                          <InfoRow icon={Network} label="自治域" mono>{exitIp.as || "—"}</InfoRow>
                          <InfoRow icon={Globe} label="时区" mono>{exitIp.timezone || "—"}</InfoRow>
                          {(exitIp.lat != null && exitIp.lon != null) && (
                            <InfoRow icon={MapPin} label="坐标" mono>{exitIp.lat}, {exitIp.lon}</InfoRow>
                          )}
                          <button
                            type="button"
                            className="btn sm"
                            onClick={async () => {
                              try {
                                const r = await window.veyra?.exitIp?.();
                                setExitIp(r || { ip: null });
                              } catch (e) {
                                showToast(String((e as Error).message || e));
                              }
                            }}
                          >
                            重新检测
                          </button>
                        </>
                      ) : (
                        <>
                          <p className="muted">检测当前出口 IP 及归属地。</p>
                          <button
                            type="button"
                            className="btn"
                            onClick={async () => {
                              try {
                                const r = await window.veyra?.exitIp?.();
                                setExitIp(r || { ip: null });
                                showToast(r?.ip ? `出口 ${r.ip}` : "未能获取出口 IP");
                              } catch (e) {
                                showToast(String((e as Error).message || e));
                              }
                            }}
                          >
                            点击检测
                          </button>
                        </>
                      )}
                    </div>
                  </section>
                )}

                {homeCards.core && (
                  <section className="home-card" style={{ order: 6 }}>
                    <div className="home-card-hd">
                      <h2><CardCoreIcon /> 内核信息</h2>
                    </div>
                    <div className="home-card-bd">
                      <InfoRow icon={Cpu} label="内核版本" mono>
                        {coreVersion ? `${coreVersion} ${coreType === "sing-box" ? "Sing-Box" : "Mihomo"}` : "—"}
                      </InfoRow>
                      <InfoRow icon={ShieldCheck} label="系统代理地址" mono>127.0.0.1:{mixedPort}</InfoRow>
                      <InfoRow icon={Cable} label="混合代理端口" mono>{mixedPort}</InfoRow>
                      <InfoRow icon={Clock} label="运行时间" mono>
                        {running && coreStartTime ? formatUptime(Date.now() - coreStartTime) : "—"}
                      </InfoRow>
                      <InfoRow icon={ListTree} label="规则数量" mono>{ruleCount != null ? ruleCount : "—"}</InfoRow>
                    </div>
                  </section>
                )}

                {homeCards.system && (
                  <section className="home-card" style={{ order: 8 }}>
                    <div className="home-card-hd">
                      <h2><CardSysIcon /> 系统信息</h2>
                      <button
                        type="button"
                        className="home-card-link"
                        title="设置"
                        onClick={() => goTab("settings")}
                      >
                        <Settings size={14} />
                      </button>
                    </div>
                    <div className="home-card-bd">
                      <InfoRow icon={Monitor} label="操作系统信息">{platformLabel}</InfoRow>
                      <InfoRow icon={Power} label="开机自启">
                        <button
                          type="button"
                          className="status-pill"
                          style={
                            startWithWindows
                              ? undefined
                              : { background: "color-mix(in srgb, var(--text-500) 15%, transparent)", color: "var(--text-400)" }
                          }
                          onClick={() => goTab("settings")}
                          title="点击到「设置 → 系统」中修改"
                        >
                          {startWithWindows ? "已启用" : "未启用"}
                        </button>
                      </InfoRow>
                      <InfoRow icon={SlidersHorizontal} label="运行模式"><b className="ok-text">桌面模式</b></InfoRow>
                      <InfoRow icon={RefreshCw} label="内核通道" mono>{mihomoChannel === "alpha" ? "测试版 alpha" : "稳定版 stable"}</InfoRow>
                      <InfoRow icon={Layers3} label="应用版本" mono>v{appVersion || "—"}</InfoRow>
                    </div>
                  </section>
                )}

                {homeCards.webtest && (
                  <section className="home-card wide" style={{ order: 9 }}>
                    <div className="home-card-hd">
                      <h2><CardWebIcon /> 网站测试</h2>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => goTab("tests")}
                      >
                        更多 &gt;
                      </button>
                    </div>
                    <div className="home-card-bd">
                      <div className="webtest-grid">
                        {[
                          { name: "Google", Icon: WebGoogleIcon, url: "https://www.google.com/generate_204" },
                          { name: "GitHub", Icon: WebGithubIcon, url: "https://api.github.com" },
                          { name: "YouTube", Icon: WebYoutubeIcon, url: "https://www.youtube.com/generate_204" },
                          { name: "X", Icon: WebXIcon, url: "https://api.twitter.com" },
                        ].map(({ name, Icon, url }) => (
                          <div key={name} className="webtest-item">
                            <span className="webtest-logo">
                              <Icon />
                            </span>
                            <span className="webtest-name">{name}</span>
                            <button
                              type="button"
                              className="link-btn webtest-test"
                              onClick={async () => {
                                showToast(`正在测试 ${name}...`);
                                try {
                                  const start = Date.now();
                                  await fetch(url, { mode: "no-cors", signal: AbortSignal.timeout(8000) });
                                  const ms = Date.now() - start;
                                  showToast(`${name} 连通 (${ms}ms)`);
                                } catch {
                                  showToast(`${name} 连接失败`);
                                }
                              }}
                            >
                              测试
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </section>
                )}
              </div>
            </div>
          )}

          {tab === "proxies" && (
            <div className="pane px" hidden={tab !== "proxies"}>
              <div className="px-header-card">
                <div className="px-tabs">
                  {groups.length ? (
                    groups.map((g) => (
                      <button
                        key={g.name}
                        type="button"
                        className={`px-tab ${g.name === selectedGroup ? "active" : ""}`}
                        onClick={() => setSelectedGroup(g.name || "")}
                        title={g.name || ""}
                      >
                        <span className="gt-ico"><Server size={14} /></span>
                        <span className="gt-txt">
                          <b>{g.name}</b>
                          <small>{g.now || g.type}</small>
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="empty slim">暂无代理组 — 请先到订阅页导入配置</div>
                  )}
                </div>

                <div className="px-toolbar">
                  <div className="px-meta">
                    <span className="meta-dot" />
                    {nodes.length} 个节点
                    {autoTest && autoPick
                      ? ` · 自动保持最优（每 ${Math.max(2, Math.round(autoTestMs / 60000))} 分钟全量复测 · 20 秒快检当前节点）`
                      : autoTest
                        ? " · 自动测速（只测不切）"
                        : " · 自动测速已关闭"}
                    {lastTestAt > 0 ? ` · 上次测速 ${new Date(lastTestAt).toLocaleTimeString()}` : ""}
                  </div>
                  <div className="px-tools">
                    <label className="proxies-search">
                      <Search size={15} />
                      <input
                        placeholder="搜索节点"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                    <label className="switch compact">
                      <input
                        type="checkbox"
                        checked={autoTest}
                        onChange={async (e) => {
                          const v = e.target.checked;
                          setAutoTest(v);
                          await window.veyra?.setSettings({ autoTest: v });
                        }}
                      />
                      自动测速
                    </label>
                    <label className="switch compact">
                      <input
                        type="checkbox"
                        checked={autoPick}
                        onChange={async (e) => {
                          const v = e.target.checked;
                          setAutoPick(v);
                          await window.veyra?.setSettings({ autoPick: v });
                          // 刚打开「选用最低」时立刻测一次并切过去，避免用户以为没生效
                          if (v) void runSpeedTest({ silent: false, pickBest: true });
                        }}
                      />
                      选用最低
                    </label>
                    <button
                      type="button"
                      className="btn primary"
                      onClick={testAll}
                      disabled={!running || testing || !nodes.length}
                    >
                      <Zap size={15} />
                      {testing ? `${testProgress}%` : "一键测速"}
                    </button>
                  </div>
                </div>

                {testing && (
                  <div className="progress-line">
                    <i style={{ width: `${testProgress}%` }} />
                  </div>
                )}
              </div>

              {!sortedNodes.length ? (
                <div className="empty">没有可显示的节点</div>
              ) : (
                <div className="px-grid">
                  {sortedNodes.slice(0, pxNodeLimit).map((n) => {
                    const d = delays[n];
                    const cls = delayClass(d);
                    const active = currentGroup?.now === n;
                    const isBest = bestNode?.name === n;
                    const info = proxyMap[n];
                    const ptype = info?.type || (GROUP_TYPES.has(info?.type || "") ? info?.type : "") || "";
                    const isGroup = GROUP_TYPES.has(info?.type || "");
                    return (
                      <button
                        key={n}
                        type="button"
                        className={[
                          "px-card",
                          active ? "active" : "",
                          isBest ? "best" : "",
                          testingNode === n ? "testing" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => selectNode(n)}
                        title={testingNode === n ? "正在测速…" : `切换到 ${n}`}
                      >
                        <span className={`px-dot ${active ? "on" : ""}`} />
                        <span className="px-card-main">
                          <span className="px-card-name" title={n}>{n}</span>
                          <span className="px-card-meta">
                            {ptype ? <em>{ptype}</em> : null}
                            {info?.udp ? <i>UDP</i> : null}
                            {info?.xudp ? <i>XUDP</i> : null}
                            {isGroup ? <i>组</i> : null}
                            {isSystemOutbound(n) ? <i>系统</i> : null}
                          </span>
                        </span>
                        <span
                          className={`px-card-delay ${cls}`}
                          title={(() => {
                            const h = delayHistory[n];
                            if (!h?.length) return "暂无历史延迟数据";
                            return h
                              .slice(-5)
                              .reverse()
                              .map((r) => `${new Date(r.t).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}: ${r.ms}ms`)
                              .join("\n");
                          })()}
                        >
                          {testingNode === n ? "…" : delayText(d)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === "profiles" && (
            <div className="pane pf" hidden={tab !== "profiles"} data-pf={pfTab}>
              <section className="import-hero">
                <h3><Link2 size={17} /> 订阅与增强</h3>
                <p>Remote/Local · Merge/Script/Rules/Proxies/Groups · 订阅绑定 · 远程配置 · 运行时配置</p>
                <div className="seg pf-seg" style={{ marginTop: 12 }}>
                  <button type="button" className={pfTab === "sub" ? "active" : ""} onClick={() => setPfTab("sub")}>订阅</button>
                  <button type="button" className={pfTab === "enhance" ? "active" : ""} onClick={() => setPfTab("enhance")}>增强</button>
                  <button type="button" className={pfTab === "nodes" ? "active" : ""} onClick={() => setPfTab("nodes")}>节点</button>
                  <button type="button" className={pfTab === "yaml" ? "active" : ""} onClick={() => setPfTab("yaml")}>YAML</button>
                </div>
                <div className="import-bar pf-sub">
                  <Link2 size={16} />
                  <input
                    value={subUrl}
                    onChange={(e) => setSubUrl(e.target.value)}
                    placeholder="https://… 粘贴 Clash/Meta 订阅链接"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") importFromUrl();
                    }}
                  />
                  <button type="button" className="btn primary" onClick={() => importFromUrl()} disabled={busy}>
                    {busy ? "导入中…" : "导入"}
                  </button>
                </div>
                <div className="import-bar pf-sub" style={{ marginTop: 8 }}>
                  <Server size={16} />
                  <input
                    value={nodeUri}
                    onChange={(e) => setNodeUri(e.target.value)}
                    placeholder="ss:// / vmess:// / vless:// / trojan:// 单节点 URI"
                  />
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    onClick={async () => {
                      if (!nodeUri.trim()) return showToast("请粘贴节点 URI");
                      setBusy(true);
                      try {
                        await window.veyra?.importNodeUri?.(nodeUri.trim());
                        await reloadProfileLists();
                        showToast("已导入节点 URI");
                        setNodeUri("");
                      } catch (e) {
                        showToast(String((e as Error).message || e));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    导入 URI
                  </button>
                </div>
                <div className="s-actions wrap" style={{ marginTop: 12, gap: 8 }}>
                  {(["merge", "script", "rules", "proxies", "groups"] as EnhanceKind[]).map((k) => (
                    <button key={k} type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => createEnhance(k, false)}>
                      + {k}
                    </button>
                  ))}
                  <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => createEnhance("merge", true)}>
                    + 全局 Merge
                  </button>
                  <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => createEnhance("script", true)}>
                    + 全局 Script
                  </button>
                  <button type="button" className="btn primary btn-sm" disabled={busy || !hasSubscription} onClick={() => applyEnhance()}>
                    重新增强并应用
                  </button>
                  <button
                    type="button"
                    className="btn ghost btn-sm"
                    onClick={async () => {
                      setEditorMode("runtime");
                      setEditUid(null);
                      setProfileName("runtime.yaml");
                      setProfileText((await window.veyra?.readRuntime?.()) || "");
                      setPfTab("yaml");
                    }}
                  >
                    查看运行时配置
                  </button>
                  <button type="button" className="btn ghost btn-sm" onClick={() => reloadProviders()}>
                    刷新远程配置
                  </button>
                </div>
              </section>

              <div className="pf-grid pf-sub">
                <section className="pf-card">
                  <div className="pf-card-hd">
                    <h2><Layers3 size={15} /> 配置列表</h2>
                    <span className="hd-count">{richProfiles.length || profiles.length}</span>
                  </div>
                  {!(richProfiles.length || profiles.length) ? (
                    <div className="empty slim">尚无配置 — 导入订阅或创建 Merge/Script</div>
                  ) : (
                    <div className="pf-list">
                      {(richProfiles.length
                        ? richProfiles.map((p) => ({
                            key: p.uid,
                            uid: p.uid,
                            name: p.name,
                            sub: `${p.type}${p.global ? " · 全局" : ""}${p.url ? ` · ${p.url}` : ""}`,
                            size: p.size,
                            enabled: p.enabled,
                            type: p.type,
                          }))
                        : profiles.map((p) => ({
                            key: p.uid || p.name,
                            uid: p.uid,
                            name: p.name,
                            sub: p.type || "file",
                            size: p.size,
                            enabled: p.enabled !== false,
                            type: (p.type as ProfileRich["type"]) || "local",
                          }))
                      ).map((p) => (
                        <div key={p.key} className="pf-item">
                          <span className="pf-item-ico"><Layers3 size={15} /></span>
                          <div className="pf-item-body">
                            <div className="pf-item-name">{p.name}</div>
                            <div className="pf-item-sub">{p.sub}</div>
                          </div>
                          <div className="pf-item-side" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            {p.uid && (p.type === "remote" || p.type === "local") ? (
                              <>
                                <button
                                  type="button"
                                  className="btn ghost btn-sm"
                                  onClick={async () => {
                                    await window.veyra?.activateProfile?.(p.uid!);
                                    await applyEnhance();
                                    showToast(`已激活 ${p.name}`);
                                  }}
                                >
                                  激活
                                </button>
                                <button
                                  type="button"
                                  className="btn ghost btn-sm"
                                  onClick={() => setBindTarget(bindTarget === p.uid ? null : p.uid!)}
                                >
                                  绑定
                                </button>
                              </>
                            ) : null}
                            {p.uid &&
                            (p.type === "merge" ||
                              p.type === "script" ||
                              p.type === "rules" ||
                              p.type === "proxies" ||
                              p.type === "groups") ? (
                              <label className="switch compact" title="启用增强">
                                <input
                                  type="checkbox"
                                  checked={!!p.enabled}
                                  onChange={async (e) => {
                                    await window.veyra?.setProfileEnabled?.(p.uid!, e.target.checked);
                                    await reloadProfileLists();
                                  }}
                                />
                              </label>
                            ) : null}
                            {p.uid ? (
                              <button
                                type="button"
                                className="btn ghost btn-sm"
                                onClick={async () => {
                                  const text = await window.veyra?.readProfile?.(p.uid!);
                                  if (text != null) {
                                    setEditUid(p.uid!);
                                    setProfileName(p.name);
                                    setProfileText(text);
                                    setEditorMode("profile");
                                  }
                                }}
                              >
                                编辑
                              </button>
                            ) : null}
                            <span className="pf-item-date">{formatBytes(p.size)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="pf-card">
                  <div className="pf-card-hd">
                    <h2><Globe size={15} /> 订阅链接</h2>
                    <span className="hd-count">{subs.length}</span>
                  </div>
                  {!subs.length ? (
                    <div className="empty slim">导入过的链接会出现在这里，点击可重新拉取</div>
                  ) : (
                    <div className="pf-list">
                      {subs.map((s) => (
                        <div key={s.url} className="pf-item">
                          <button
                            type="button"
                            className="pf-item"
                            style={{ flex: 1, border: 0, background: "transparent", padding: 0 }}
                            onClick={() => {
                              setSubUrl(s.url);
                              importFromUrl(s.url);
                            }}
                            title={s.url}
                          >
                            <span className="pf-item-ico"><Link2 size={15} /></span>
                            <div className="pf-item-body">
                              <div className="pf-item-name">{s.name}</div>
                              <div className="pf-item-sub">
                                {s.url}
                                {s.nextUpdateAt
                                  ? ` · 下次 ${new Date(s.nextUpdateAt).toLocaleString()}`
                                  : ""}
                              </div>
                            </div>
                          </button>
                          <button
                            type="button"
                            className="btn ghost btn-sm"
                            title="推迟 1 小时更新"
                            onClick={async () => {
                              const next = Date.now() + 3600000;
                              await window.veyra?.setNextUpdate?.(s.url, next);
                              await reloadProfileLists();
                              showToast("下次更新已改为 1 小时后");
                            }}
                          >
                            改期
                          </button>
                          <span className="pf-item-date">
                            {s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : "—"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              {bindTarget ? (
                <section className="block pf-enhance" style={{ marginTop: 12 }}>
                  <div className="block-hd">
                    <h2>订阅绑定扩展</h2>
                    <span className="pill dim">{bindTarget.slice(0, 8)}</span>
                  </div>
                  <p className="s-muted">为该 Remote/Local 指定专用 Merge / Script / Rules / Proxies / Groups</p>
                  <div className="s-fields">
                    {(["merge", "script", "rules", "proxies", "groups"] as const).map((k) => (
                      <label key={k}>
                        {k}
                        <select
                          className="s-input"
                          defaultValue={richProfiles.find((x) => x.uid === bindTarget)?.binds?.[k] || ""}
                          onChange={async (e) => {
                            const cur = richProfiles.find((x) => x.uid === bindTarget);
                            const binds = { ...(cur?.binds || {}), [k]: e.target.value || null };
                            await window.veyra?.setProfileBinds?.(bindTarget, binds);
                            await reloadProfileLists();
                            showToast(`已绑定 ${k}`);
                          }}
                        >
                          <option value="">（无）</option>
                          {richProfiles
                            .filter((x) => x.type === k || (k === "merge" && x.type === "merge"))
                            .map((x) => (
                              <option key={x.uid} value={x.uid}>
                                {x.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </section>
              ) : null}

              {(providers.proxies.length || providers.rules.length) ? (
                <section className="block pf-enhance" style={{ marginTop: 12 }}>
                  <div className="block-hd"><h2>远程配置</h2></div>
                  <div className="pf-list">
                    {providers.proxies.map((n) => (
                      <div key={`pp-${n}`} className="pf-item">
                        <div className="pf-item-body">
                          <div className="pf-item-name">{n}</div>
                          <div className="pf-item-sub">proxy-provider</div>
                        </div>
                        <button
                          type="button"
                          className="btn ghost btn-sm"
                          onClick={async () => {
                            await window.veyra?.updateProvider?.("proxies", n);
                            showToast(`已更新 ${n}`);
                          }}
                        >
                          更新
                        </button>
                      </div>
                    ))}
                    {providers.rules.map((n) => (
                      <div key={`rp-${n}`} className="pf-item">
                        <div className="pf-item-body">
                          <div className="pf-item-name">{n}</div>
                          <div className="pf-item-sub">rule-provider</div>
                        </div>
                        <button
                          type="button"
                          className="btn ghost btn-sm"
                          onClick={async () => {
                            await window.veyra?.updateProvider?.("rules", n);
                            showToast(`已更新 ${n}`);
                          }}
                        >
                          更新
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {enhanceLog.length ? (
                <section className="block pf-enhance" style={{ marginTop: 12 }}>
                  <div className="block-hd"><h2>增强日志</h2></div>
                  <pre className="term-body" style={{ maxHeight: 120 }}>{enhanceLog.join("\n")}</pre>
                </section>
              ) : null}

              {pfSeen.nodes ? (
                <>
                  <section className="block pf-nodes" style={{ marginTop: 12 }}>
                    <ProxiesVisualEditor onToast={showToast} onBusy={setBusy} />
                  </section>
                  <section className="block pf-nodes" style={{ marginTop: 12 }}>
                    <GroupsVisualEditor onToast={showToast} onBusy={setBusy} />
                  </section>
                </>
              ) : null}

              {pfSeen.yaml ? (
              <section className="editor-card pf-yaml">
                <div className="editor-bar">
                  <input
                    value={profileName}
                    onChange={(e) => setProfileName(e.target.value)}
                    placeholder={editorMode === "runtime" ? "runtime.yaml" : editUid ? "正在编辑已有配置" : "文件名"}
                  />
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    onClick={async () => {
                      if (editorMode === "runtime") {
                        setBusy(true);
                        try {
                          await window.veyra?.writeRuntime?.(profileText);
                          showToast("运行时配置已写入并重载");
                          await refresh();
                        } catch (e) {
                          showToast(String((e as Error).message || e));
                        } finally {
                          setBusy(false);
                        }
                      } else {
                        await saveProfile();
                      }
                    }}
                  >
                    {editorMode === "runtime" ? "保存运行时" : editUid ? "保存并增强" : "保存 YAML"}
                  </button>
                </div>
                <Suspense
                  fallback={
                    <div className="yaml-editor monaco">
                      <div style={{ height: 320, display: "grid", placeItems: "center", color: "var(--text-400)", fontSize: 12 }}>
                        编辑器加载中…
                      </div>
                    </div>
                  }
                >
                  <YamlEditor
                    value={profileText}
                    onChange={setProfileText}
                    placeholder="粘贴 YAML / Merge / Script…"
                    hint={editorMode === "runtime" ? "运行时配置（增强产物，可直接改）· schema: Clash Meta" : "YAML 编辑器 · 支持 Merge delete-rules 等"}
                  />
                </Suspense>
              </section>
              ) : null}
            </div>
          )}

          {tab === "rules" && (
            <div className="pane" hidden={tab !== "rules"}>
              <RulesPage onToast={showToast} onBusy={setBusy} />
            </div>
          )}

          {tab === "connections" && (
            <div className="pane" hidden={tab !== "connections"}>
              <ConnectionsPage onToast={showToast} />
            </div>
          )}

          {tab === "logs" && (
            <div className="pane term" hidden={tab !== "logs"}>
              <div className="term-bar">
                <div className="term-title">
                  <span className="term-dots"><i /><i /><i /></span>
                  <h1>内核日志</h1>
                  <span className="pill dim">{logs.length} 行</span>
                </div>
                <div className="s-actions">
                  <button
                    type="button"
                    className="btn ghost btn-sm"
                    onClick={async () => {
                      const r = await window.veyra?.clearLogFiles?.();
                      showToast(`已清理文件 ${r?.removed || 0} 个`);
                    }}
                  >
                    清理日志文件
                  </button>
                  <button type="button" className="btn ghost btn-sm" onClick={() => setLogs([])}>
                    清空屏幕
                  </button>
                </div>
              </div>
              <pre className="term-body">{logs.join("") || "等待代理服务输出…\n启动内核后，这里会实时显示 mihomo 日志。"}</pre>
            </div>
          )}

          {tab === "tests" && (
            <div className="pane" hidden={tab !== "tests"}>
              <TestsPage running={running} onToast={showToast} />
            </div>
          )}

          {tab === "settings" && (
            <div className="pane" hidden={tab !== "settings"}>
              <SettingsPanel
                running={running}
                mixedPort={mixedPort}
                controller={controller}
                version={version}
                autoTest={autoTest}
                autoPick={autoPick}
                themeMode={themeMode}
                onThemeChange={changeTheme}
                onToast={showToast}
                onBusy={setBusy}
                onPorts={handlePorts}
                onPrefs={handlePrefs}
                onRefresh={refresh}
                onCoreChange={setActiveCore}
              />
            </div>
          )}
        </main>
          </div>

          {/* Right Sidebar */}
          <div className="col-right">
            <div className="grid-stack">
              <div className="card">
                <LiveClock />
                <div className="card-body tight">
                  <div className="grid-2" style={{gap:12}}>
                    <div style={{background:'transparent',border:'1px solid rgba(51,65,85,0.50)',borderRadius:'var(--radius-md)',padding:12}}>
                      <div className="text-xs text-muted mb-1">运行时间</div>
                      <LiveUptime since={appStartTime.current} />
                    </div>
                    <div style={{background:'transparent',border:'1px solid rgba(51,65,85,0.50)',borderRadius:'var(--radius-md)',padding:12}}>
                      <div className="text-xs text-muted mb-1">内核</div>
                      <div className="text-sm font-mono">{activeCore === "singbox" ? "sing-box" : "mihomo"}</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-header no-border">
                  <div className="card-title text-base">快捷操作</div>
                </div>
                <div className="card-body tight">
                  <div className="action-grid">
                    <button type="button" className="action-btn" onClick={() => goTab("tests")}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                      <span>测速</span>
                    </button>
                    <button type="button" className="action-btn" onClick={() => goTab("profiles")}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      <span>导入订阅</span>
                    </button>
                    <button type="button" className="action-btn" onClick={() => goTab("connections")}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                      <span>连接</span>
                    </button>
                    <button type="button" className="action-btn" onClick={() => goTab("settings")}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                      <span>设置</span>
                    </button>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-header no-border">
                  <div className="card-title text-base">流量</div>
                </div>
                <div className="card-body tight">
                  <div className="status-item">
                    <div className="status-item-hd"><span>下载</span><span className="text-cyan">{formatRate(downRate)}</span></div>
                    <div className="status-bar"><i className="cyan" style={{width:`${Math.min(100,(downRate/1000000)*100)}%`}}/></div>
                  </div>
                  <div className="status-item">
                    <div className="status-item-hd"><span>上传</span><span className="text-purple">{formatRate(upRate)}</span></div>
                    <div className="status-bar"><i className="purple" style={{width:`${Math.min(100,(upRate/1000000)*100)}%`}}/></div>
                  </div>
                  <div className="status-item">
                    <div className="status-item-hd"><span>总下行</span><span>{formatBytes(upload)}</span></div>
                  </div>
                  <div className="status-item">
                    <div className="status-item-hd"><span>总上行</span><span>{formatBytes(download)}</span></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {homeCfgOpen && (
        <div className="modal-mask" onClick={() => setHomeCfgOpen(false)}>
          <div className="modal-box home-cfg" onClick={(e) => e.stopPropagation()}>
            <div className="home-cfg-hd">
              <div>
                <div className="home-cfg-title">首页设置</div>
                <div className="home-cfg-sub">选择要在首页显示的卡片</div>
              </div>
              <button type="button" className="home-cfg-close" onClick={() => setHomeCfgOpen(false)} aria-label="关闭">
                <X size={16} />
              </button>
            </div>
            <div className="home-cfg-list">
              {[
                ["subscription", "订阅卡", "管理订阅链接"],
                ["node", "当前节点卡", "显示当前使用的节点"],
                ["network", "网络设置卡", "系统代理与端口"],
                ["mode", "代理模式卡", "规则/全局/直连切换"],
                ["traffic", "流量统计卡", "实时上下行速率"],
                ["webtest", "网站测试卡", "一键测网站连通性"],
                ["ip", "IP 信息卡", "检测出口 IP 归属地"],
                ["core", "内核信息卡", "内核版本与运行状态"],
                ["system", "系统信息卡", "操作系统与运行模式"],
              ].map(([key, label, desc]) => {
                const on = !!(homeCfgDraft as any)[key];
                return (
                  <button
                    key={key}
                    type="button"
                    className={`home-cfg-item${on ? " on" : ""}`}
                    onClick={() => setHomeCfgDraft({ ...homeCfgDraft, [key]: !on })}
                  >
                    <span className="home-cfg-check">{on && <Check size={13} />}</span>
                    <span className="home-cfg-text">
                      <span className="home-cfg-label">{label}</span>
                      <span className="home-cfg-desc">{desc}</span>
                    </span>
                    <span className={`mini-switch${on ? " on" : ""}`} />
                  </button>
                );
              })}
            </div>
            <div className="home-cfg-ft">
              <button type="button" className="btn ghost" onClick={() => setHomeCfgOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={async () => {
                  const next = { ...homeCfgDraft };
                  setHomeCards(next);
                  await window.veyra?.setSettings({ homeCards: next });
                  setHomeCfgOpen(false);
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 实时时钟：独立组件每秒 tick，避免整棵应用树跟着时间刷新重渲染 */
function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="time-display">
      <div className="time-label">系统时间</div>
      <div className="time-value">{now.toLocaleTimeString("en-US", { hour12: false })}</div>
      <div className="time-date">{now.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}</div>
    </div>
  );
}

/** 运行时长实时显示：同样每秒刷新，避免只在其它 state 变化时才更新 */
function LiveUptime({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="text-sm font-mono">{formatUptime(Math.max(0, now - since))}</div>;
}
