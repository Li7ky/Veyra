/**
 * 内核下载完整性校验的解析逻辑测试
 *
 * 不触碰网络：只验证「从官方校验文件文本里正确提取目标摘要」这一纯逻辑。
 * 官方校验文件的排版并不统一（有的叫 checksums.txt、有的是 <asset>.sha256），
 * 且可能含注释行、多文件列表、大小写不一致，这里把这些情况都固化下来。
 */
import { describe, it, expect } from "vitest";
import { parseChecksumFile } from "../scripts/verify-checksum.mjs";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);

describe("parseChecksumFile", () => {
  it("从多行校验文件中按文件名精确匹配", () => {
    const content = [
      `${HEX_A}  mihomo-windows-amd64-v1.19.15.zip`,
      `${HEX_B}  mihomo-windows-amd64-compatible-v1.19.15.zip`,
      `${HEX_C}  mihomo-linux-amd64-v1.19.15.gz`,
    ].join("\n");
    expect(parseChecksumFile(content, "mihomo-windows-amd64-compatible-v1.19.15.zip")).toBe(HEX_B);
  });

  it("兼容 <hash> *<filename> 的 GNU sha256sum 格式", () => {
    const content = `${HEX_A} *mihomo-linux-amd64-v1.19.15.gz`;
    expect(parseChecksumFile(content, "mihomo-linux-amd64-v1.19.15.gz")).toBe(HEX_A);
  });

  it("摘要大小写不敏感，输出统一为小写", () => {
    const upper = "A".repeat(64);
    const content = `${upper}  asset.zip`;
    expect(parseChecksumFile(content, "asset.zip")).toBe("a".repeat(64));
  });

  it("忽略注释行与空行", () => {
    const content = ["# 这是校验文件", "", `${HEX_A}  target.zip`, ""].join("\n");
    expect(parseChecksumFile(content, "target.zip")).toBe(HEX_A);
  });

  it("文件名不匹配时回退：只有唯一摘要则采用它", () => {
    const content = `${HEX_A}  some-other-name.zip`;
    expect(parseChecksumFile(content, "expected-name.zip")).toBe(HEX_A);
  });

  it("文件里有多个摘要且都不匹配文件名时返回 null（拒绝误判）", () => {
    const content = [`${HEX_A}  a.zip`, `${HEX_B}  b.zip`].join("\n");
    expect(parseChecksumFile(content, "c.zip")).toBeNull();
  });

  it("空内容/无摘要返回 null", () => {
    expect(parseChecksumFile("", "x.zip")).toBeNull();
    expect(parseChecksumFile("# 只有注释\n", "x.zip")).toBeNull();
    expect(parseChecksumFile("not a checksum file", "x.zip")).toBeNull();
  });

  it("拒绝非 64 位长度的伪摘要", () => {
    const content = "abc123  target.zip";
    expect(parseChecksumFile(content, "target.zip")).toBeNull();
  });
});
