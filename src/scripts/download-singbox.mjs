// FoxVey · 按需下载 sing-box 内核（实验性第二内核）
// 命名规则：sing-box-1.12.0-windows-amd64.zip（版本号不带 v），内含 sing-box.exe
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync, execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
// 与 download-mihomo.mjs 同理：打包后由主进程通过 VEYRA_BIN_DIR 指定输出目录
const binDir = process.env.VEYRA_BIN_DIR ? join(process.env.VEYRA_BIN_DIR) : join(root, "resources", "bin");
const isWin = process.platform === "win32";
const exeName = isWin ? "sing-box.exe" : "sing-box";
const target = join(binDir, exeName);
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const FALLBACK_TAG = "v1.14.3";
const buildTagPath = join(binDir, "core-singbox.txt");

if (existsSync(target)) {
  console.log("[foxvey] sing-box already present:", target);
  process.exit(0);
}

mkdirSync(binDir, { recursive: true });

const archMap = { x64: "amd64", arm64: "arm64", ia32: "386" };
const goos = isWin ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
const goarch = archMap[process.arch] || "amd64";
const asset = `sing-box-${goos}-${goarch}`;

function psDownload(url, dest) {
  const proxyLine = PROXY
    ? `$proxy = '${PROXY.replace(/'/g, "''")}'; Invoke-WebRequest -Uri '${url}' -OutFile '${dest.replace(/'/g, "''")}' -Proxy $proxy -UseBasicParsing`
    : `Invoke-WebRequest -Uri '${url}' -OutFile '${dest.replace(/'/g, "''")}' -UseBasicParsing`;
  const script = `
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
${proxyLine}
`;
  execFileSync("powershell", ["-NoProfile", "-Command", script], { stdio: "inherit" });
}

function getTag() {
  try {
    const proxyArg = PROXY ? `-Proxy '${PROXY.replace(/'/g, "''")}'` : "";
    const script = `
$ProgressPreference = 'SilentlyContinue'
$r = Invoke-WebRequest -Uri 'https://api.github.com/repos/SagerNet/sing-box/releases/latest' ${proxyArg} -Headers @{ 'User-Agent'='foxvey' } -UseBasicParsing
($r.Content | ConvertFrom-Json).tag_name
`;
    const tag = execFileSync("powershell", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
    }).trim();
    if (/^v?\d/.test(tag)) return tag.startsWith("v") ? tag : `v${tag}`;
  } catch (e) {
    console.warn("[foxvey] tag lookup failed, use", FALLBACK_TAG, e.message);
  }
  return FALLBACK_TAG;
}

// sing-box 的 zip 带顶层目录（如 sing-box-1.14.3-windows-amd64/sing-box.exe），递归找
function findExeRecursive(dir, skip) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  const skipLow = String(skip || "").toLowerCase();
  for (const f of entries) {
    const p = join(dir, f.name);
    if (p.toLowerCase() === skipLow) continue;
    if (f.isFile() && /^sing-box\.exe$/i.test(f.name)) return p;
    if (f.isDirectory()) {
      const r = findExeRecursive(p, skip);
      if (r) return r;
    }
  }
  return "";
}

function tryVersion(exe) {  try {
    const out = execFileSync(exe, ["version"], { encoding: "utf8", timeout: 15000, windowsHide: true }).trim();
    return /sing-box/i.test(out) ? out.split("\n")[0].trim() : null;
  } catch {
    return null;
  }
}

function main() {
  console.log("[foxvey] downloading sing-box", PROXY ? `via ${PROXY}` : "(direct)");
  const tag = getTag();
  const bare = tag.replace(/^v/, "");
  const ext = isWin ? "zip" : "tar.gz";
  // 注意顺序和 mihomo 相反：sing-box-1.14.3-windows-amd64.zip（版本在中段且不带 v）
  const filename = `sing-box-${bare}-${goos}-${goarch}.${ext}`;
  const url = `https://github.com/SagerNet/sing-box/releases/download/${tag}/${filename}`;
  const archive = join(binDir, filename);
  const stage = join(binDir, isWin ? "singbox-stage.exe" : "singbox-stage");
  console.log("[foxvey]", url);
  try {
    if (existsSync(stage)) unlinkSync(stage);
  } catch {}
  try {
    psDownload(url, archive);
  } catch (e) {
    try {
      if (existsSync(archive)) unlinkSync(archive);
    } catch {}
    throw e;
  }

  if (isWin) {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${binDir.replace(/'/g, "''")}' -Force"`,
      { stdio: "inherit" }
    );
    try {
      unlinkSync(archive);
    } catch {}
    const found = findExeRecursive(binDir, stage);
    if (!found) throw new Error("sing-box binary missing after extract");
    if (found.toLowerCase() !== stage.toLowerCase()) renameSync(found, stage);
    // 清掉解压出来的顶层目录（LICENSE 等杂物）
    for (const f of readdirSync(binDir, { withFileTypes: true })) {
      if (f.isDirectory() && /^sing-box-[\d]/.test(f.name)) {
        try {
          execSync(`powershell -NoProfile -Command "Remove-Item -LiteralPath '${join(binDir, f.name).replace(/'/g, "''")}' -Recurse -Force"`, { stdio: "ignore" });
        } catch {}
      }
    }
  } else {
    execSync(`tar -xzf "${archive}" -C "${binDir}"`, { stdio: "inherit", shell: true });
    try {
      unlinkSync(archive);
    } catch {}
    const files = readdirSync(binDir, { recursive: true });
    const found = files.find((f) => /(^|\/)sing-box$/.test(String(f).replace(/\\/g, "/")));
    if (!found) throw new Error("sing-box binary missing after extract");
    renameSync(join(binDir, found), stage);
    execSync(`chmod +x "${stage}"`);
  }

  const ver = tryVersion(stage);
  if (!ver) {
    try {
      if (existsSync(stage)) unlinkSync(stage);
    } catch {}
    throw new Error("downloaded sing-box cannot run on this machine");
  }
  renameSync(stage, target);
  try {
    writeFileSync(buildTagPath, `${filename} ${tag}\n${ver}\n`, "utf8");
  } catch {}

  for (const f of readdirSync(binDir)) {
    if (f === "core-singbox.txt" || f === "core-mihomo.txt") continue;
    if (f.endsWith(".zip") || f.endsWith(".gz") || (f.endsWith(".txt") && f !== exeName)) {
      try {
        unlinkSync(join(binDir, f));
      } catch {}
    }
  }
  console.log("[foxvey] ready:", target, `(${filename})`);
}

try {
  main();
} catch (e) {
  console.error("[foxvey] download failed:", e.message || e);
  process.exit(1);
}
