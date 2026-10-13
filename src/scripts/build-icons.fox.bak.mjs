import sharp from "sharp";
import pngToIco from "png-to-ico";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const workspace = join(root, "..");

function findSource() {
  // 注意：工作区里的 `图标.png` 实际是一张海贼王壁纸，不是图标素材，已从候选剔除；
  // 若将来手工放了别的图，务必先确认再写进优先级列表。
  const candidates = [
    join(workspace, "图标1.png"),
    join(workspace, "动漫风格代理软件图标设计.png"),
    join(workspace, "代理软件图标设计.png"),
    ...readdirSync(workspace)
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .map((f) => join(workspace, f)),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error("未找到源图片（请把图标放在 代理软件/ 图标.png）");
}

const outDir = join(root, "resources", "icons");
mkdirSync(outDir, { recursive: true });

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

const src = findSource();
console.log("[icons] source:", src);

const meta = await sharp(src).metadata();
const w = meta.width || 0;
const h = meta.height || 0;
const side = Math.min(w, h);
const left = Math.floor((w - side) / 2);
const top = Math.floor((h - side) / 2);
console.log(`[icons] ${w}x${h} → center-crop ${side}x${side} (no stretch)`);

// 正方形母版（居中裁切，不拉伸）
const square = sharp(src)
  .extract({ left, top, width: side, height: side })
  .png({ compressionLevel: 9, adaptiveFiltering: true });

const masterPath = join(outDir, "icon-master.png");
await square.toFile(masterPath);

const pngBuffers = {};
for (const size of sizes) {
  const buf = await sharp(masterPath)
    .resize(size, size, {
      fit: "fill", // 已是正方形，fill 不会变形
      kernel: sharp.kernel.lanczos3,
    })
    .png({ compressionLevel: 9 })
    .toBuffer();
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, buf);
  pngBuffers[size] = buf;
  console.log("[icons] wrote", `icon-${size}.png`);
}

// 主图标 / 窗口图标
writeFileSync(join(outDir, "icon.png"), pngBuffers[512]);
writeFileSync(join(outDir, "icon-256.png"), pngBuffers[256]);

// 托盘母版（v4，2026-10-09 晚定稿）：
// 优先读可选的自定义母版 代理软件/托盘狐狸.png（存在时须为满出血圆构图，直接缩 512）；
// 否则从主图 图标1.png 裁「脸部特写」（crop 0.40），走「亮色·锐化链」：
//   饱和1.1 → 清晰度锐化(σ5) → 五官微加粗(0.4) → 轻轮廓暗晕(0.32, σ12)
// 关键教训：托盘母版必须来自 1536² 原图；用低分辨率截图当母版 → 全尺寸发糊（2026-10-09 踩坑）。
const trayFlatPath = join(workspace, "托盘狐狸.png");
let traySrc;
let traySourceNote;
if (existsSync(trayFlatPath)) {
  traySrc = await sharp(trayFlatPath).resize(512, 512, { kernel: sharp.kernel.lanczos3 }).png().toBuffer();
  traySourceNote = "托盘狐狸.png (custom master)";
} else {
  const TRAY_CROP = { left: 0.300, top: 0.245, width: 0.400 };
  const trayRaw = await sharp(src)
    .extract({
      left: Math.round(w * TRAY_CROP.left),
      top: Math.round(h * TRAY_CROP.top),
      width: Math.round(w * TRAY_CROP.width),
      height: Math.round(Math.min(w, h) * TRAY_CROP.width),
    })
    .resize(512, 512, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
  let t = await sharp(trayRaw).modulate({ saturation: 1.1 }).png().toBuffer();
  t = await sharp(t).sharpen({ sigma: 5, m1: 0.7, m2: 0.7 }).png().toBuffer();
  t = await featureBoost(t, 0.4);
  traySrc = await addGlowShadow(t, { sigma: 12, strength: 0.32 });
  traySourceNote = `head close-up ${TRAY_CROP.width * 100}% of source (fallback)`;
}
writeFileSync(join(outDir, "tray-head-master.png"), traySrc);
console.log(`[icons] tray source: ${traySourceNote} → 512`);

/** 圆形裁切：直接改像素 alpha，半径精确可控（sharp 渲染 SVG 遮罩的尺寸不可靠） */
async function applyCircleMask(buf, size, radiusRatio = 0.47) {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * radiusRatio;
  const aa = 0.75; // 边缘抗锯齿宽度（像素）
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let k = 1;
      if (d >= r + aa) k = 0;
      else if (d > r - aa) k = (r + aa - d) / (2 * aa);
      if (k < 1) {
        const i = (y * w + x) * 4 + 3;
        data[i] = Math.round(data[i] * k);
      }
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
}

/** 状态标记 raw 像素绘制，返回 RGBA Buffer 给 overRaw 混合。
 * connected 使用绿点；disconnected 使用红牌白叉，确保 16px 下也不会认成绿点。 */
function badge(size, { fill, stroke, shape = "dot", radiusRatio, cross = "#ffffff" }) {
  const rgb = (hex) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const r = size * (radiusRatio || (size <= 24 ? 0.108 : 0.115));
  const ring = shape === "cross"
    ? Math.max(0.65, size * 0.045)
    : Math.max(0.5, size * (size <= 24 ? 0.03 : 0.032));
  const margin = size * (shape === "cross" ? 0.06 : 0.05);
  const cx = size - r - margin;
  const cy = size - r - margin;
  const fr = rgb(fill);
  const sr = rgb(stroke);
  const cr = rgb(cross);
  const px = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      const dOut = r + ring;
      let outer = 0;
      if (d <= dOut - 0.5) outer = 1;
      else if (d < dOut + 0.5) outer = dOut + 0.5 - d;
      if (outer <= 0) continue;

      // 深色描边底盘
      px[i] = sr[0];
      px[i + 1] = sr[1];
      px[i + 2] = sr[2];
      px[i + 3] = Math.round(255 * Math.min(1, outer));

      // 内圈底色
      let inner = 0;
      if (d <= r - 0.35) inner = 1;
      else if (d < r + 0.35) inner = (r + 0.35 - d) / 0.7;
      if (inner > 0) {
        px[i] = Math.round(fr[0] * inner + px[i] * (1 - inner));
        px[i + 1] = Math.round(fr[1] * inner + px[i + 1] * (1 - inner));
        px[i + 2] = Math.round(fr[2] * inner + px[i + 2] * (1 - inner));
        px[i + 3] = Math.round(255 * Math.max(outer, inner));
      }

      if (shape === "cross") {
        // 在红底上画白色 X；按对角线距离抗锯齿，16px 图标仍保留至少 3 像素长的叉。
        const half = Math.max(0.48, size * 0.038);
        const limit = r * 0.62;
        const within = Math.max(Math.abs(dx), Math.abs(dy)) <= limit;
        const crossCoverage = within
          ? Math.max(0, Math.min(1, (half + 0.35 - Math.min(Math.abs(dx - dy), Math.abs(dx + dy))) / 0.7))
          : 0;
        if (crossCoverage > 0) {
          px[i] = Math.round(cr[0] * crossCoverage + px[i] * (1 - crossCoverage));
          px[i + 1] = Math.round(cr[1] * crossCoverage + px[i + 1] * (1 - crossCoverage));
          px[i + 2] = Math.round(cr[2] * crossCoverage + px[i + 2] * (1 - crossCoverage));
          px[i + 3] = Math.max(px[i + 3], Math.round(255 * crossCoverage));
        }
      }
    }
  }
  return px;
}

/** raw RGBA 图层的 source-over 混合（top 压在 bottom 上），返回新的 raw Buffer */
function overRaw(bottom, top, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    const ta = top[o + 3] / 255;
    const ba = bottom[o + 3] / 255;
    const oa = ta + ba * (1 - ta);
    if (oa <= 0) {
      out[o + 3] = 0;
      continue;
    }
    out[o] = Math.round((top[o] * ta + bottom[o] * ba * (1 - ta)) / oa);
    out[o + 1] = Math.round((top[o + 1] * ta + bottom[o + 1] * ba * (1 - ta)) / oa);
    out[o + 2] = Math.round((top[o + 2] * ta + bottom[o + 2] * ba * (1 - ta)) / oa);
    out[o + 3] = Math.round(oa * 255);
  }
  return out;
}

/** 伽马压暗：把背景渐变整体加深（狐狸是近白像素不受影响），白狐在深蓝底上对比度大幅提升 */
async function gammaAdjust(buf, g) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, g));
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** 白色狐狸轮廓外圈加一层柔和暗晕（环 = 模糊(白掩膜) − 白掩膜），
 *  小尺寸下白脸不再糊进浅色背景，边界清晰（16px 实测有效） */
async function addGlowShadow(buf, { threshold = 212, sigma = 14, strength = 0.6, color = [10, 18, 52] } = {}) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, n = w * h;
  const mask = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const lum = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    mask[i] = lum >= threshold ? 255 : 0;
  }
  const blurred = await sharp(mask, { raw: { width: w, height: h, channels: 1 } }).blur(sigma).raw().toBuffer();
  const out = Buffer.from(data);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const ring = Math.max(0, blurred[i] / 255 - mask[i] / 255) * strength;
    if (ring <= 0.003) continue;
    out[o] = Math.round(color[0] * ring + out[o] * (1 - ring));
    out[o + 1] = Math.round(color[1] * ring + out[o + 1] * (1 - ring));
    out[o + 2] = Math.round(color[2] * ring + out[o + 2] * (1 - ring));
  }
  return sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/** 五官加粗：脸部中央区域里「偏蓝且中等亮度」的像素（眼睛/鼻子/嘴）向深蓝压深。
 *  原画五官太淡，16px 下完全糊掉；加粗后可辨认（用户反馈驱动，2026-10-09） */
async function featureBoost(buf, strength) {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const x0 = Math.round(w * 0.22), x1 = Math.round(w * 0.78);
  const y0 = Math.round(h * 0.30), y1 = Math.round(h * 0.78);
  const target = [32, 62, 150];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const o = (y * w + x) * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (b > r + 14 && lum > 95 && lum < 208) {
      data[o] = Math.round(target[0] * strength + r * (1 - strength));
      data[o + 1] = Math.round(target[1] * strength + g * (1 - strength));
      data[o + 2] = Math.round(target[2] * strength + b * (1 - strength));
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/** 生成托盘图标：脸部特写 →（可选放大主体）→ 缩放 → 正圆遮罩 → 状态点。
 * 统一使用正圆：四角完全透明，放进托盘就是一个圆，不会出现方框。
 * zoom > 1 时先居中裁掉一圈再缩放，让狐狸头占满圆面，小尺寸下更醒目。 */
async function writeTray(name, size, { greyscale, linear, overlay, zoom = 1, gamma = 1 }) {
  let src = traySrc;
  if (zoom > 1) {
    const meta = await sharp(traySrc).metadata();
    const side = Math.min(meta.width || 512, meta.height || 512);
    const inner = Math.round(side / zoom);
    const off = Math.round((side - inner) / 2);
    src = await sharp(traySrc)
      .extract({ left: off, top: off, width: inner, height: inner })
      .png()
      .toBuffer();
  }
  // 压深中间调：白狐狸不变，蓝底变深，小尺寸下对比度明显提升
  if (gamma !== 1) src = await gammaAdjust(src, gamma);
  let img = sharp(src).resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 });
  if (greyscale) {
    img = img.greyscale();
    if (linear) img = img.linear(linear[0], linear[1]);
  }
  // 小尺寸用更强的锐化补偿缩放损失（16/20/24 实测更清晰）
  img = img.sharpen(size <= 24 ? { sigma: 0.9, m1: 1.5, m2: 3.2 } : { sigma: 1.0, m1: 0.8, m2: 2.0 });
  const base = await img.png().toBuffer();
  const masked = await applyCircleMask(base, size, 0.5);

  const foxRaw = await sharp(masked).ensureAlpha().raw().toBuffer();

  // badge() 已直接返回 raw RGBA，无需再解码
  const merged = overlay ? overRaw(foxRaw, overlay, size) : foxRaw;

  const out = await sharp(merged, { raw: { width: size, height: size, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(join(outDir, name), out);
  return out;
}

// 托盘尺寸：16/20/24/32 为基础档（macOS/Linux 多 DPI 用）；Windows 额外多出 48/64/128，
// main.cjs 在 Windows 上按屏幕缩放优先取大尺寸 PNG（让系统缩放渲染，小图直接上托盘会糊）。
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
// 托盘两态：
//   已连接 = 蓝底圆 + 白狐狸 + 亮绿状态点
//   未连接 = 灰底圆 + 白狐狸 + 橙色状态点
// 关键点：
//   1) off 只做「去色 + 压深背景」，**不要把狐狸也压灰**，否则灰底灰图糊成一团。
//   2) 状态点必须换色，不能只是变浅：16px 下浅色点会被误认成绿点，
//      用户反馈「连接和未连接都有绿点分不清」，所以未连接改用橙色，与绿色强对比。
const TRAY_STYLES = {
  on: { greyscale: false, badge: { fill: "#2bff9b", stroke: "#063d22" } },
  off: {
    greyscale: true,
    linear: [0.86, 0],
    gammaBoost: 1.3, // 未连接时背景再压深一档，和已连接的蓝底拉开差距
    badge: {
      shape: "cross",
      radiusRatio: 0.17,
      fill: "#e53935",
      stroke: "#59100e",
      cross: "#ffffff",
    },
  },
};

let trayOn16;
let trayOn32;
for (const state of ["on", "off"]) {
  const style = TRAY_STYLES[state];
  for (const { px, suffix } of TRAY_SIZES) {
    const buf = await writeTray(`tray-${state}${suffix}.png`, px, {
      greyscale: style.greyscale,
      linear: style.linear,
      overlay: badge(px, style.badge),
    });
    if (state === "on" && px === 16) trayOn16 = buf;
    if (state === "on" && px === 32) trayOn32 = buf;
  }
}
// 兼容旧路径（默认取已连接样式）
writeFileSync(join(outDir, "tray.png"), trayOn16);
writeFileSync(join(outDir, "tray@2x.png"), trayOn32);
console.log("[icons] wrote tray-on / tray-off (circular 16/20/24/32)");

// Windows 托盘：正圆样式（与其它平台一致，四角透明，不带方框）。
// 额外放大主体 zoom=1.12，让狐狸头更占满圆面，小尺寸下更清晰；
// 仍保留 48/64/128 三档以兼容旧资源包，主进程优先取 16/20/24/32 的对应 DPI 版本。
const TRAY_WIN_ZOOM = 1.12;
const TRAY_WIN_GAMMA = 1.55;
for (const state of ["on", "off"]) {
  const style = TRAY_STYLES[state];
  for (const { px, suffix } of TRAY_WIN_SIZES) {
    await writeTray(`tray-win-${state}${suffix}.png`, px, {
      greyscale: style.greyscale,
      linear: style.linear,
      overlay: badge(px, style.badge),
      zoom: TRAY_WIN_ZOOM,
      gamma: TRAY_WIN_GAMMA * (style.gammaBoost || 1),
    });
  }
}
console.log("[icons] wrote tray-win-on / tray-win-off (circle, zoom 1.12, 16/20/24/32/48/64/128)");

// Windows 多尺寸 ICO
const ico = await pngToIco(icoSizes.map((s) => pngBuffers[s]));
writeFileSync(join(outDir, "icon.ico"), ico);
console.log("[icons] wrote icon.ico");

// favicon
writeFileSync(join(root, "public", "favicon.png"), pngBuffers[32]);
writeFileSync(join(root, "public", "favicon-192.png"), pngBuffers[128]);

// 前端侧栏用图
const assetsDir = join(root, "src", "assets");
mkdirSync(assetsDir, { recursive: true });
writeFileSync(join(assetsDir, "app-icon.png"), pngBuffers[256]);
console.log("[icons] wrote src/assets/app-icon.png");

console.log("[icons] done →", outDir);
