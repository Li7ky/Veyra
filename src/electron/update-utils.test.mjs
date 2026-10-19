import { describe, it, expect } from "vitest";
import {
  parseAppVersion,
  compareAppVersion,
  pickSetupAsset,
  buildUpdateScript,
  parseReleaseNotes,
  parseWinProxyServer,
  isOurLoopbackPort,
} from "./update-utils.cjs";

describe("parseAppVersion", () => {
  it("解析正式版，并接受 v 前缀", () => {
    expect(parseAppVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: "" });
    expect(parseAppVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: "" });
  });

  it("解析测试版后缀", () => {
    expect(parseAppVersion("1.1.9-beta.4")).toEqual({
      major: 1,
      minor: 1,
      patch: 9,
      pre: "beta.4",
    });
  });

  it("两段式版本按 patch=0 补齐（GitHub tag 不总是三段）", () => {
    expect(parseAppVersion("1.2")).toEqual({ major: 1, minor: 2, patch: 0, pre: "" });
    expect(parseAppVersion("v1.10")).toEqual({ major: 1, minor: 10, patch: 0, pre: "" });
  });

  it("无意义输入返回 null", () => {
    expect(parseAppVersion("")).toBeNull();
    expect(parseAppVersion("latest")).toBeNull();
    expect(parseAppVersion("1")).toBeNull();
    expect(parseAppVersion("a.b.c")).toBeNull();
  });
});

describe("compareAppVersion", () => {
  it("按数值比较，而不是字符串", () => {
    expect(compareAppVersion("1.2.10", "1.2.9")).toBeGreaterThan(0);
    expect(compareAppVersion("1.10.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("回归：两段式版本号不能被字典序判反", () => {
    // 修复前 1.10 vs 1.9 走 localeCompare 得到 -1（1.10 被判成更旧）
    expect(compareAppVersion("1.10", "1.9")).toBeGreaterThan(0);
    expect(compareAppVersion("1.2", "1.10")).toBeLessThan(0);
    expect(compareAppVersion("2.0", "1.99.99")).toBeGreaterThan(0);
  });

  it("正式版高于同号测试版", () => {
    expect(compareAppVersion("1.1.9", "1.1.9-beta.4")).toBeGreaterThan(0);
    expect(compareAppVersion("1.1.9-beta.4", "1.1.9")).toBeLessThan(0);
  });

  it("测试序号按数值比较：beta.10 > beta.9", () => {
    expect(compareAppVersion("1.1.9-beta.10", "1.1.9-beta.9")).toBeGreaterThan(0);
  });

  it("相同版本返回 0", () => {
    expect(compareAppVersion("v1.1.9-beta.4", "1.1.9-beta.4")).toBe(0);
  });

  it("当前 beta.3 能识别 beta.4 为更新", () => {
    expect(compareAppVersion("1.1.9-beta.4", "1.1.9-beta.3")).toBeGreaterThan(0);
  });
});

describe("pickSetupAsset", () => {
  const assets = [
    { name: "SHA256SUMS.txt" },
    { name: "Veyra-omini-Setup-1.1.9-beta.4-x64.exe" },
    { name: "Veyra-omini-Setup-1.1.9-beta.4-x64.exe.blockmap" },
    { name: "mihomo-v1.19.15-source.tar.gz" },
  ];

  it("优先选择 Setup-*-x64.exe", () => {
    expect(pickSetupAsset(assets)?.name).toBe("Veyra-omini-Setup-1.1.9-beta.4-x64.exe");
  });

  it("没有标准命名时回退到任意 exe，且排除 blockmap", () => {
    expect(pickSetupAsset([{ name: "x.blockmap" }, { name: "installer.exe" }])?.name).toBe(
      "installer.exe"
    );
  });

  it("没有可用资产时返回 null", () => {
    expect(pickSetupAsset([{ name: "a.zip" }])).toBeNull();
    expect(pickSetupAsset(null)).toBeNull();
  });
});

describe("buildUpdateScript", () => {
  const UNINST = "C:\\Program Files\\Veyra-omini\\Uninstall Veyra-omini.exe";
  const SETUP = "C:\\Program Files\\Veyra-omini\\Veyra-omini-Setup-1.1.9-x64.exe";

  it("路径含空格时整段加引号", () => {
    const s = buildUpdateScript(UNINST, SETUP);
    expect(s).toContain(`"${UNINST}" /S`);
    expect(s).toContain(`start "" "${SETUP}"`);
  });

  it("用 ping 计时，不用依赖 stdin 的 timeout", () => {
    const s = buildUpdateScript(UNINST, SETUP);
    // timeout /t 在 stdio:"ignore" 下会因 stdin 指向 NUL 立即退出，延时归零
    expect(s).not.toMatch(/timeout\s+\/t/i);
    expect(s).toContain("ping -n 3 127.0.0.1");
    expect(s).toContain("ping -n 6 127.0.0.1");
  });

  it("先卸载、再启动安装包，顺序不可颠倒", () => {
    const s = buildUpdateScript(UNINST, SETUP);
    expect(s.indexOf("/S")).toBeLessThan(s.indexOf("start \"\""));
  });

  it("转义 % ，避免批处理把它当变量展开", () => {
    const s = buildUpdateScript("C:\\100%\\uninstall.exe", "C:\\100%\\setup.exe");
    expect(s).toContain("100%%");
    expect(s).not.toMatch(/100%[^%]/);
  });

  it("使用 CRLF 换行，兼容 cmd.exe", () => {
    expect(buildUpdateScript(UNINST, SETUP)).toContain("\r\n");
  });

  it("以 @echo off 开头", () => {
    expect(buildUpdateScript(UNINST, SETUP).startsWith("@echo off")).toBe(true);
  });
});

describe("parseReleaseNotes", () => {
  // 真实 beta.5 release 正文的压缩样例（保证解析器对实况格式有效）
  const BETA5_BODY = [
    "## Veyra-omini 1.1.9-beta.5（测试版）",
    "",
    "本次发布**仅用于验证在线更新链路**：检查更新 → 收到 beta.5 提醒 → 下载 → 安装。",
    "",
    "### 相对 beta.4 的修复",
    "- 在线更新：代理 / 直连两种网络下的下载、超时、取消与回退逻辑重写",
    "- 更新失败时的错误提示改为可读文案（不再直接抛原始异常）",
    "- 启动冲突弹窗：按钮语义纠正 + 破坏性操作二次确认",
    "- 多语言：补齐缺失词条，语言列表标注「部分翻译」",
    "",
    "### 安装",
    "下载 `Veyra-omini-Setup-1.1.9-beta.5-x64.exe`，覆盖安装即可。",
  ].join("\n");

  it("解析真实 beta.5 告示：版本/标题/列表项", () => {
    const entry = parseReleaseNotes(BETA5_BODY, "v1.1.9-beta.5");
    expect(entry.version).toBe("1.1.9-beta.5");
    expect(entry.channel).toBe("beta");
    expect(entry.title).toContain("1.1.9-beta.5");
    expect(entry.items.length).toBeGreaterThanOrEqual(4);
    expect(entry.items.some((i) => i.includes("在线更新"))).toBe(true);
  });

  it("有序列表与 * / + 前缀同样识别", () => {
    const entry = parseReleaseNotes("Fix:\n1. first\n* second\n+ third", "v2.0");
    expect(entry.items).toEqual(["first", "second", "third"]);
  });

  it("没有列表项时返回 null（调用方回退内置 changelog）", () => {
    expect(parseReleaseNotes("只有一个段落，没有列表。", "v1.0")).toBeNull();
    expect(parseReleaseNotes("", "v1.0")).toBeNull();
  });

  it("tag 无 v 前缀也照常收录；日期缺失不报错", () => {
    const a = parseReleaseNotes("- item a\n- item b", "1.2.3");
    expect(a.version).toBe("1.2.3");
    expect(a.date).toBeUndefined();
    const b = parseReleaseNotes("2026-10-19 发布\n- item", "v1.2.3");
    expect(b.date).toBe("2026-10-19");
  });

  it("stable tag 的 channel 是 stable", () => {
    expect(parseReleaseNotes("- x", "v1.2.0").channel).toBe("stable");
  });
});

describe("parseWinProxyServer", () => {
  it("单一 host:port 形态", () => {
    expect(parseWinProxyServer("127.0.0.1:7897")).toBe("http://127.0.0.1:7897");
    expect(parseWinProxyServer("localhost:1080")).toBe("http://127.0.0.1:1080");
  });

  it("协议分列形态：取 http/https 项，跳过 socks", () => {
    expect(parseWinProxyServer("http=127.0.0.1:1080;https=127.0.0.1:1080")).toBe(
      "http://127.0.0.1:1080"
    );
    expect(parseWinProxyServer("socks=127.0.0.1:1080;http=127.0.0.1:7890")).toBe(
      "http://127.0.0.1:7890"
    );
  });

  it("混合形态：无协议第一项（通配）优先", () => {
    expect(parseWinProxyServer("127.0.0.1:7897;https=127.0.0.1:1080")).toBe(
      "http://127.0.0.1:7897"
    );
  });

  it("非回环地址不自动使用", () => {
    expect(parseWinProxyServer("192.168.1.10:7897")).toBeNull();
    expect(parseWinProxyServer("proxy.corp.com:8080")).toBeNull();
  });

  it("空/畸形值返回 null", () => {
    expect(parseWinProxyServer("")).toBeNull();
    expect(parseWinProxyServer(null)).toBeNull();
    expect(parseWinProxyServer("localhost")).toBeNull();
    expect(parseWinProxyServer("127.0.0.1:notaport")).toBeNull();
  });
});

describe("isOurLoopbackPort", () => {
  it("命中自家端口列表时为 true", () => {
    expect(isOurLoopbackPort("http://127.0.0.1:17897", [17897, 7897])).toBe(true);
    expect(isOurLoopbackPort("http://localhost:7897", [17897, 7897])).toBe(true);
  });

  it("外部端口为 false；非回环/畸形输入为 false", () => {
    expect(isOurLoopbackPort("http://127.0.0.1:7897", [17897])).toBe(false);
    expect(isOurLoopbackPort("http://192.168.1.10:7897", [17897, 7897])).toBe(false);
    expect(isOurLoopbackPort("", [17897])).toBe(false);
    expect(isOurLoopbackPort(null, [17897])).toBe(false);
  });
});
