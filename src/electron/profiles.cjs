const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function nowMs() {
  return Date.now();
}

// Windows 保留设备名：这些名字（含带扩展名的）无法作为普通文件名使用
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitizeName(name) {
  let s = String(name || "profile")
    .trim()
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\.ya?ml$/i, "")
    .replace(/\.js$/i, "")
    // 防御性处理：当前落盘名是 `${uid}_${safe}.yaml`，前缀让 `..` 与保留名
    // 实际上无法生效（不可利用），但一旦将来有人改掉命名规则就会立刻变成
    // 路径穿越 / 建不出文件。这里按最小代价先把口子堵上。
    .replace(/\.{2,}/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 64)
    .replace(/[. ]+$/, ""); // Windows 不允许文件名以点或空格结尾
  if (!s) s = "profile";
  if (WIN_RESERVED.test(s)) s = `_${s}`;
  return s;
}

function loadIndex(profilesDir) {
  const p = path.join(profilesDir, "index.json");
  if (!fs.existsSync(p)) return { items: [], active: null };
  try {
    // 剥离 UTF-8 BOM：记事本（UTF-8 with BOM）编辑过的文件 JSON.parse 会抛错，
    // 原实现直接 catch 成空 index，随后的任何 saveIndex 都会把空列表持久化——档案全部丢失
    let raw = fs.readFileSync(p, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.items)) return { items: [], active: null };
    return { items: data.items, active: data.active || null };
  } catch {
    // 解析失败时先备份坏文件，避免下一次 saveIndex 把损坏现场覆盖掉、无法恢复
    try {
      const backup = path.join(profilesDir, `index.json.corrupt-${Date.now()}`);
      fs.copyFileSync(p, backup);
    } catch {}
    return { items: [], active: null };
  }
}

function saveIndex(profilesDir, idx) {
  fs.mkdirSync(profilesDir, { recursive: true });
  // 临时文件 + rename 原子替换：直接 writeFileSync 被中断会截断 index.json，
  // 截断文件又会被上面的解析兜底当空 index 处理——等价于全部档案丢失
  const target = path.join(profilesDir, "index.json");
  const tmp = path.join(profilesDir, `index.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), "utf8");
  fs.renameSync(tmp, target);
}

function refreshSizes(profilesDir, idx) {
  for (const item of idx.items) {
    const fp = path.join(profilesDir, item.file);
    try {
      item.size = fs.statSync(fp).size;
    } catch {
      item.size = 0;
    }
  }
  return idx;
}

function listRich(profilesDir) {
  const idx = refreshSizes(profilesDir, loadIndex(profilesDir));
  return idx.items;
}

function importLocal(profilesDir, name, content, kind = "local", url = null) {
  fs.mkdirSync(profilesDir, { recursive: true });
  const uid = crypto.randomUUID();
  const safe = sanitizeName(name);
  const file = `${uid}_${safe}.yaml`;
  fs.writeFileSync(path.join(profilesDir, file), content, "utf8");
  const item = {
    uid,
    name: safe,
    type: kind,
    url,
    enabled: true,
    global: false,
    updatedAt: nowMs(),
    file,
    size: Buffer.byteLength(content, "utf8"),
  };
  const idx = loadIndex(profilesDir);
  idx.items = [item, ...idx.items.filter((x) => x.uid !== uid)];
  if (kind === "remote" || kind === "local") idx.active = uid;
  saveIndex(profilesDir, idx);
  return item;
}

function createEnhance(profilesDir, kind, name, global = false) {
  const allowed = new Set(["merge", "script", "rules", "proxies", "groups"]);
  if (!allowed.has(kind)) throw new Error("仅支持 merge / script / rules / proxies / groups");
  fs.mkdirSync(profilesDir, { recursive: true });
  const uid = crypto.randomUUID();
  const safe = sanitizeName(name);
  const ext = kind === "script" ? "js" : "yaml";
  const file = `${uid}_${safe}.${ext}`;
  let content;
  if (kind === "script") {
    content = "function main(config, profileName) {\n  // 返回修改后的 Clash 配置对象\n  return config;\n}\n";
  } else if (kind === "rules") {
    content =
      "# Rules 增强（写入 rules 数组，或用 prepend-rules / append-rules / delete-rules）\nprepend-rules:\n  # - DOMAIN-SUFFIX,example.com,PROXY\n";
  } else if (kind === "proxies") {
    content =
      "# Proxies 增强（prepend-proxies / append-proxies / delete-proxies）\nprepend-proxies:\n  # - { name: my-ss, type: ss, server: 1.2.3.4, port: 8388, cipher: aes-128-gcm, password: pwd }\n";
  } else if (kind === "groups") {
    content =
      "# Groups 增强（prepend-proxy-groups / append-proxy-groups / delete-proxy-groups）\nprepend-proxy-groups:\n  # - { name: MyGroup, type: select, proxies: [DIRECT] }\n";
  } else {
    content =
      "# Veyra Merge（Verge 风格）\n# prepend-rules / append-rules / delete-rules\n# prepend-proxies / append-proxies / delete-proxies\n# prepend-proxy-groups / append-proxy-groups / delete-proxy-groups\n# 其它字段 deep-merge\n";
  }
  fs.writeFileSync(path.join(profilesDir, file), content, "utf8");
  const item = {
    uid,
    name: safe,
    type: kind,
    url: null,
    enabled: true,
    global: !!global,
    updatedAt: nowMs(),
    file,
    size: Buffer.byteLength(content, "utf8"),
  };
  const idx = loadIndex(profilesDir);
  idx.items.push(item);
  saveIndex(profilesDir, idx);
  return item;
}

/** 订阅级绑定：主配置绑定专用 Merge/Script uid */
function setProfileBinds(profilesDir, uid, binds) {
  const idx = loadIndex(profilesDir);
  const item = idx.items.find((x) => x.uid === uid);
  if (!item) throw new Error("配置不存在");
  if (item.type !== "remote" && item.type !== "local") {
    throw new Error("只能给 Remote/Local 绑定扩展");
  }
  item.binds = {
    merge: binds?.merge || null,
    script: binds?.script || null,
    rules: binds?.rules || null,
    proxies: binds?.proxies || null,
    groups: binds?.groups || null,
  };
  saveIndex(profilesDir, idx);
  return item;
}

function setEnabled(profilesDir, uid, enabled) {
  const idx = loadIndex(profilesDir);
  const item = idx.items.find((x) => x.uid === uid);
  if (!item) throw new Error("配置不存在");
  item.enabled = !!enabled;
  saveIndex(profilesDir, idx);
  return idx;
}

function setActive(profilesDir, uid) {
  const idx = loadIndex(profilesDir);
  const item = idx.items.find((x) => x.uid === uid);
  if (!item) throw new Error("配置不存在");
  if (item.type !== "remote" && item.type !== "local") {
    throw new Error("只能激活 Remote / Local 主配置");
  }
  idx.active = uid;
  saveIndex(profilesDir, idx);
  return idx;
}

function deleteProfile(profilesDir, uid) {
  const idx = loadIndex(profilesDir);
  const pos = idx.items.findIndex((x) => x.uid === uid);
  if (pos < 0) return;
  const [item] = idx.items.splice(pos, 1);
  try {
    fs.unlinkSync(path.join(profilesDir, item.file));
  } catch {}
  if (idx.active === uid) {
    const next = idx.items.find((x) => x.type === "remote" || x.type === "local");
    idx.active = next ? next.uid : null;
  }
  saveIndex(profilesDir, idx);
}

function readContent(profilesDir, uid) {
  const idx = loadIndex(profilesDir);
  const item = idx.items.find((x) => x.uid === uid);
  if (!item) throw new Error("配置不存在");
  return fs.readFileSync(path.join(profilesDir, item.file), "utf8");
}

function writeContent(profilesDir, uid, content) {
  if (typeof content !== "string") throw new Error("配置内容必须是文本");
  const idx = loadIndex(profilesDir);
  const item = idx.items.find((x) => x.uid === uid);
  if (!item) throw new Error("配置不存在");
  fs.writeFileSync(path.join(profilesDir, item.file), content, "utf8");
  item.updatedAt = nowMs();
  item.size = Buffer.byteLength(content, "utf8");
  saveIndex(profilesDir, idx);
}

// 按 URL 原地更新远程订阅：同 URL 只保留一份档案，其余重复项连同文件一起清理
// （修复：每次更新订阅都新建档案，文件名层层叠加越积越多）
function updateRemoteByUrl(profilesDir, url, content) {
  const idx = loadIndex(profilesDir);
  const dups = idx.items.filter((x) => x.type === "remote" && x.url && x.url === url);
  if (!dups.length) return null;
  // 优先保留当前激活的；未激活时保留最新更新的
  const sorted = [...dups].sort(
    (a, b) => (b.uid === idx.active ? 1 : 0) - (a.uid === idx.active ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0)
  );
  const keep = sorted[0];
  writeContent(profilesDir, keep.uid, content);
  for (const dup of sorted.slice(1)) {
    try {
      deleteProfile(profilesDir, dup.uid);
    } catch {}
  }
  const out = loadIndex(profilesDir);
  return out.items.find((x) => x.uid === keep.uid) || keep;
}

function activeMainText(profilesDir, runtimePath) {
  const idx = loadIndex(profilesDir);
  if (idx.active) {
    const item = idx.items.find((x) => x.uid === idx.active);
    if (item && (item.type === "remote" || item.type === "local")) {
      return fs.readFileSync(path.join(profilesDir, item.file), "utf8");
    }
  }
  if (fs.existsSync(runtimePath)) return fs.readFileSync(runtimePath, "utf8");
  return "";
}

/** 旧版把文件名（`<uid>_subscription.yaml`）当展示名，这里判断是否需要换成可读名 */
function isLegacyDisplayName(name) {
  const s = String(name || "");
  return !s || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s) || /\.ya?ml$/i.test(s) || /^subscription$/i.test(s);
}

/**
 * 按订阅 URL 改档案展示名。只写 index 里的 name，不动 file —— 文件名是内部标识，
 * 改名不能造成「索引指向的文件不存在」。默认只迁移旧式名字，用户自定义名保持不变。
 */
function renameByUrl(profilesDir, url, name, opts = {}) {
  if (!url || !name) return null;
  const idx = loadIndex(profilesDir);
  const item = idx.items.find((x) => x.type === "remote" && x.url === url);
  if (!item) return null;
  const safe = sanitizeName(name);
  if (item.name === safe) return item;
  if (!opts.force && !isLegacyDisplayName(item.name)) return item;
  item.name = safe;
  saveIndex(profilesDir, idx);
  return item;
}

function migrateLegacyFiles(profilesDir) {
  // 把旧扁平 yaml 扫进 index（仅当 index 为空）
  const idx = loadIndex(profilesDir);
  if (idx.items.length) return idx;
  if (!fs.existsSync(profilesDir)) return idx;
  const files = fs.readdirSync(profilesDir).filter((f) => /\.(ya?ml)$/i.test(f) && f !== "index.json");
  for (const f of files) {
    const uid = crypto.randomUUID();
    const name = sanitizeName(f);
    const newFile = `${uid}_${name}.yaml`;
    const src = path.join(profilesDir, f);
    const dst = path.join(profilesDir, newFile);
    if (src !== dst) {
      try {
        fs.renameSync(src, dst);
      } catch {
        fs.copyFileSync(src, dst);
      }
    }
    const size = fs.statSync(dst).size;
    idx.items.push({
      uid,
      name,
      type: "local",
      url: null,
      enabled: true,
      global: false,
      updatedAt: nowMs(),
      file: newFile,
      size,
    });
  }
  if (idx.items[0]) idx.active = idx.items[0].uid;
  if (idx.items.length) saveIndex(profilesDir, idx);
  return idx;
}

module.exports = {
  loadIndex,
  saveIndex,
  listRich,
  importLocal,
  createEnhance,
  setEnabled,
  setActive,
  deleteProfile,
  readContent,
  writeContent,
  updateRemoteByUrl,
  activeMainText,
  migrateLegacyFiles,
  sanitizeName,
  setProfileBinds,
  renameByUrl,
  isLegacyDisplayName,
};
