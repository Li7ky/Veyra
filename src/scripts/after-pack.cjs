/**
 * electron-builder afterPack 钩子：给 Windows 主程序写入品牌图标（六边形 logo）与版本信息。
 *
 * 为什么不用 signAndEditExecutable：
 *   它会调用 winCodeSign 包里的 rcedit，而 winCodeSign-2.6.0.7z 内含 macOS 符号链接，
 *   在没有开发者模式/管理员权限的 Windows 上解压会报
 *   "Cannot create symbolic link ... libcrypto.dylib"，使整个打包失败。
 *   因此这里改为直接调用项目内置的 rcedit（scripts/bin/rcedit-x64.exe）。
 *
 * 注意：rcedit 必须在 electron-builder 完成 asar integrity 资源写入之后再运行，
 *   afterPack 阶段刚好满足该顺序。
 */
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

/** 异步执行 rcedit。
 *  这里必须用异步 spawn：部分受限/沙箱环境下同步 execFileSync 会直接 EBUSY，
 *  而异步 execFile 正常（已实测）。 */
function runRcedit(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.detail = [stdout?.toString(), stderr?.toString()].filter(Boolean).join("\n");
        reject(err);
        return;
      }
      resolve();
    });
  });
}

function resolveRcedit() {
  const local = path.join(__dirname, "bin", "rcedit-x64.exe");
  if (fs.existsSync(local)) return local;
  // 回退：从 electron-builder 缓存里找一份
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || "",
    "electron-builder",
    "Cache",
    "winCodeSign"
  );
  if (fs.existsSync(cacheRoot)) {
    for (const dir of fs.readdirSync(cacheRoot)) {
      const candidate = path.join(cacheRoot, dir, "rcedit-x64.exe");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const appInfo = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  const iconPath = path.join(__dirname, "..", "resources", "icons", "icon.ico");

  if (!fs.existsSync(exePath)) {
    throw new Error(`[after-pack] 未找到主程序：${exePath}`);
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`[after-pack] 未找到图标：${iconPath}`);
  }

  const rcedit = resolveRcedit();
  if (!rcedit) {
    throw new Error("[after-pack] 未找到 rcedit-x64.exe，无法写入 exe 图标");
  }

  const version = appInfo.version || "1.0.0";
  const args = [
    exePath,
    "--set-icon",
    iconPath,
    "--set-version-string",
    "ProductName",
    appInfo.productName || "Veyra",
    "--set-version-string",
    "FileDescription",
    appInfo.productName || "Veyra",
    "--set-version-string",
    "InternalName",
    appInfo.productFilename || "Veyra",
    "--set-version-string",
    "OriginalFilename",
    `${appInfo.productFilename || "Veyra"}.exe`,
    "--set-version-string",
    "CompanyName",
    "Veyra",
    "--set-version-string",
    "LegalCopyright",
    appInfo.copyright || "Copyright © Veyra",
    "--set-file-version",
    version,
    "--set-product-version",
    version,
  ];

  try {
    await runRcedit(rcedit, args);
    console.log(`[after-pack] 已写入品牌图标与版本信息：${exePath}`);
  } catch (err) {
    throw new Error(
      `[after-pack] rcedit 执行失败（若程序正在运行请先退出）：${err.message}\n${err.detail || ""}`
    );
  }
};
