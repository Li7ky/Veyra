/**
 * Veyra 图标生成（v5 · 2026-10-12）
 *
 * 变更：整体弃用狐狸素材，改为直接渲染界面内使用的「六边形品牌标」
 * （几何形状与 App.tsx 顶部 brand 区那个 SVG 完全一致），
 * 应用图标 / 窗口图标 / 任务栏 / favicon / 托盘 全部统一为同一枚 logo。
 *
 * 好处：
 *   1) 不再依赖工作区里的外部源图（原 `图标1.png` 丢失会导致 build-icons 直接中断）；
 *   2) 图标与界面品牌标 100% 一致，矢量渲染，任意尺寸都不糊；
 *   3) 托盘只放 logo 本身，不带状态角标（按需求）。
 *
 * 品牌锚点色 #2c71e8（皇家蓝）来自 src/styles.css 的 --blue-500。
 */
import sharp from "sharp";
import pngToIco from "png-to-ico";
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const outDir = join(root, "resources", "icons");
mkdirSync(outDir, { recursive: true });

// ── 品牌参数 ────────────────────────────────────────────────
const BRAND_BLUE = "#2c71e8"; // 品牌锚点色（--blue-500）
const BRAND_BLUE_DARK = "#1d5bcc"; // --blue-600，渐变收尾
const BRAND_BLUE_LIGHT = "#3b82f6"; // 渐变起点，比锚点略亮，让方块有体积感
const TILE_RADIUS_RATIO = 0.22; // 圆角半径 / 边长（现代 App 图标档位）
const MARK_SCALE = 0.68; // 六边形标占画布比例（含留白）
const MARK_STROKE = 3.1; // 24 单位视口下的描边宽度。
// 界面里用的是 2，但图标要缩到 16px —— 2 会细成 1.3px 糊掉，
// 这里按「光学尺寸」加粗到 3.1，保证 16px 下六边形轮廓依然立得住。
const MASTER = 1024;

/** 与 App.tsx brand 区完全一致的六边形标几何（24×24 视口，stroke-only） */
const MARK_GEOMETRY = `
  <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/>
  <line x1="12" y1="22" x2="12" y2="15.5"/>
  <polyline points="22 8.5 12 15.5 2 8.5"/>
  <polyline points="2 15.5 12 8.5 22 15.5"/>
  <line x1="12" y1="2" x2="12" y2="8.5"/>
`;

function logoSvg(size = MASTER) {
  const r = Math.round(size * TILE_RADIUS_RATIO);
  // 24 单位视口 → 画布：先平移到中心，再按 MARK_SCALE 缩放，最后把视口中心 (12,12) 挪回原点
  const scale = (size * MARK_SCALE) / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BRAND_BLUE_LIGHT}"/>
      <stop offset="0.55" stop-color="${BRAND_BLUE}"/>
      <stop offset="1" stop-color="${BRAND_BLUE_DARK}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="url(#tile)"/>
  <g transform="translate(${size / 2} ${size / 2}) scale(${scale.toFixed(6)}) translate(-12 -12)"
     fill="none" stroke="#ffffff" stroke-width="${MARK_STROKE}"
     stroke-linecap="round" stroke-linejoin="round">
    ${MARK_GEOMETRY}
  </g>
</svg>`;
}

// ── 主母版 ──────────────────────────────────────────────────
const masterBuf = await sharp(Buffer.from(logoSvg(MASTER)), { density: 384 })
  .png({ compressionLevel: 9 })
  .toBuffer();
writeFileSync(join(outDir, "icon-master.png"), masterBuf);
console.log(`[icons] logo master rendered ${MASTER}×${MASTER} (hexagon brand mark, no fox)`);

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

const pngBuffers = {};
for (const size of sizes) {
  const buf = await sharp(masterBuf)
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    // 小尺寸补一点锐化，抵消缩放导致的描边发灰
    .sharpen(size <= 24 ? { sigma: 0.8, m1: 1.2, m2: 2.6 } : { sigma: 0.9, m1: 0.7, m2: 1.8 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(join(outDir, `icon-${size}.png`), buf);
  pngBuffers[size] = buf;
}
console.log("[icons] wrote", sizes.map((s) => `icon-${s}.png`).join(", "));

writeFileSync(join(outDir, "icon.png"), pngBuffers[512]);

// ── 托盘图标 ────────────────────────────────────────────────
// 与软件图标同一枚 logo。托盘尺寸档位保持不变（main.cjs 按屏幕 DPI 选取）。
// 注意：按需求不带状态角标，on / off 两态文件内容相同 —— 托盘不再体现连接状态。
const TRAY_SIZES = [
  { px: 16, suffix: "" }, // scaleFactor 1
  { px: 20, suffix: "-20" }, // 1.25
  { px: 24, suffix: "-24" }, // 1.5
  { px: 32, suffix: "@2x" }, // 2
];
const TRAY_WIN_SIZES = [
  ...TRAY_SIZES,
  { px: 48, suffix: "-48" },
  { px: 64, suffix: "-64" },
  { px: 128, suffix: "-128" },
];

async function writeTray(name, size) {
  const out = await sharp(masterBuf)
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .sharpen(size <= 24 ? { sigma: 0.8, m1: 1.3, m2: 2.8 } : { sigma: 0.9, m1: 0.7, m2: 1.8 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(join(outDir, name), out);
  return out;
}

let tray16;
let tray32;
for (const state of ["on", "off"]) {
  for (const { px, suffix } of TRAY_SIZES) {
    const buf = await writeTray(`tray-${state}${suffix}.png`, px);
    if (state === "on" && px === 16) tray16 = buf;
    if (state === "on" && px === 32) tray32 = buf;
  }
}
writeFileSync(join(outDir, "tray.png"), tray16);
writeFileSync(join(outDir, "tray@2x.png"), tray32);
console.log("[icons] wrote tray-on / tray-off (16/20/24/32, logo only)");

for (const state of ["on", "off"]) {
  for (const { px, suffix } of TRAY_WIN_SIZES) {
    await writeTray(`tray-win-${state}${suffix}.png`, px);
  }
}
console.log("[icons] wrote tray-win-on / tray-win-off (16/20/24/32/48/64/128)");

// ── ICO / favicon / 前端侧栏用图 ─────────────────────────────
const ico = await pngToIco(icoSizes.map((s) => pngBuffers[s]));
writeFileSync(join(outDir, "icon.ico"), ico);
console.log("[icons] wrote icon.ico");

const pubDir = join(root, "public");
mkdirSync(pubDir, { recursive: true });
writeFileSync(join(pubDir, "favicon.png"), pngBuffers[32]);
writeFileSync(join(pubDir, "favicon-192.png"), pngBuffers[128]);
writeFileSync(join(pubDir, "app-icon.png"), pngBuffers[256]);

const assetsDir = join(root, "src", "assets");
mkdirSync(assetsDir, { recursive: true });
writeFileSync(join(assetsDir, "app-icon.png"), pngBuffers[256]);
console.log("[icons] wrote public/favicon*.png + src/assets/app-icon.png");

console.log("[icons] done →", outDir);
