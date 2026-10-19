const fs = require("fs");
const path = require("path");
const vm = require("vm");
const yaml = require("js-yaml");
const { loadIndex } = require("./profiles.cjs");
const { writeFileAtomic } = require("./fs-utils.cjs");

function asMap(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  return obj;
}

function deepMerge(base, patch) {
  const out = { ...asMap(base) };
  for (const [k, v] of Object.entries(asMap(patch))) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function prependSeq(cfg, key, arr, warnings) {
  if (!Array.isArray(arr)) {
    warnings.push(`${key}: prepend 值不是数组`);
    return;
  }
  const base = Array.isArray(cfg[key]) ? cfg[key] : [];
  cfg[key] = [...arr, ...base];
}

function appendSeq(cfg, key, arr, warnings) {
  if (!Array.isArray(arr)) {
    warnings.push(`${key}: append 值不是数组`);
    return;
  }
  const base = Array.isArray(cfg[key]) ? cfg[key] : [];
  cfg[key] = [...base, ...arr];
}

function applyMerge(config, mergeText) {
  const warnings = [];
  let merge;
  try {
    merge = yaml.load(mergeText) || {};
  } catch (e) {
    throw new Error(`Merge YAML 解析失败: ${e.message}`);
  }
  if (!merge || typeof merge !== "object") return warnings;
  const cfg = config;

  for (const [key, v] of Object.entries(merge)) {
    if (!key || key.startsWith("#")) continue;
    switch (key) {
      case "prepend-rules":
        prependSeq(cfg, "rules", v, warnings);
        break;
      case "append-rules":
        appendSeq(cfg, "rules", v, warnings);
        break;
      case "prepend-proxies":
        prependSeq(cfg, "proxies", v, warnings);
        break;
      case "append-proxies":
        appendSeq(cfg, "proxies", v, warnings);
        break;
      case "prepend-proxy-groups":
        prependSeq(cfg, "proxy-groups", v, warnings);
        break;
      case "append-proxy-groups":
        appendSeq(cfg, "proxy-groups", v, warnings);
        break;
      case "delete-rules":
        if (Array.isArray(v) && Array.isArray(cfg.rules)) {
          const drop = new Set(v.map(String));
          cfg.rules = cfg.rules.filter((r) => !drop.has(String(r)));
        } else warnings.push("delete-rules: 需要字符串数组");
        break;
      case "delete-proxies":
        if (Array.isArray(v) && Array.isArray(cfg.proxies)) {
          const drop = new Set(v.map(String));
          cfg.proxies = cfg.proxies.filter((p) => p && !drop.has(String(p.name)));
        } else warnings.push("delete-proxies: 需要名称数组");
        break;
      case "delete-proxy-groups":
        if (Array.isArray(v) && Array.isArray(cfg["proxy-groups"])) {
          const drop = new Set(v.map(String));
          cfg["proxy-groups"] = cfg["proxy-groups"].filter((g) => g && !drop.has(String(g.name)));
        } else warnings.push("delete-proxy-groups: 需要名称数组");
        break;
      case "rules":
      case "proxies":
      case "proxy-groups":
      case "proxy-providers":
      case "rule-providers":
        // 空键（YAML 里写了 `rules:` 但没内容）会被 js-yaml 载入为 null，
        // 直接赋值会让配置里出现 `rules: null`，mihomo 判定规则集非数组后
        // 拒绝整份配置 —— 分流全失效甚至内核起不来。空值一律忽略并告警。
        if (v == null) {
          warnings.push(`${key}: 内容为空，已忽略`);
          break;
        }
        cfg[key] = v;
        break;
      default:
        if (v && typeof v === "object" && !Array.isArray(v) && cfg[key] && typeof cfg[key] === "object" && !Array.isArray(cfg[key])) {
          cfg[key] = deepMerge(cfg[key], v);
        } else {
          cfg[key] = v;
        }
    }
  }
  return warnings;
}

function applyScript(config, script, profileName) {
  const sandbox = {
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
  };
  vm.createContext(sandbox);
  const wrapped = `${script}\n; typeof main === 'function' ? main : null;`;
  let mainFn;
  try {
    mainFn = vm.runInContext(wrapped, sandbox, { timeout: 3000, displayLength: 256 * 1024 });
  } catch (e) {
    throw new Error(`Script 执行失败: ${e.message}`);
  }
  if (typeof mainFn !== "function") {
    throw new Error("Script 必须声明 function main(config, profileName)");
  }
  // 传入纯 JSON 可克隆对象，切断原型污染面
  const input = JSON.parse(JSON.stringify(config));
  // main() 也必须在 vm context 内执行并带 timeout：
  // timeout 只作用于 runInContext 那一次执行，若在 sandbox 外直接调用 mainFn，
  // 用户脚本里 while(true){} 会永久阻塞 Electron 主进程（界面假死）。
  sandbox.__veyraInput = input;
  sandbox.__veyraProfileName = profileName;
  let out;
  try {
    out = vm.runInContext(
      `JSON.stringify(main(__veyraInput, __veyraProfileName))`,
      sandbox,
      { timeout: 3000 }
    );
    out = JSON.parse(out);
  } catch (e) {
    throw new Error(`Script main() 执行失败: ${e.message}`);
  }
  if (!out || typeof out !== "object") {
    throw new Error("Script 必须返回配置对象");
  }
  return out;
}

function injectFoxveyDefaults(config, opts) {
  // 缺省兜底：现状所有调用链均传数字（enhanceOpts 的 MIXED_PORT 恒为数字），
  // 但新增调用方传 undefined 时会写入 mixed-port: null 导致内核绑定异常
  config["mixed-port"] = opts.mixedPort ?? 7897;
  const bind = opts.bindAddress || "127.0.0.1";
  config["external-controller"] = `${bind === "0.0.0.0" || opts.allowLan ? "0.0.0.0" : "127.0.0.1"}:${opts.controllerPort ?? 19097}`;
  if (opts.bindAddress) config["bind-address"] = opts.bindAddress;
  config.secret = opts.secret;
  config["allow-lan"] = !!opts.allowLan;
  config["log-level"] = opts.logLevel || "info";
  if (!config.mode) config.mode = "rule";
  if (opts.dnsOverride && opts.dnsConfig) {
    config.dns = opts.dnsConfig;
  } else if (!config.dns) {
    config.dns = {
      enable: true,
      "enhanced-mode": "fake-ip",
      "fake-ip-range": "198.18.0.1/16",
      nameserver: ["223.5.5.5", "8.8.8.8"],
    };
  }
  if (opts.tunConfig) {
    config.tun = { ...(config.tun || {}), ...opts.tunConfig };
  }
  if (opts.unifiedDelay != null) config["unified-delay"] = !!opts.unifiedDelay;
  if (opts.tcpConcurrent != null) config["tcp-concurrent"] = !!opts.tcpConcurrent;
}

function applyEnhanceItem(config, item, text, profileName, warnings, scriptLogs, scope) {
  const mergeLike = new Set(["merge", "rules", "proxies", "groups"]);
  if (mergeLike.has(item.type)) {
    try {
      warnings.push(...applyMerge(config, text).map((w) => `${scope} ${item.type} ${item.name}: ${w}`));
    } catch (e) {
      warnings.push(`${scope} ${item.type} ${item.name}: ${e.message}`);
    }
  } else if (item.type === "script") {
    try {
      const next = applyScript(config, text, profileName);
      scriptLogs.push(`${scope} script ${item.name}: ok`);
      return next;
    } catch (e) {
      warnings.push(`${scope} script ${item.name}: ${e.message}`);
    }
  }
  return config;
}

function cleanupGroups(config) {
  const names = new Set(["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE"]);
  for (const p of Array.isArray(config.proxies) ? config.proxies : []) {
    if (p && p.name) names.add(String(p.name));
  }
  for (const g of Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : []) {
    if (g && g.name) names.add(String(g.name));
  }
  for (const g of Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : []) {
    if (!g || !Array.isArray(g.proxies)) continue;
    g.proxies = g.proxies.filter((n) => typeof n !== "string" || names.has(n));
  }
}

/**
 * 内置基础规则：订阅没带 rules 时补一套最小可用规则。
 * 不补的话 rule 模式下没有规则可匹配，内核等于全量直连——代理完全不生效，
 * 首页「规则数量」也会一直是 0。
 */
function ensureBasicRules(config, warnings = []) {
  const rules = Array.isArray(config.rules) ? config.rules.filter(Boolean) : [];
  if (rules.length) return;
  const groups = Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : [];
  const groupName =
    (groups.find((g) => g && g.name) || {}).name ||
    (Array.isArray(config.proxies) && config.proxies[0] && config.proxies[0].name) ||
    "DIRECT";
  config.rules = ["GEOIP,LAN,DIRECT,no-resolve", "GEOIP,CN,DIRECT", `MATCH,${groupName}`];
  warnings.push("订阅未包含 rules，已补入内置基础规则（局域网/国内直连，其它走代理）");
}

function enhance(profilesDir, runtimePath, opts) {
  const warnings = [];
  const scriptLogs = [];
  const idx = loadIndex(profilesDir);
  const mainItem = idx.active
    ? idx.items.find((x) => x.uid === idx.active && (x.type === "remote" || x.type === "local"))
    : null;

  let config = {};
  if (mainItem) {
    try {
      config = yaml.load(fs.readFileSync(path.join(profilesDir, mainItem.file), "utf8")) || {};
    } catch (e) {
      warnings.push(`主配置解析失败: ${e.message}`);
      config = {};
    }
  } else if (fs.existsSync(runtimePath)) {
    try {
      config = yaml.load(fs.readFileSync(runtimePath, "utf8")) || {};
    } catch {
      config = {};
    }
  }
  if (!config || typeof config !== "object") config = {};

  const profileName = mainItem ? mainItem.name : "default";
  const enhanceTypes = new Set(["merge", "script", "rules", "proxies", "groups"]);

  for (const item of idx.items.filter((x) => x.enabled && x.global && enhanceTypes.has(x.type))) {
    // index 与磁盘可能不同步（文件被手动删除）：缺文件只告警并跳过，不拖垮整个 enhance
    const fp = path.join(profilesDir, item.file);
    if (!fs.existsSync(fp)) {
      warnings.push(`global ${item.type} ${item.name}: 文件缺失(${item.file})，已跳过`);
      continue;
    }
    const text = fs.readFileSync(fp, "utf8");
    config = applyEnhanceItem(config, item, text, profileName, warnings, scriptLogs, "global") || config;
  }

  // 订阅级绑定扩展（优先于未绑定的同类型本地增强）
  if (mainItem && mainItem.binds) {
    for (const key of ["rules", "proxies", "groups", "merge", "script"]) {
      const bindUid = mainItem.binds[key];
      if (!bindUid) continue;
      const item = idx.items.find((x) => x.uid === bindUid);
      if (!item || !item.enabled) continue;
      const fp = path.join(profilesDir, item.file);
      if (!fs.existsSync(fp)) {
        warnings.push(`bound ${item.type} ${item.name}: 文件缺失(${item.file})，已跳过`);
        continue;
      }
      const text = fs.readFileSync(fp, "utf8");
      config = applyEnhanceItem(config, item, text, profileName, warnings, scriptLogs, "bound") || config;
    }
  }

  for (const item of idx.items.filter(
    (x) => x.enabled && !x.global && enhanceTypes.has(x.type)
  )) {
    // 已被订阅绑定占用的条目跳过，避免重复应用
    const binds = (mainItem && mainItem.binds) || {};
    if (Object.values(binds).includes(item.uid)) continue;
    const fp = path.join(profilesDir, item.file);
    if (!fs.existsSync(fp)) {
      warnings.push(`profile ${item.type} ${item.name}: 文件缺失(${item.file})，已跳过`);
      continue;
    }
    const text = fs.readFileSync(fp, "utf8");
    config = applyEnhanceItem(config, item, text, profileName, warnings, scriptLogs, "profile") || config;
  }

  injectFoxveyDefaults(config, opts);
  cleanupGroups(config);
  ensureBasicRules(config, warnings);

  const text = yaml.dump(config, { lineWidth: -1, noRefs: true });
  return { text, warnings, scriptLogs, config };
}

function enhanceAndWrite(profilesDir, runtimePath, opts) {
  const r = enhance(profilesDir, runtimePath, opts);
  // 原子写：写一半被中断会让 runtime 配置只剩半截，热重载失败且内核起不来，
  // 代理整体不可用（对比 profiles.cjs 的 saveIndex 已用 tmp+rename 的做法）
  writeFileAtomic(runtimePath, r.text, "utf8");
  return r;
}

module.exports = { enhance, enhanceAndWrite, applyMerge, applyScript };
