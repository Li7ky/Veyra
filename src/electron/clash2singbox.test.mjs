/**
 * Clash → sing-box 配置转换测试
 *
 * 这是全项目最复杂的纯逻辑：把用户的 Clash/Meta 订阅转换成 sing-box 配置。
 * 一旦转换出错，用户内核起不来、全部断网，且错误现场只在运行时暴露。
 * 它输入输出都是普通对象、无 IO 依赖，是最值得优先覆盖的模块。
 */
import { describe, it, expect } from "vitest";
import clash2singbox from "../electron/clash2singbox.cjs";

const { convertClashToSingbox } = clash2singbox;

/** 最小可用 Clash 配置样本 */
const baseClash = {
  proxies: [
    { name: "HK-01", type: "ss", server: "1.1.1.1", port: 8388, cipher: "aes-256-gcm", password: "pw" },
    { name: "JP-01", type: "ss", server: "2.2.2.2", port: 8388, cipher: "aes-256-gcm", password: "pw" },
  ],
  "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["HK-01", "JP-01", "DIRECT"] }],
  rules: ["DOMAIN-SUFFIX,google.com,PROXY", "MATCH,DIRECT"],
};

describe("convertClashToSingbox - 结构与必填项", () => {
  it("返回 config/warnings/stats 三部分", () => {
    const res = convertClashToSingbox(baseClash, {});
    expect(res).toHaveProperty("config");
    expect(res).toHaveProperty("warnings");
    expect(Array.isArray(res.warnings)).toBe(true);
    expect(res).toHaveProperty("stats");
  });

  it("生成的 config 含 sing-box 必需顶层字段", () => {
    const { config } = convertClashToSingbox(baseClash, {});
    expect(config.log).toBeDefined();
    expect(config.dns).toBeDefined();
    expect(config.inbounds).toBeDefined();
    expect(config.outbounds).toBeDefined();
    expect(config.route).toBeDefined();
    expect(config.experimental).toBeDefined();
  });

  it("每个出站都有 type 与 tag（sing-box 硬性要求）", () => {
    const { config } = convertClashToSingbox(baseClash, {});
    for (const ob of config.outbounds) {
      expect(ob.type, `出站 ${JSON.stringify(ob)} 缺少 type`).toBeTruthy();
      expect(ob.tag, `出站 ${JSON.stringify(ob)} 缺少 tag`).toBeTruthy();
    }
  });

  it("出站 tag 全局唯一（重复 tag 会让 sing-box 启动失败）", () => {
    const { config } = convertClashToSingbox(baseClash, {});
    const tags = config.outbounds.map((o) => o.tag);
    expect(new Set(tags).size).toBe(tags.length);
  });
});

describe("convertClashToSingbox - 出站与保底", () => {
  it("转换所有有效节点", () => {
    const { stats } = convertClashToSingbox(baseClash, {});
    expect(stats.nodes).toBe(2);
    expect(stats.skippedNodes).toBe(0);
  });

  it("总是补齐 DIRECT / REJECT / REJECT-DROP 保底出站", () => {
    const { config } = convertClashToSingbox(baseClash, {});
    const tags = config.outbounds.map((o) => o.tag);
    expect(tags).toContain("DIRECT");
    expect(tags).toContain("REJECT");
    expect(tags).toContain("REJECT-DROP");
  });

  it("分组存在时 route.final 指向 PROXY", () => {
    const { config, stats } = convertClashToSingbox(baseClash, {});
    expect(stats.final).toBe("PROXY");
    expect(config.route.final).toBe("PROXY");
  });

  it("无分组时 route.final 回落到第一个节点而非报错", () => {
    const clash = { proxies: [baseClash.proxies[0]], rules: ["MATCH,DIRECT"] };
    const { config, stats } = convertClashToSingbox(clash, {});
    expect(stats.final).toBe("HK-01");
    expect(config.route.final).toBe("HK-01");
  });
});

describe("convertClashToSingbox - 空/异常输入健壮性", () => {
  it("null / undefined / 非对象输入不抛异常", () => {
    expect(() => convertClashToSingbox(null, {})).not.toThrow();
    expect(() => convertClashToSingbox(undefined, {})).not.toThrow();
    expect(() => convertClashToSingbox("not-an-object", {})).not.toThrow();
    expect(() => convertClashToSingbox(123, {})).not.toThrow();
  });

  it("无节点时仍产出可启动配置，final 回落 DIRECT", () => {
    const { config, stats } = convertClashToSingbox({ proxies: [], rules: [] }, {});
    expect(stats.nodes).toBe(0);
    expect(config.route.final).toBe("DIRECT");
    // 保底出站必须齐全，否则 sing-box 无法加载
    const tags = config.outbounds.map((o) => o.tag);
    expect(tags).toContain("DIRECT");
    expect(tags).toContain("REJECT");
  });

  it("proxies 不是数组时按空处理", () => {
    const { stats } = convertClashToSingbox({ proxies: "oops" }, {});
    expect(stats.nodes).toBe(0);
  });

  it("未知节点类型被跳过并计入 skippedNodes，不污染出站列表", () => {
    const clash = {
      proxies: [
        { name: "OK", type: "ss", server: "1.1.1.1", port: 8388, cipher: "aes-256-gcm", password: "p" },
        { name: "BAD", type: "totally-unknown-type", server: "x", port: 1 },
      ],
      rules: ["MATCH,DIRECT"],
    };
    const { config, stats } = convertClashToSingbox(clash, {});
    expect(stats.skippedNodes).toBe(1);
    expect(config.outbounds.some((o) => o.tag === "BAD")).toBe(false);
  });
});

describe("convertClashToSingbox - 入站与端口", () => {
  it("mixed 入站使用指定端口，默认绑定 127.0.0.1", () => {
    const { config } = convertClashToSingbox(baseClash, { mixedPort: 12345, allowLan: false });
    const mixed = config.inbounds.find((i) => i.type === "mixed");
    expect(mixed.listen_port).toBe(12345);
    expect(mixed.listen).toBe("127.0.0.1");
  });

  it("allowLan 开启时绑定 0.0.0.0", () => {
    const { config } = convertClashToSingbox(baseClash, { allowLan: true });
    const mixed = config.inbounds.find((i) => i.type === "mixed");
    expect(mixed.listen).toBe("0.0.0.0");
  });

  it("端口缺省时回落到默认 17897", () => {
    const { config } = convertClashToSingbox(baseClash, {});
    const mixed = config.inbounds.find((i) => i.type === "mixed");
    expect(mixed.listen_port).toBe(17897);
  });
});

describe("convertClashToSingbox - 控制面板与日志级别", () => {
  it("clash_api 使用指定 controller 与 secret", () => {
    const { config } = convertClashToSingbox(baseClash, {
      controllerHost: "127.0.0.1",
      controllerPort: 19097,
      secret: "s3cret",
    });
    expect(config.experimental.clash_api.external_controller).toBe("127.0.0.1:19097");
    expect(config.experimental.clash_api.secret).toBe("s3cret");
  });

  it("secret 为空时不写入该字段", () => {
    const { config } = convertClashToSingbox(baseClash, { secret: "" });
    expect(config.experimental.clash_api.secret).toBeUndefined();
  });

  it("日志级别做 Clash → sing-box 映射", () => {
    const cases = [
      ["silent", "panic"],
      ["error", "error"],
      ["warning", "warn"],
      ["info", "info"],
      ["debug", "debug"],
    ];
    for (const [input, expected] of cases) {
      const { config } = convertClashToSingbox(baseClash, { logLevel: input });
      expect(config.log.level, `${input} 应映射为 ${expected}`).toBe(expected);
    }
  });

  it("非法日志级别回落到 info", () => {
    const { config } = convertClashToSingbox(baseClash, { logLevel: "nonsense" });
    expect(config.log.level).toBe("info");
  });
});

describe("convertClashToSingbox - 规则转换", () => {
  it("规则被转换进 route.rules", () => {
    const { config, stats } = convertClashToSingbox(baseClash, {});
    expect(stats.rules).toBeGreaterThan(0);
    expect(Array.isArray(config.route.rules)).toBe(true);
  });

  it("指向不存在出站的规则不会导致崩溃", () => {
    const clash = {
      proxies: [baseClash.proxies[0]],
      "proxy-groups": [{ name: "PROXY", type: "select", proxies: ["HK-01"] }],
      rules: ["DOMAIN-SUFFIX,example.com,NOT_A_REAL_TAG", "MATCH,PROXY"],
    };
    expect(() => convertClashToSingbox(clash, {})).not.toThrow();
  });
});
