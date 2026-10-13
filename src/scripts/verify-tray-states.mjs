import sharp from "sharp";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = process.argv[2]
  ? join(process.argv[2], "icons")
  : join(__dirname, "..", "resources", "icons");
const files = [
  [16, "tray-win-on.png", "tray-win-off.png"],
  [20, "tray-win-on-20.png", "tray-win-off-20.png"],
  [24, "tray-win-on-24.png", "tray-win-off-24.png"],
  [32, "tray-win-on@2x.png", "tray-win-off@2x.png"],
  [48, "tray-win-on-48.png", "tray-win-off-48.png"],
  [64, "tray-win-on-64.png", "tray-win-off-64.png"],
  [128, "tray-win-on-128.png", "tray-win-off-128.png"],
];

function countColors(data) {
  let green = 0;
  let red = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = data.subarray(i, i + 4);
    if (a < 200) continue;
    if (g > 100 && g > r * 1.22 && g > b * 1.1) green++;
    if (r > 180 && r > g * 1.25 && r > b * 1.25) red++;
  }
  return { green, red };
}

let failed = false;
for (const [size, onName, offName] of files) {
  const onPath = join(iconsDir, onName);
  const offPath = join(iconsDir, offName);
  const [onMeta, offMeta] = await Promise.all([sharp(onPath).metadata(), sharp(offPath).metadata()]);
  const onRaw = await sharp(onPath).ensureAlpha().raw().toBuffer();
  const offRaw = await sharp(offPath).ensureAlpha().raw().toBuffer();
  const on = countColors(onRaw);
  const off = countColors(offRaw);
  const ok = onMeta.width === size && onMeta.height === size
    && offMeta.width === size && offMeta.height === size
    && on.green > 0 && off.green === 0 && off.red > 0;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${String(size).padStart(3)}px: connected green=${on.green}, disconnected red=${off.red}, disconnected green=${off.green}`
  );
  if (!ok) failed = true;
}
if (failed) process.exitCode = 1;
else console.log("PASS 全尺寸状态标记明确：连接只有绿点，未连接有红叉且无绿色状态点");
