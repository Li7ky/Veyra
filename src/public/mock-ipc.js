/*
 * MOCK IPC BRIDGE for Veyra-omini web testing
 * Simulates window.veyra in browser context (without the desktop backend)
 * Enables full UI interaction testing via browser-action automation
 */
(function() {
  'use strict';

  // ---------- Mock State ----------
  var state = {
    running: false,
    systemProxy: false,
    mode: 'rule',
    selectedNode: 'auto',
    profiles: [
      { uid: 'mock-profile-1', name: '本地配置', type: 'local', enabled: true, global: false, updatedAt: Date.now() - 86400000, file: 'local.yaml', size: 2048,
        proxies: [
          { name: 'HK-Node', type: 'Shadowsocks', server: 'hk.example.com', port: 443 },
          { name: 'JP-Node', type: 'Shadowsocks', server: 'jp.example.com', port: 443 },
          { name: 'US-Node', type: 'Shadowsocks', server: 'us.example.com', port: 443 },
        ]
      }
    ],
    subscriptions: [],
    connections: [],
    rules: [
      { type: 'DOMAIN-SUFFIX', payload: 'google.com', proxy: 'PROXY' },
      { type: 'DOMAIN-SUFFIX', payload: 'youtube.com', proxy: 'PROXY' },
      { type: 'DOMAIN-SUFFIX', payload: 'bilibili.com', proxy: 'DIRECT' },
      { type: 'GEOIP', payload: 'CN', proxy: 'DIRECT' },
      { type: 'MATCH', payload: '', proxy: 'PROXY' },
    ],
    conflictList: [],
    settings: {
      mixedPort: 17897, controllerPort: 19097, secret: 'mock-secret',
      allowLan: false, logLevel: 'info', autoTest: true, autoPick: true,
      autoTestIntervalSec: 300, subAutoUpdateMin: 60,
      closeToTray: true, startWithWindows: false, startMinimized: false,
      proxyBypass: 'localhost;127.*;10.*;192.168.*',
      theme: 'system', core: 'mihomo',
      proxyMode: 'rule', proxyGuard: true, disconnectOnProxyOff: false,
      blockConflict: true,
      tunEnable: false, tunStack: 'system', tunAutoRoute: true, tunStrictRoute: false,
      tunAutoDetect: true, tunSniff: true, tunMtu: 9000,
      tunDnsHijack: ['any:53'],
      dnsEnable: true, dnsIpv6: true, dnsMode: 'fake-ip',
      dnsFakeIpRange: '198.18.0.1/16',
      dnsNameserver: ['223.5.5.5', '119.29.29.29'],
      dnsFallback: ['1.1.1.1', '8.8.8.8'],
      dnsHosts: { 'dns.example.com': '1.1.1.1' },
      locale: 'zh-CN',
      subRetry: 3, subTimeoutSec: 30, subUpdateViaProxy: true,
      unifiedDelay: true, tcpConcurrent: true,
      nodeSort: 'default',
      homeCards: { subscription: true, node: true, network: true, mode: true, traffic: true, core: true, system: true },
      logMaxLines: 1000, logAutoCleanDays: 7
    },
    testResults: [
      { id: 'netflix', title: 'Netflix', ok: true, fail: false, region: 'US', status: 200, note: 'Not Blocked', testedAt: Date.now() },
      { id: 'youtube', title: 'YouTube Premium', ok: true, fail: false, region: 'US', status: 200, note: 'OK', testedAt: Date.now() },
      { id: 'disneyplus', title: 'Disney+', ok: false, fail: true, region: null, status: 403, note: 'Blocked', testedAt: Date.now() },
      { id: 'primevideo', title: 'Prime Video', ok: true, fail: false, region: 'JP', status: 200, note: 'Not Blocked', testedAt: Date.now() },
      { id: 'spotify', title: 'Spotify', ok: true, fail: false, region: null, status: 200, note: 'OK', testedAt: Date.now() },
      { id: 'openai', title: 'ChatGPT', ok: true, fail: false, region: 'US', status: 200, note: 'OK', testedAt: Date.now() }
    ]
  };

  function delay(ms) { return new Promise(function(r) { setTimeout(r, ms || 300); }); }
  function ok(data) { return { ok: true, data: data }; }

  // Mock proxies derived from active profile
  function buildProxies() {
    var active = state.profiles.find(function(p){ return p.enabled; });
    var nodes = active ? (active.proxies || []) : [];
    var proxies = {
      PROXY: { type: 'Selector', name: 'PROXY', now: state.selectedNode, all: ['auto'].concat(nodes.map(function(n){return n.name;})), history: [{delay: 85}] },
      auto: { type: 'URLTest', name: 'auto', now: state.selectedNode, all: nodes.map(function(n){return n.name;}), history: [{delay: 90}] },
      'HK-Node': { type: 'Shadowsocks', name: 'HK-Node', history: [{delay: 120}] },
      'JP-Node': { type: 'Shadowsocks', name: 'JP-Node', history: [{delay: 85}] },
      'US-Node': { type: 'Shadowsocks', name: 'US-Node', history: [{delay: 250}] },
      DIRECT: { type: 'Direct', name: 'DIRECT', history: [{delay: 0}] },
      REJECT: { type: 'Reject', name: 'REJECT', history: [{delay: 0}] }
    };
    // Dynamic node entries
    nodes.forEach(function(n){ if (!proxies[n.name]) { proxies[n.name] = { type: n.type, name: n.name, history: [{delay: Math.floor(Math.random()*200+50)}] }; } });
    return proxies;
  }

  var veyra = {
    // Window controls
    minimize: function() { return delay(50); },
    maximize: function() { return delay(50); },
    isMaximized: function() { return delay(50).then(function(){ return false; }); },
    close: function() { return delay(50); },

    // Core
    startCore: function() { return delay(1000).then(function(){ state.running = true; return {ok: true}; }); },
    stopCore: function() { return delay(1000).then(function(){ state.running = false; return {ok: true}; }); },
    restartCore: function() { return delay(1000).then(function(){ return {ok: true}; }); },
    coreStatus: function() { return delay(200).then(function(){ return {running: state.running, version: '1.18.0', pid: state.running ? 12345 : null}; }); },
    coreInfo: function() { return delay(200).then(function(){ return {
      path: 'mihomo.exe', exists: true, size: 12345678, mtime: Date.now(),
      fileVersion: '1.18.0', build: 'mihomo windows amd64',
      cpu: 'amd64', cpuCount: 8, arch: 'x64',
      pid: state.running ? 12345 : null, running: state.running,
      mixedPort: state.settings.mixedPort,
      controller: '127.0.0.1:' + state.settings.controllerPort,
      secret: state.settings.secret, core: state.settings.core,
      apiVersion: { version: '1.18.0' }
    }; }); },
    checkCoreUpdate: function() { return delay(500).then(function(){ return {latest: '1.18.0'}; }); },
    updateCore: function() { return delay(1000).then(function(){ return {ok: true}; }); },
    coreList: function() { return delay(200).then(function(){ return {
      active: 'mihomo',
      mihomo: { installed: true, version: '1.18.0' },
      singbox: { installed: false, version: '' }
    }; }); },

    // Overview
    overview: function() { return delay(300).then(function(){ return {
      proxies: { proxies: buildProxies() },
      configs: { mode: state.mode, 'mixed-port': state.settings.mixedPort, port: 7890 },
      connections: { downloadTotal: 1048576, uploadTotal: 524288, connections: state.connections },
      connectionsCount: state.connections.length,
      mixedPort: state.settings.mixedPort,
      controller: '127.0.0.1:' + state.settings.controllerPort,
      preferredPort: state.settings.mixedPort,
      coreMemoryMB: 45
    }; }); },
    ports: function() { return delay(100).then(function(){ return { mixedPort: state.settings.mixedPort, controller: '127.0.0.1:' + state.settings.controllerPort, preferredPort: state.settings.mixedPort }; }); },

    // Proxies
    selectProxy: function(group, node) { return delay(300).then(function(){
      state.selectedNode = node;
      console.log('[MOCK] selectProxy:', group, node);
      return {ok: true};
    }); },
    testDelay: function(name) { return delay(500).then(function(){
      var d = Math.floor(Math.random() * 300 + 50);
      return {status: 200, data: {delay: d}};
    }); },
    setMode: function(mode) { return delay(200).then(function(){ state.mode = mode; return {ok: true}; }); },

    // System Proxy
    setSystemProxy: function(on) { return delay(300).then(function(){ state.systemProxy = on; return {ok: true, enabled: on, server: '127.0.0.1:' + state.settings.mixedPort}; }); },
    systemProxyStatus: function() { return delay(100).then(function(){ return {enabled: state.systemProxy, server: '127.0.0.1:' + state.settings.mixedPort}; }); },

    // Config
    patchConfig: function(body) { return delay(300).then(function(){ return {ok: true}; }); },

    // Connections
    listConnections: function() { return delay(200).then(function(){ return {connections: state.connections, downloadTotal: 0, uploadTotal: 0}; }); },
    closeConnection: function(id) { return delay(200).then(function(){ state.connections = state.connections.filter(function(c){ return c.id !== id; }); return {ok: true}; }); },
    closeAllConnections: function() { return delay(300).then(function(){ state.connections = []; return {ok: true}; }); },

    // Rules
    listRules: function() { return delay(200).then(function(){ return {rules: state.rules}; }); },

    // Profiles
    listProfiles: function() { return delay(300).then(function(){ return state.profiles; }); },
    listProfilesRich: function() { return delay(300).then(function(){ return state.profiles; }); },
    importProfile: function(opts) { return delay(1500).then(function(){
      var newProfile = {
        uid: 'sub-' + Date.now(),
        name: opts.name || '新订阅',
        type: 'remote',
        enabled: true,
        global: false,
        updatedAt: Date.now(),
        file: 'sub_' + Date.now() + '.yaml',
        size: 48739,
        url: opts.url
      };
      state.profiles.push(newProfile);
      state.subscriptions.push({
        url: opts.url,
        name: newProfile.name,
        updatedAt: Date.now(),
        userinfo: { upload: 102400, download: 51200, total: 102400, expire: Date.now() + 86400000*30 }
      });
      // Add mock nodes from subscription
      newProfile.proxies = [
        { name: 'VLESS-HK', type: 'VLESS', server: 'hk.lxyun.xyz', port: 443 },
        { name: 'VLESS-JP', type: 'VLESS', server: 'jp.lxyun.xyz', port: 443 },
        { name: 'VLESS-SG', type: 'VLESS', server: 'sg.lxyun.xyz', port: 443 },
        { name: 'VLESS-US', type: 'VLESS', server: 'us.lxyun.xyz', port: 443 },
        { name: 'Hy2-HK', type: 'Hysteria2', server: 'hy2-hk.lxyun.xyz', port: 443 }
      ];
      return {ok: true, path: 'profiles/sub_' + Date.now() + '.yaml', mixedPort: state.settings.mixedPort, controller: '127.0.0.1:' + state.settings.controllerPort, warnings: []};
    }); },
    importProfileUrl: function(opts) { return veyra.importProfile(opts); },
    listSubscriptions: function() { return delay(200).then(function(){ return state.subscriptions; }); },
    readActiveProfile: function() { return delay(200).then(function(){ return 'mixed-port: ' + state.settings.mixedPort + '\nallow-lan: false\nmode: ' + state.mode + '\n'; }); },
    activateProfile: function(uid) { return delay(500).then(function(){
      state.profiles.forEach(function(p){ p.enabled = (p.uid === uid); });
      return {ok: true, warnings: []};
    }); },
    createEnhanceProfile: function(kind, name) { return delay(500).then(function(){
      var p = {uid: 'enhance-' + kind, name: name || (kind + '-mode'), type: kind, enabled: true, global: false, updatedAt: Date.now(), file: '', size: 0};
      state.profiles.push(p);
      return p;
    }); },
    deleteProfile: function(uid) { return delay(500).then(function(){
      state.profiles = state.profiles.filter(function(p){ return p.uid !== uid; });
      return {ok: true};
    }); },
    readProfile: function(uid) { return delay(200).then(function(){
      return 'proxies:\n  - { name: "HK-Node", type: ss, server: hk.example.com, port: 443, cipher: aes-128-gcm, password: test }\n  - { name: "JP-Node", type: ss, server: jp.example.com, port: 443, cipher: aes-128-gcm, password: test }\n';
    }); },
    writeProfile: function(uid, content) { return delay(300).then(function(){ return {ok: true}; }); },
    setProfileBinds: function(uid, binds) { return delay(200).then(function(){ return {uid: uid, binds: binds}; }); },
    enhancePreview: function() { return delay(500).then(function(){ return {yaml: '# enhanced\nproxies:\n  - name: test\n', warnings: [], scriptLogs: ['mock enhance log']}; }); },
    enhanceApply: function() { return delay(800).then(function(){ return {ok: true, warnings: [], scriptLogs: ['applied']}; }); },
    readRuntime: function() { return delay(200).then(function(){ return 'runtime: mock\nallow-lan: false\n'; }); },
    writeRuntime: function(c) { return delay(300).then(function(){ return {ok: true}; }); },
    setProxyMode: function(m) { return delay(200).then(function(){ state.mode = m; return {ok: true}; }); },
    validateDns: function(ns) { return delay(100).then(function(){ return {ok: true, host: ns}; }); },

    // Service
    serviceStatus: function() { return delay(100).then(function(){ return {installed: false}; }); },
    serviceInstall: function() { return delay(1000).then(function(){ return {ok: true}; }); },
    serviceUninstall: function() { return delay(500).then(function(){ return {ok: true}; }); },

    // Backup
    backupExport: function() { return delay(500).then(function(){ return {ok: true, path: 'backup.zip', bytes: 102400}; }); },
    backupImport: function() { return delay(500).then(function(){ return {ok: true, canceled: false}; }); },
    backupReveal: function() { return delay(100).then(function(){ return {}; }); },
    webdavUpload: function() { return delay(500).then(function(){ return {}; }); },
    webdavDownload: function() { return delay(500).then(function(){ return {}; }); },

    // Settings
    exitIp: function() { return delay(500).then(function(){ return {ip: '1.2.3.4', country: 'Japan', city: 'Tokyo', isp: 'Mock ISP'}; }); },
    detectProxyConflict: function() { return delay(300).then(function(){ return state.conflictList; }); },
    fullConflictScan: function() { return delay(600).then(function(){ return {conflicts: [], summary: 'No conflicts', severity: 'low', counts: {critical: 0, high: 0, medium: 0}}; }); },
    checkPorts: function() { return delay(200).then(function(){ return {mixedPort: state.settings.mixedPort, controllerPort: state.settings.controllerPort, mixedFree: true, ctrlFree: true}; }); },
    getSettings: function() { return delay(100).then(function(){ return state.settings; }); },
    setSettings: function(patch) { return delay(300).then(function(){
      Object.assign(state.settings, patch);
      return patch;
    }); },
    applyNetwork: function(patch) { return delay(300).then(function(){
      Object.assign(state.settings, patch);
      return {settings: state.settings, mixedPort: state.settings.mixedPort, controller: '127.0.0.1:' + state.settings.controllerPort};
    }); },

    // Streaming
    streamingUnlock: function() { return delay(2000).then(function(){ return state.testResults; }); },
    streamingUnlockOne: function(id) { return delay(800).then(function(){
      var item = state.testResults.find(function(t){ return t.id === id; });
      if (item) item.testedAt = Date.now();
      return item || {id: id, title: id, ok: true, fail: false, region: null, status: 200, note: 'OK', testedAt: Date.now()};
    }); },

    // Import node URI
    importNodeUri: function(uri) { return delay(500).then(function(){
      console.log('[MOCK] importNodeUri:', uri);
      return {ok: true};
    }); },

    // Logs & misc
    openWebUI: function(w) { return delay(100).then(function(){ return {}; }); },
    clearLogFiles: function() { return delay(300).then(function(){ return {ok: true, removed: 5}; }); },
    vcRuntime: function() { return delay(100).then(function(){ return {ok: true, installed: true}; }); },
    proxyEnvText: function() { return delay(100).then(function(){ return {text: 'http_proxy=http://127.0.0.1:' + state.settings.mixedPort + '\nhttps_proxy=http://127.0.0.1:' + state.settings.mixedPort + '\n'}; }); },
    openExternal: function(url) { console.log('[MOCK] openExternal:', url); return Promise.resolve(); },
    copyText: function(t) { console.log('[MOCK] copyText:', t); return Promise.resolve({}); },
    appInfo: function() { return delay(50).then(function(){ return {name: 'Veyra-omini', version: '1.1.8', electron: 'Tauri 2', platform: 'win32', arch: 'x64', isDev: true}; }); },
    openPath: function(w) { return delay(100).then(function(){ return {}; }); },
    traffic: function() { return delay(200).then(function(){ return {downloadTotal: 1048576, uploadTotal: 524288, connections: []}; }); },
    onCoreStatus: function(cb) { return function(){}; },
    onCoreLog: function(cb) { return function(){}; },
    onCoreError: function(cb) { return function(){}; },
    onCoreProgress: function(cb) { return function(){}; },
    onSystemProxyChanged: function(cb) { return function(){}; },
    onConflictDetected: function(cb) { return function(){}; },
    onConflictResolved: function(cb) { return function(){}; },
    onConflictBlockStartup: function(cb) { return function(){}; },
    onNotice: function(cb) { return function(){}; }
  };

  // ---- 预览态（仅浏览器调界面时用）----
  // ?theme=dark|light 固定主题；?mock=running 让界面呈现「已连接 / 有流量 / 有连接」的样子。
  try {
    var qs = new URLSearchParams(location.search);
    var th = qs.get('theme');
    if (th === 'dark' || th === 'light') state.settings.theme = th;
    if (qs.get('mock') === 'running') {
      state.running = true;
      state.systemProxy = true;
      state.selectedNode = 'HK-Node';
      state.subscriptions = [
        { url: 'https://sub.example.com/api/v1/client/subscribe?token=abc123', name: '示例机场 · 专业版', updatedAt: Date.now() - 3600e3, userinfo: { upload: 8.2 * 1073741824, download: 42.6 * 1073741824, total: 200 * 1073741824, expire: (Date.now() + 45 * 864e5) / 1000 } },
        { url: 'https://sub2.example.com/clash?token=def456', name: '备用订阅 · 轻量', updatedAt: Date.now() - 2 * 864e5, userinfo: { upload: 1.1 * 1073741824, download: 12.4 * 1073741824, total: 100 * 1073741824, expire: (Date.now() + 12 * 864e5) / 1000 } }
      ];
      state.connections = [
        { id: 'c1', upload: 12034, download: 2048576, start: new Date(Date.now() - 52000).toISOString(), chains: ['HK-Node', 'PROXY'], rule: 'Match', rulePayload: '', metadata: { host: 'www.youtube.com', destinationIP: '142.250.72.14', destinationPort: 443, network: 'tcp', type: 'HTTPS', process: 'chrome.exe' } },
        { id: 'c2', upload: 4210, download: 912640, start: new Date(Date.now() - 41000).toISOString(), chains: ['JP-Node', 'PROXY'], rule: 'DomainSuffix', rulePayload: 'github.com', metadata: { host: 'api.github.com', destinationIP: '140.82.112.5', destinationPort: 443, network: 'tcp', type: 'HTTPS', process: 'Code.exe' } },
        { id: 'c3', upload: 812, download: 33211, start: new Date(Date.now() - 18000).toISOString(), chains: ['DIRECT'], rule: 'GeoIP', rulePayload: 'CN', metadata: { host: 'www.bilibili.com', destinationIP: '119.3.70.188', destinationPort: 443, network: 'tcp', type: 'HTTPS', process: 'chrome.exe' } },
        { id: 'c4', upload: 0, download: 0, start: new Date(Date.now() - 4000).toISOString(), chains: ['REJECT'], rule: 'DomainSuffix', rulePayload: 'doubleclick.net', metadata: { host: 'ad.doubleclick.net', destinationIP: '', destinationPort: 443, network: 'tcp', type: 'HTTPS', process: 'msedge.exe' } }
      ];
    }
  } catch (e) { /* 忽略 */ }

  window.veyra = veyra;
  window.__MOCK_IPC_ACTIVE__ = true;
  console.log('[MOCK] window.veyra initialized - mock IPC active');
})();
