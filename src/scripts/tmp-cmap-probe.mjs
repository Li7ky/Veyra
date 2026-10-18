// 一次性探针：读取 TTF/OTF 的 cmap，检查指定码点是否有字形。
// 用途：验证「旗帜 emoji / 箭头符号」在某个系统字体里到底有没有字形，
// 避免靠猜测判断乱码来源。用完即删。
import { readFileSync } from "node:fs";

function readCmap(file) {
  const b = readFileSync(file);
  const numTables = b.readUInt16BE(4);
  let cmapOff = 0;
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    if (b.toString("ascii", p, p + 4) === "cmap") {
      cmapOff = b.readUInt32BE(p + 8);
      break;
    }
  }
  if (!cmapOff) throw new Error("no cmap");
  const n = b.readUInt16BE(cmapOff + 2);
  const set = new Set();
  for (let i = 0; i < n; i++) {
    const rec = cmapOff + 4 + i * 8;
    const off = cmapOff + b.readUInt32BE(rec + 4);
    const fmt = b.readUInt16BE(off);
    if (fmt === 4) {
      const segX2 = b.readUInt16BE(off + 6);
      const segs = segX2 / 2;
      const endO = off + 14;
      const startO = endO + segX2 + 2;
      const deltaO = startO + segX2;
      const rangeO = deltaO + segX2;
      for (let s = 0; s < segs; s++) {
        const end = b.readUInt16BE(endO + s * 2);
        const start = b.readUInt16BE(startO + s * 2);
        if (start === 0xffff) continue;
        for (let c = start; c <= end && c !== 0xffff; c++) set.add(c);
      }
    } else if (fmt === 12) {
      const ngroups = b.readUInt32BE(off + 12);
      for (let g = 0; g < ngroups; g++) {
        const gp = off + 16 + g * 12;
        const sc = b.readUInt32BE(gp);
        const ec = b.readUInt32BE(gp + 4);
        if (ec - sc > 0x20000) continue;
        for (let c = sc; c <= ec; c++) set.add(c);
      }
    }
  }
  return set;
}

const files = {
  "Segoe UI Emoji": "C:/Windows/Fonts/seguiemj.ttf",
  "Segoe UI Symbol": "C:/Windows/Fonts/seguisym.ttf",
};
const probes = [
  [0x2191, "↑ UPWARDS ARROW"],
  [0x2193, "↓ DOWNWARDS ARROW"],
  [0x2192, "→ RIGHTWARDS ARROW"],
  [0x00b7, "· MIDDLE DOT"],
  [0x2022, "• BULLET"],
  [0x1f1e6, "🇦 REGIONAL INDICATOR A"],
  [0x1f1ef, "🇯 REGIONAL INDICATOR J"],
  [0x1f310, "🌐 GLOBE WITH MERIDIANS"],
  [0x2605, "★ BLACK STAR"],
  [0x2713, "✓ CHECK MARK"],
  [0x23f3, "⏳ HOURGLASS"],
];
for (const [name, f] of Object.entries(files)) {
  let set;
  try {
    set = readCmap(f);
  } catch (e) {
    console.log(`${name}: cannot read (${e.message})`);
    continue;
  }
  console.log(`\n${name}  (${set.size} code points)`);
  for (const [cp, label] of probes) {
    console.log(`  U+${cp.toString(16).toUpperCase().padStart(4, "0")}  ${set.has(cp) ? "HAS GLYPH" : "MISSING  "}  ${label}`);
  }
}
