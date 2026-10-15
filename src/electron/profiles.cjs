const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function nowMs() {
  return Date.now();
}

function sanitizeName(name) {
  const s = String(name || "profile")
    .trim()
    .replace(/[/\\:*?"<>|]/g, "_");
  return (
    s
      .replace(/\.ya?ml$/i, "")
      .replace(/\.js$/i, "")
      .slice(0, 64) || "profile"
  );
}

function loadIndex(profilesDir) {
  const p = path.join(profilesDir, "index.json");
  if (!fs.existsSync(p)) return { items: [], active: null };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!raw || !Array.isArray(raw.items)) return { items: [], active: null };
    return { items: raw.items, active: raw.active || null };
  } catch {
    return { items: [], active: null };
  }
}

function saveIndex(profilesDir, idx) {
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(path.join(profilesDir, "index.json"), JSON.stringify(idx, null, 2), "utf8");
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
};
