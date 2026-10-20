/**
 * 节点名展示工具。
 *
 * 机场节点名普遍带国旗 emoji（如 "🇭🇰 香港 01"），但 Windows 的 emoji 字体不含
 * 区域指示符，浏览器会退化成两个字母（"HK 香港 01"）。我们另外用旗图标识国家，
 * 于是同一张卡片上会出现「旗图 + HK + 香港 01」三重冗余。
 * 展示时剥掉 emoji，原始名保留在 title 里。
 */
const FLAG_EMOJI_RE = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;

export function stripFlagEmoji(name: string): string {
  return name.replace(FLAG_EMOJI_RE, "").replace(/\s+/g, " ").trim() || name;
}
