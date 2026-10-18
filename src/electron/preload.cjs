const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("veyra", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  onMaximizedChange: (cb) => {
    const fn = (_e, v) => cb(!!v);
    ipcRenderer.on("window:maximized", fn);
    return () => ipcRenderer.removeListener("window:maximized", fn);
  },
  close: () => ipcRenderer.invoke("window:close"),
  changelog: () => ipcRenderer.invoke("app:changelog"),
  updateNotes: () => ipcRenderer.invoke("app:updateNotes"),
  markVersionSeen: () => ipcRenderer.invoke("app:markVersionSeen"),
  // 无边框窗口拖动：渲染层把鼠标的屏幕坐标发过来，主进程换算成窗口位置
  windowDragStart: (x, y) => ipcRenderer.send("window:drag-start", x, y),
  windowDragMove: (x, y) => ipcRenderer.send("window:drag-move", x, y),
  windowDragEnd: () => ipcRenderer.send("window:drag-end"),

  startCore: () => ipcRenderer.invoke("core:start"),
  stopCore: () => ipcRenderer.invoke("core:stop"),
  restartCore: () => ipcRenderer.invoke("core:restart"),
  coreStatus: () => ipcRenderer.invoke("core:status"),
  coreInfo: () => ipcRenderer.invoke("core:info"),
  checkCoreUpdate: () => ipcRenderer.invoke("core:checkUpdate"),
  checkAppUpdate: () => ipcRenderer.invoke("app:checkUpdate"),
  downloadAppUpdate: () => ipcRenderer.invoke("app:downloadUpdate"),
  updateCore: () => ipcRenderer.invoke("core:update"),
  matchCoreBuild: () => ipcRenderer.invoke("core:matchBuild"),
  switchCore: (core) => ipcRenderer.invoke("core:switch", core),
  coreList: () => ipcRenderer.invoke("core:list"),
  onCoreStatus: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on("core:status", fn);
    return () => ipcRenderer.removeListener("core:status", fn);
  },
  onCoreLog: (cb) => {
    const fn = (_e, line) => cb(line);
    ipcRenderer.on("core:log", fn);
    return () => ipcRenderer.removeListener("core:log", fn);
  },
  onCoreError: (cb) => {
    const fn = (_e, msg) => cb(msg);
    ipcRenderer.on("core:error", fn);
    return () => ipcRenderer.removeListener("core:error", fn);
  },
  onCoreProgress: (cb) => {
    // 长时间操作进度反馈：{ phase: string, pct: number, label: string }
    const fn = (_e, data) => cb(data);
    ipcRenderer.on("core:progress", fn);
    return () => ipcRenderer.removeListener("core:progress", fn);
  },

  overview: () => ipcRenderer.invoke("proxy:overview"),
  ports: () => ipcRenderer.invoke("app:ports"),
  selectProxy: (group, name) => ipcRenderer.invoke("proxy:select", group, name),
  testDelay: (name) => ipcRenderer.invoke("proxy:delay", name),
  setMode: (mode) => ipcRenderer.invoke("proxy:mode", mode),
  setSystemProxy: (enable) => ipcRenderer.invoke("system:proxy", enable),
  systemProxyStatus: () => ipcRenderer.invoke("system:proxyStatus"),
  onSystemProxyChanged: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on("system:proxyChanged", fn);
    return () => ipcRenderer.removeListener("system:proxyChanged", fn);
  },
  patchConfig: (body) => ipcRenderer.invoke("proxy:patchConfig", body),
  closeAllConnections: () => ipcRenderer.invoke("connections:closeAll"),
  listConnections: () => ipcRenderer.invoke("connections:list"),
  closeConnection: (id) => ipcRenderer.invoke("connections:close", id),

  listProfiles: () => ipcRenderer.invoke("profile:list"),
  listProfilesRich: () => ipcRenderer.invoke("profile:listRich"),
  importProfile: (payload) => ipcRenderer.invoke("profile:import", payload),
  importProfileUrl: (payload) => ipcRenderer.invoke("profile:importUrl", payload),
  listSubscriptions: () => ipcRenderer.invoke("profile:subscriptions"),
  refreshMissingSubInfo: () => ipcRenderer.invoke("subs:refreshMissing"),
  removeSubscription: (url) => ipcRenderer.invoke("profile:removeSubscription", url),
  readActiveProfile: () => ipcRenderer.invoke("profile:readActive"),
  activateProfile: (uid) => ipcRenderer.invoke("profile:activate", uid),
  setProfileEnabled: (uid, enabled) => ipcRenderer.invoke("profile:setEnabled", uid, enabled),
  createEnhanceProfile: (kind, name, global = false) =>
    ipcRenderer.invoke("profile:createEnhance", kind, name, global),
  deleteProfile: (uid) => ipcRenderer.invoke("profile:delete", uid),
  readProfile: (uid) => ipcRenderer.invoke("profile:read", uid),
  writeProfile: (uid, content) => ipcRenderer.invoke("profile:write", uid, content),
  setProfileBinds: (uid, binds) => ipcRenderer.invoke("profile:setBinds", uid, binds),
  enhancePreview: () => ipcRenderer.invoke("profile:enhancePreview"),
  enhanceApply: () => ipcRenderer.invoke("profile:enhanceApply"),
  readRuntime: () => ipcRenderer.invoke("runtime:read"),
  writeRuntime: (content) => ipcRenderer.invoke("runtime:write", content),

  listRules: () => ipcRenderer.invoke("rules:list"),
  saveVisualRules: (rules) => ipcRenderer.invoke("rules:saveVisual", rules),
  listProviders: () => ipcRenderer.invoke("providers:list"),
  updateProvider: (kind, name) => ipcRenderer.invoke("providers:update", kind, name),

  setProxyMode: (mode) => ipcRenderer.invoke("verge:proxyMode", mode),
  validateDns: (ns) => ipcRenderer.invoke("verge:dnsValidate", ns),
  serviceStatus: () => ipcRenderer.invoke("verge:serviceStatus"),
  serviceInstall: () => ipcRenderer.invoke("verge:serviceInstall"),
  serviceUninstall: () => ipcRenderer.invoke("verge:serviceUninstall"),
  enableUwpLoopback: () => ipcRenderer.invoke("verge:uwpLoopback"),
  backupExport: () => ipcRenderer.invoke("verge:backupExport"),
  backupImport: () => ipcRenderer.invoke("verge:backupImport"),
  backupReveal: () => ipcRenderer.invoke("verge:backupReveal"),
  webdavUpload: () => ipcRenderer.invoke("verge:webdavUpload"),
  webdavDownload: () => ipcRenderer.invoke("verge:webdavDownload"),
  exitIp: () => ipcRenderer.invoke("verge:exitIp"),
  detectProxyConflict: () => ipcRenderer.invoke("system:detectProxyConflict"),
  fullConflictScan: () => ipcRenderer.invoke("system:fullConflictScan"),
  checkPorts: () => ipcRenderer.invoke("system:checkPorts"),
  startConflictMonitor: (on) => ipcRenderer.invoke("system:startConflictMonitor", on),
  getSelfIdentity: () => ipcRenderer.invoke("system:getSelfIdentity"),
  // 关闭外部系统代理并退出对应代理软件
  resolveExternalProxy: () => ipcRenderer.invoke("conflict:resolveExternal"),
  // 兼容旧版底层 PID 终止接口
  killProxyProcesses: (pids) => ipcRenderer.invoke("conflict:killOthers", pids),
  // 冲突解决后重试启动
  retryStartAfterConflict: () => ipcRenderer.invoke("conflict:retryStart"),
  // 运行时冲突事件订阅（主进程主动推送到渲染进程）
  onConflictDetected: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("conflict:detected", listener);
    return () => ipcRenderer.removeListener("conflict:detected", listener);
  },
  onConflictResolved: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("conflict:resolved", listener);
    return () => ipcRenderer.removeListener("conflict:resolved", listener);
  },
  // 启动冲突拦截事件（主进程主动推送到渲染进程）
  onConflictBlockStartup: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("conflict:blockStartup", listener);
    return () => ipcRenderer.removeListener("conflict:blockStartup", listener);
  },
  onNotice: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on("veyra:notice", listener);
    return () => ipcRenderer.removeListener("veyra:notice", listener);
  },
  streamingUnlock: () => ipcRenderer.invoke("verge:streaming"),
  streamingUnlockOne: (id) => ipcRenderer.invoke("verge:streamingOne", id),
  unlockCatalog: () => ipcRenderer.invoke("verge:unlockCatalog"),
  proxyEnvText: () => ipcRenderer.invoke("verge:proxyEnv"),
  importNodeUri: (uri) => ipcRenderer.invoke("verge:importUri", uri),
  openWebUI: (which) => ipcRenderer.invoke("verge:openWebUI", which),
  clearLogFiles: () => ipcRenderer.invoke("logs:clearFile"),
  setNextUpdate: (url, nextUpdateAt) => ipcRenderer.invoke("profile:setNextUpdate", url, nextUpdateAt),
  vcRuntime: () => ipcRenderer.invoke("verge:vcRuntime"),
  downloadVc: () => ipcRenderer.invoke("verge:downloadVc"),
  onLightweight: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on("app:lightweight", fn);
    return () => ipcRenderer.removeListener("app:lightweight", fn);
  },

  traffic: () => ipcRenderer.invoke("traffic:now"),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),

  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  applyNetwork: (patch) => ipcRenderer.invoke("settings:applyNetwork", patch),
  openPath: (which) => ipcRenderer.invoke("settings:openPath", which),
  copyText: (text) => ipcRenderer.invoke("settings:copy", text),
  appInfo: () => ipcRenderer.invoke("app:info"),
});
