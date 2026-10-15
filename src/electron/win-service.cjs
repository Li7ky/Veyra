/**
 * Windows 正式服务模式：通过提升权限的 sc.exe 注册 VeyraCore 服务
 */
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SERVICE_NAME = "VeyraCore";

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 90000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function elevatedPowershell(script) {
  const tmp = path.join(os.tmpdir(), `veyra-svc-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, script, "utf8");
  const launcher = `
$p = Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${tmp.replace(/'/g, "''")}') -Wait -PassThru
exit $p.ExitCode
`;
  const enc = Buffer.from(launcher, "utf16le").toString("base64");
  return run("powershell.exe", ["-NoProfile", "-EncodedCommand", enc]).finally(() => {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  });
}

async function installService({ binPath, workDir, configFile }) {
  if (process.platform !== "win32") throw new Error("仅 Windows");
  if (!fs.existsSync(binPath)) throw new Error("内核不存在");
  const bin = binPath.replace(/"/g, "");
  const wd = workDir.replace(/"/g, "");
  const cfg = configFile.replace(/"/g, "");
  // binPath 含参数时 sc 需要整体引号转义
  const binPathArg = `\\"${bin}\\" -d \\"${wd}\\" -f \\"${cfg}\\"`;
  const script = `
$ErrorActionPreference = 'Stop'
$svc = Get-Service -Name '${SERVICE_NAME}' -ErrorAction SilentlyContinue
if ($svc) {
  Stop-Service '${SERVICE_NAME}' -Force -ErrorAction SilentlyContinue
  sc.exe delete ${SERVICE_NAME} | Out-Null
  Start-Sleep -Seconds 1
}
New-Item -ItemType Directory -Force -Path '${wd.replace(/'/g, "''")}' | Out-Null
sc.exe create ${SERVICE_NAME} binPath= "${binPathArg}" start= auto DisplayName= "Veyra Core Service" | Out-Null
sc.exe description ${SERVICE_NAME} "Veyra mihomo/sing-box elevated service for TUN" | Out-Null
Start-Service ${SERVICE_NAME} -ErrorAction SilentlyContinue
'OK'
`;
  await elevatedPowershell(script);
  return { ok: true, name: SERVICE_NAME };
}

async function uninstallService() {
  if (process.platform !== "win32") return { ok: true };
  const script = `
$svc = Get-Service -Name '${SERVICE_NAME}' -ErrorAction SilentlyContinue
if ($svc) {
  Stop-Service '${SERVICE_NAME}' -Force -ErrorAction SilentlyContinue
  sc.exe delete ${SERVICE_NAME} | Out-Null
}
'OK'
`;
  try {
    await elevatedPowershell(script);
  } catch {}
  return { ok: true };
}

async function serviceStatus() {
  if (process.platform !== "win32") return { installed: false, running: false };
  try {
    const r = await run("sc.exe", ["query", SERVICE_NAME]);
    const installed = /SERVICE_NAME:\s*VeyraCore/i.test(r.stdout);
    const running = /RUNNING/i.test(r.stdout);
    return { installed, running };
  } catch {
    return { installed: false, running: false };
  }
}

module.exports = { installService, uninstallService, serviceStatus, SERVICE_NAME };