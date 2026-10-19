/// <reference types="vite/client" />

export interface ProfileRich {
  uid: string;
  name: string;
  type: "remote" | "local" | "merge" | "script" | "rules" | "proxies" | "groups";
  url?: string | null;
  enabled: boolean;
  global: boolean;
  updatedAt: number;
  file: string;
  size: number;
  /** 是否为当前激活的配置（由主进程 listRich 补充） */
  active?: boolean;
  binds?: {
    merge?: string | null;
    script?: string | null;
    rules?: string | null;
    proxies?: string | null;
    groups?: string | null;
  };
}

export interface HomeCards {
  subscription: boolean;
  node: boolean;
  network: boolean;
  mode: boolean;
  traffic: boolean;
  core: boolean;
  system: boolean;
}

export interface AppSettings {
  mixedPort: number;
  controllerPort: number;
  secret: string;
  allowLan: boolean;
  logLevel: string;
  autoTest: boolean;
  autoPick: boolean;
  autoTestIntervalSec: number;
  subAutoUpdateMin: number;
  closeToTray: boolean;
  startWithWindows: boolean;
  startMinimized: boolean;
  proxyBypass: string;
  theme: string;
  core: string;
  proxyMode?: string;
  proxyGuard?: boolean;
  disconnectOnProxyOff?: boolean;
  blockConflict?: boolean;
  registerIdentity?: boolean;
  bindAddress?: string;
  tunEnable?: boolean;
  tunStack?: string;
  tunAutoRoute?: boolean;
  tunStrictRoute?: boolean;
  tunAutoDetect?: boolean;
  tunSniff?: boolean;
  tunMtu?: number;
  tunDevice?: string;
  tunDnsHijack?: string[];
  serviceMode?: boolean;
  dnsOverride?: boolean;
  dnsEnable?: boolean;
  dnsListen?: string;
  dnsIpv6?: boolean;
  dnsMode?: string;
  dnsFakeIpRange?: string;
  dnsFakeIpFilter?: string[];
  dnsNameserver?: string[];
  dnsFallback?: string[];
  dnsDefaultNs?: string[];
  dnsHosts?: Record<string, string>;
  hotkeyToggleProxy?: string;
  hotkeyToggleWindow?: string;
  hotkeyModeRule?: string;
  hotkeyModeGlobal?: string;
  hotkeyModeDirect?: string;
  lightweightMode?: boolean;
  locale?: string;
  themeColor?: string;
  customCss?: string;
  webdavUrl?: string;
  webdavUser?: string;
  webdavPass?: string;
  webdavRemote?: string;
  logMaxLines?: number;
  logAutoCleanDays?: number;
  mihomoChannel?: string;
  webuiPrefer?: string;
  unifiedDelay?: boolean;
  tcpConcurrent?: boolean;
  subRetry?: number;
  subTimeoutSec?: number;
  subUpdateViaProxy?: boolean;
  windowBounds?: { x?: number; y?: number; width?: number; height?: number } | null;
  portableMode?: boolean;
  nodeSort?: string;
  trayGroupIcons?: boolean;
  homeCards?: HomeCards;
  /** 应用更新源（GitHub Releases latest 接口）；留空则「检查更新」提示未配置 */
  updateUrl?: string;
}

export interface ProxyNode {
  type?: string;
  name?: string;
  now?: string;
  all?: string[];
  history?: { delay?: number }[];
  udp?: boolean;
  xudp?: boolean;
}

export interface ClashConfig {
  mode?: string;
  "mixed-port"?: number;
  port?: number;
  "socks-port"?: number;
}

export interface ConnectionItem {
  id: string;
  upload?: number;
  download?: number;
  start?: string;
  chains?: string[];
  rule?: string;
  rulePayload?: string;
  metadata?: {
    host?: string;
    destinationIP?: string;
    destinationPort?: string | number;
    process?: string;
    network?: string;
    type?: string;
  };
}

export interface VeyraAPI {
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  /** 无边框窗口拖动（渲染层发屏幕坐标，主进程移动窗口） */
  windowDragStart?: (x: number, y: number) => void;
  windowDragMove?: (x: number, y: number) => void;
  windowDragEnd?: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
  close: () => Promise<void>;
  startCore: () => Promise<unknown>;
  stopCore: () => Promise<unknown>;
  restartCore: () => Promise<unknown>;
  coreStatus: () => Promise<{ running: boolean; version?: unknown; pid?: number | null }>;
  coreInfo: () => Promise<{
    path: string;
    exists: boolean;
    size: number;
    mtime: number | null;
    fileVersion: string | null;
    build: string;
    buildAsset: string;
    cpu: string;
    cpuCount: number;
    arch: string;
    pid: number | null;
    running: boolean;
    mixedPort: number;
    controller: string;
    secret: string;
    core: string;
    apiVersion?: { version?: string } | null;
  }>;
  checkCoreUpdate: () => Promise<{ latest: string; name?: string; url?: string }>;
  checkAppUpdate: () => Promise<{
    current: string;
    latest: string;
    name?: string;
    htmlUrl?: string;
    prerelease?: boolean;
    hasUpdate: boolean;
    assetName?: string;
    assetUrl?: string;
    assetSize?: number;
    /** "sha256:..."：下载完成后用于完整性校验 */
    assetDigest?: string;
  }>;
  downloadAppUpdate: () => Promise<{
    current: string;
    latest: string;
    hasUpdate: boolean;
    started: boolean;
    /** 下载完成、等待用户选择「覆盖安装 / 卸载后重装」 */
    downloaded?: boolean;
    /** 用户主动取消：不是失败，界面据此显示「已取消」 */
    cancelled?: boolean;
    path?: string;
    assetName?: string;
    sha256?: string;
  }>;
  /** 安装已下载的更新：overwrite 覆盖安装，clean 卸载后重装 */
  installAppUpdate: (mode: "overwrite" | "clean") => Promise<{ ok: boolean; mode?: string }>;
  /** 启动后自动检查到新版本时由主进程推送 */
  onUpdateAvailable: (
    cb: (data: {
      current: string;
      latest: string;
      name?: string;
      htmlUrl?: string;
      prerelease?: boolean;
      hasUpdate: boolean;
      assetName?: string;
      assetUrl?: string;
      assetSize?: number;
    }) => void
  ) => () => void;
  /** 安装包下载进度 */
  onUpdateProgress: (cb: (data: {
    pct: number;
    received: number;
    total: number;
    /** proxy | direct | fallback | done */
    phase?: string;
  }) => void) => () => void;
  cancelAppUpdate: () => Promise<{ ok: boolean }>;
  updateCore: () => Promise<unknown>;
  matchCoreBuild: () => Promise<unknown>;
  switchCore: (core: string) => Promise<unknown>;
  coreList: () => Promise<{
    active: string;
    mihomo: { installed: boolean; version: string };
    singbox: { installed: boolean; version: string };
  }>;
  onCoreStatus: (cb: (data: unknown) => void) => () => void;
  onCoreLog: (cb: (line: string) => void) => () => void;
  onCoreError: (cb: (msg: string) => void) => () => void;
  onCoreProgress: (cb: (data: { phase: string; pct: number; label: string }) => void) => () => void;
  onSystemProxyChanged: (cb: (data: { enabled?: boolean }) => void) => () => void;
  overview: () => Promise<{
    proxies: { proxies?: Record<string, ProxyNode> };
    configs: ClashConfig;
    connections: {
      downloadTotal?: number;
      uploadTotal?: number;
      connections?: ConnectionItem[];
    };
    connectionsCount?: number;
    mixedPort: number;
    controller: string;
    preferredPort?: number;
    coreMemoryMB?: number;
  }>;
  ports: () => Promise<{ mixedPort: number; controller: string; preferredPort: number }>;
  selectProxy: (group: string, name: string) => Promise<unknown>;
  testDelay: (name: string) => Promise<{ status: number; data: { delay?: number } }>;
  setMode: (mode: string) => Promise<unknown>;
  setSystemProxy: (enable: boolean) => Promise<{
    ok: boolean;
    enabled?: boolean;
    server?: string;
    bypass?: string;
  }>;
  systemProxyStatus: () => Promise<{ enabled: boolean; server?: string; rawEnabled?: boolean }>;
  patchConfig: (body: Record<string, unknown>) => Promise<unknown>;
  closeAllConnections: () => Promise<unknown>;
  listConnections?: () => Promise<{
    connections?: ConnectionItem[];
    downloadTotal?: number;
    uploadTotal?: number;
  }>;
  closeConnection?: (id: string) => Promise<unknown>;
  listRules?: () => Promise<{ rules?: { payload: string; type?: string }[] }>;
  saveVisualRules?: (rules: string[]) => Promise<{ ok: boolean; warnings?: string[] }>;
  listProviders?: () => Promise<{ proxies: Record<string, unknown>; rules: Record<string, unknown> }>;
  updateProvider?: (kind: "proxies" | "rules", name: string) => Promise<unknown>;
  listProfiles: () => Promise<
    {
      name: string;
      path: string;
      size: number;
      uid?: string;
      type?: string;
      enabled?: boolean;
      global?: boolean;
      url?: string;
      updatedAt?: number;
    }[]
  >;
  listProfilesRich?: () => Promise<ProfileRich[]>;
  importProfile: (payload: {
    name: string;
    content: string;
  }) => Promise<{ ok: boolean; path: string; mixedPort?: number; controller?: string; warnings?: string[] }>;
  importProfileUrl: (payload: {
    url: string;
    name?: string;
  }) => Promise<{
    ok: boolean;
    path: string;
    /** 订阅的可读名（机场响应头 / 自定义名） */
    name?: string;
    mixedPort?: number;
    controller?: string;
    bytes?: number;
    warnings?: string[];
  }>;
  listSubscriptions: () => Promise<
    {
      url: string;
      name: string;
      updatedAt: number;
      nextUpdateAt?: number;
      userinfo?: { upload: number; download: number; total: number; expire: number };
    }[]
  >;
  /** 存量订阅补流量信息（早期版本没存 userinfo），返回补全后的列表 */
  refreshMissingSubInfo?: () => Promise<
    {
      url: string;
      name: string;
      updatedAt: number;
      nextUpdateAt?: number;
      userinfo?: { upload: number; download: number; total: number; expire: number };
    }[]
  >;
  readActiveProfile: () => Promise<string>;
  /** 删除订阅：连它的配置文件一起删 */
  removeSubscription?: (url: string) => Promise<{ ok: boolean; removedProfile: boolean; wasActive: boolean }>;
  activateProfile?: (uid: string) => Promise<{ ok: boolean; warnings?: string[] }>;
  setProfileEnabled?: (uid: string, enabled: boolean) => Promise<unknown>;
  createEnhanceProfile?: (
    kind: "merge" | "script" | "rules" | "proxies" | "groups",
    name: string,
    global?: boolean
  ) => Promise<ProfileRich>;
  deleteProfile?: (uid: string) => Promise<unknown>;
  readProfile?: (uid: string) => Promise<string>;
  writeProfile?: (uid: string, content: string) => Promise<unknown>;
  setProfileBinds?: (uid: string, binds: ProfileRich["binds"]) => Promise<ProfileRich>;
  enhancePreview?: () => Promise<{ yaml: string; warnings: string[]; scriptLogs: string[] }>;
  enhanceApply?: () => Promise<{ ok: boolean; warnings: string[]; scriptLogs: string[] }>;
  readRuntime?: () => Promise<string>;
  writeRuntime?: (content: string) => Promise<{ ok: boolean }>;
  setProxyMode?: (mode: string) => Promise<unknown>;
  validateDns?: (ns: string) => Promise<{ ok: boolean; host?: string; error?: string }>;
  serviceStatus?: () => Promise<{ installed: boolean }>;
  serviceInstall?: () => Promise<unknown>;
  serviceUninstall?: () => Promise<{ ok: boolean; error?: string }>;
  enableUwpLoopback?: () => Promise<unknown>;
  backupExport?: () => Promise<{ ok: boolean; path: string; bytes?: number }>;
  backupImport?: () => Promise<{ ok: boolean; canceled?: boolean }>;
  backupReveal?: () => Promise<unknown>;
  webdavUpload?: () => Promise<unknown>;
  webdavDownload?: () => Promise<unknown>;
  exitIp?: () => Promise<{
    ip: string | null;
    viaProxy?: boolean;
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
  }>;
  detectProxyConflict?: () => Promise<string[]>;
  fullConflictScan?: () => Promise<{ conflicts: Array<{ type: string; label: string; severity?: string; port?: number; proc?: string; family?: string }>; summary: string; severity?: string; counts?: { critical: number; high: number; medium: number } }>;
  /** 端口可用性自检：直接尝试绑定本机配置的端口 */
  checkPorts?: () => Promise<{ mixedPort: number; controllerPort: number; mixedFree: boolean; ctrlFree: boolean }>;
  startConflictMonitor?: (on: boolean) => Promise<{ ok: boolean }>;
  getSelfIdentity?: () => Promise<{ app: string; version: string; pid: number; mixedPort: number | null; controllerPort: string | null; coreMode: string; startedAt: string; session: string } | null>;
  onConflictDetected?: (cb: (data: { items: string[]; severity: "critical" | "high" | "medium"; at: string }) => void) => () => void;
  onConflictResolved?: (cb: (data: { at: string; autoRecover?: boolean }) => void) => () => void;
  onConflictBlockStartup?: (cb: (data: { conflicts: string[]; severity: string; rawConflicts: Array<{ type: string; proc?: string; label: string; pids?: number[]; port?: number }>; at: string }) => void) => () => void;
  resolveExternalProxy?: () => Promise<{ ok: boolean; killed: number[]; failed: number[]; conflicts?: string[] }>;
  killProxyProcesses?: (pids: number[]) => Promise<{ killed: number[]; failed: number[] }>;
  retryStartAfterConflict?: () => Promise<{ ok: boolean; conflicts?: string[]; severity?: string; error?: string }>;
  onNotice?: (cb: (data: { message: string; at: string }) => void) => () => void;
  streamingUnlock?: () => Promise<
    { id: string; title?: string; ok: boolean; fail?: boolean; region?: string | null; status: number; note: string; testedAt?: number }[]
  >;
  streamingUnlockOne?: (id: string) => Promise<{
    id: string;
    title?: string;
    ok: boolean;
    fail?: boolean;
    region?: string | null;
    status: number;
    note: string;
    testedAt?: number;
  }>;
  unlockCatalog?: () => Promise<{ id: string; title: string }[]>;
  proxyEnvText?: () => Promise<{ text: string }>;
  importNodeUri?: (uri: string) => Promise<unknown>;
  openWebUI?: (which: string) => Promise<unknown>;
  clearLogFiles?: () => Promise<{ ok: boolean; removed: number }>;
  setNextUpdate?: (url: string, nextUpdateAt: number) => Promise<{ ok: boolean }>;
  vcRuntime?: () => Promise<{ ok: boolean; installed: boolean; downloadUrl?: string }>;
  downloadVc?: () => Promise<unknown>;
  onLightweight?: (cb: (data: { on?: boolean }) => void) => () => void;
  traffic: () => Promise<{
    downloadTotal?: number;
    uploadTotal?: number;
    connections?: ConnectionItem[];
  } | null>;
  openExternal: (url: string) => Promise<void>;
  getSettings: () => Promise<AppSettings>;
  setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  applyNetwork: (patch: Partial<AppSettings>) => Promise<{
    settings: AppSettings;
    mixedPort: number;
    controller: string;
    /** 端口被占用等情况下的提示；渲染层据此提示用户实际生效的值 */
    warnings?: string[];
  }>;
  openPath: (which: string) => Promise<unknown>;
  copyText: (text: string) => Promise<unknown>;
  appInfo: () => Promise<{
    name: string;
    version: string;
    electron: string;
    platform: string;
    arch: string;
    isDev: boolean;
    osRelease?: string;
    osVersion?: string;
    totalMem?: number;
    cpu?: string;
  }>;
  /** 更新日志（随包发布的 changelog.json） */
  changelog?: () => Promise<ChangelogEntry[]>;
  /** 当前版本是否首次运行：返回 isNew + 对应版本的更新内容 */
  updateNotes?: () => Promise<{
    current: string;
    seen: string;
    isNew: boolean;
    entry: ChangelogEntry | null;
  }>;
  /** 标记当前版本已读，避免下次启动再弹 */
  markVersionSeen?: () => Promise<{ ok: boolean }>;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  channel?: "beta" | "stable" | string;
  title?: string;
  items: string[];
}

declare global {
  interface Window {
    veyra?: VeyraAPI;
  }
}

export {};
