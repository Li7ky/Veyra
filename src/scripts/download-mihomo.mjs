import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync, execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
// 打包后脚本会被复制到 resources/scripts 下运行，靠相对路径推断输出目录会落到错误位置；
// 由调用方（主进程）通过 VEYRA_BIN_DIR 指定真正的 bin 目录。
const binDir = process.env.VEYRA_BIN_DIR ? join(process.env.VEYRA_BIN_DIR) : join(root, "resources", "bin");
const isWin = process.platform === "win32";
const exeName = isWin ? "mihomo.exe" : "mihomo";
const target = join(binDir, exeName);
// 仅使用环境变量代理；未设置则直连（不绑定其它软件端口）
const PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const FALLBACK_TAG = "v1.19.15";

if (existsSync(target)) {
  console.log("[foxvey] mihomo already present:", target);
  process.exit(0);
}

mkdirSync(binDir, { recursive: true });

const archMap = { x64: "amd64", arm64: "arm64", ia32: "386" };
const goos = isWin ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
const goarch = archMap[process.arch] || "amd64";
// Windows amd64 按顺序候选：标准版（x86-64-v3，AVX2 硬件加速，加解密更快、CPU 占用更低）优先，
// 下载后先试跑 `mihomo -v`，旧 CPU 跑不起来再回落 compatible，避免 0xC0000005 崩溃。
// 这就是「自动匹配适合这台电脑的内核」。
const candidates =
  isWin && goarch === "amd64"
    ? [`mihomo-windows-amd64`, `mihomo-windows-amd64-compatible`]
    : [`mihomo-${goos}-${goarch}`];
// 记录本次选中的构建，供界面显示「标准版 / 兼容版」（-v 输出里区分不出来，只能下载时记录）
const buildTagPath = join(binDir, "core-mihomo.txt");
const stageExe = join(binDir, isWin ? "mihomo-stage.exe" : "mihomo-stage");

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
  // MIHOMO_CHANNEL=alpha → 取最新 prerelease；stable → latest
  const channel = String(process.env.MIHOMO_CHANNEL || "stable").toLowerCase();
  try {
    const proxyArg = PROXY ? `-Proxy '${PROXY.replace(/'/g, "''")}'` : "";
    const api =
      channel === "alpha"
        ? "https://api.github.com/repos/MetaCubeX/mihomo/releases?per_page=20"
        : "https://api.github.com/repos/MetaCubeX/mihomo/releases/latest";
    const script =
      channel === "alpha"
        ? `
$ProgressPreference = 'SilentlyContinue'
$r = Invoke-WebRequest -Uri '${api}' ${proxyArg} -Headers @{ 'User-Agent'='foxvey' } -UseBasicParsing
$arr = $r.Content | ConvertFrom-Json
$pre = $arr | Where-Object { $_.prerelease -eq $true } | Select-Object -First 1
if (-not $pre) { $pre = $arr | Select-Object -First 1 }
$pre.tag_name
`
        : `
$ProgressPreference = 'SilentlyContinue'
$r = Invoke-WebRequest -Uri '${api}' ${proxyArg} -Headers @{ 'User-Agent'='foxvey' } -UseBasicParsing
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

function fetchAsset(asset, tag, destExe) {
  const ext = isWin ? "zip" : "gz";
  const filename = `${asset}-${tag}.${ext}`;
  const url = `https://github.com/MetaCubeX/mihomo/releases/download/${tag}/${filename}`;
  const archive = join(binDir, filename);
  console.log("[foxvey]", url);
  psDownload(url, archive);

  if (isWin) {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${binDir.replace(/'/g, "''")}' -Force"`,
      { stdio: "inherit" }
    );
    try {
      unlinkSync(archive);
    } catch {}
    const files = readdirSync(binDir);
    const found = files.find(
      (f) => /mihomo/i.test(f) && f.toLowerCase().endsWith(".exe") && join(binDir, f) !== destExe
    );
    if (!found) throw new Error("mihomo binary missing after extract");
    if (join(binDir, found) !== destExe) renameSync(join(binDir, found), destExe);
  } else {
    execSync(`gzip -dc "${archive}" > "${destExe}"`, { stdio: "inherit", shell: true });
    execSync(`chmod +x "${destExe}"`);
    try {
      unlinkSync(archive);
    } catch {}
  }
}

// 在这台机器上实际跑一下 -v，能跑才算可用（旧 CPU 跑标准版会直接崩溃）
function tryVersion(exe) {
  try {
    return execFileSync(exe, ["-v"], { encoding: "utf8", timeout: 15000, windowsHide: true }).trim();
  } catch {
    return null;
  }
}
function main() {
  console.log("[foxvey] downloading mihomo", PROXY ? `via ${PROXY}` : "(direct)");
  const tag = getTag();
  let picked = "";
  let pickedVer = "";
  for (const asset of candidates) {
    try {
      if (existsSync(stageExe)) unlinkSync(stageExe);
    } catch {}
    try {
      fetchAsset(asset, tag, stageExe);
    } catch (e) {
      console.warn("[foxvey] fetch failed:", asset, e.message || e);
      continue;
    }
    const ver = tryVersion(stageExe);
    if (ver) {
      picked = asset;
      pickedVer = String(ver).split("\n")[0].trim();
      break;
    }
    console.warn("[foxvey] binary cannot run on this CPU, trying next:", asset);
    try {
      if (existsSync(stageExe)) unlinkSync(stageExe);
    } catch {}
  }

  if (!picked) {
    console.error("[foxvey] no usable mihomo build for this machine");
    process.exit(1);
  }
  try {
    renameSync(stageExe, target);
  } catch {
    copyFileSync(stageExe, target);
    try {
      unlinkSync(stageExe);
    } catch {}
  }
  try {
    writeFileSync(buildTagPath, `${picked} ${tag}\n${pickedVer}\n`, "utf8");
  } catch {}

  // cleanup leftover gz/zip/txt（core-*.txt 保留，界面要读）
  for (const f of readdirSync(binDir)) {
    if (f === "core-mihomo.txt" || f === "core-singbox.txt") continue;
    if (f.endsWith(".zip") || f.endsWith(".gz") || f.endsWith(".txt")) {
      try {
        unlinkSync(join(binDir, f));
      } catch {}
    }
  }

  console.log("[foxvey] ready:", target, `(${picked} ${tag})`);
}

try {
  main();
} catch (e) {
  console.error("[foxvey] download failed:", e.message || e);
  process.exit(1);
}
