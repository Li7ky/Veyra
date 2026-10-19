/**
 * 节点 URI 解析测试
 *
 * 这是导入订阅/单节点 URI 的核心逻辑：解析错误会直接导致用户节点不可用，
 * 而且它同时被「订阅导入」和「扫二维码/粘贴分享链接」两条路径复用，
 * 属于典型的高风险纯函数——最适合拿来做测试基线示范。
 */
import { describe, it, expect } from "vitest";
import uriImport from "../electron/uri-import.cjs";

const { parseNodeUri, safeName, proxyToYamlDoc, urisToYamlDoc } = uriImport;
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

describe("safeName", () => {
  it("过滤 Windows 非法文件名字符", () => {
    expect(safeName('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
  });

  it("空值回退到 fallback，再回退到默认名", () => {
    expect(safeName("", "备用")).toBe("备用");
    expect(safeName(null)).toBe("node");
    expect(safeName("   ")).toBe("node");
  });

  it("超长名称截断到 64 字符", () => {
    const long = "x".repeat(200);
    expect(safeName(long).length).toBe(64);
  });
});

describe("parseNodeUri - SS", () => {
  it("解析 SIP002 格式（明文 userinfo）", () => {
    const uri = "ss://aes-256-gcm:pass123@1.2.3.4:8388#%E9%A6%99%E6%B8%AF%E8%8A%82%E7%82%B9";
    const node = parseNodeUri(uri);
    expect(node).toBeTruthy();
    expect(node.type).toBe("ss");
    expect(node.server).toBe("1.2.3.4");
    expect(node.port).toBe(8388);
    expect(node.cipher).toBe("aes-256-gcm");
    expect(node.password).toBe("pass123");
    expect(node.name).toBe("香港节点");
  });

  it("解析全 base64 编码格式", () => {
    const inner = b64("aes-128-gcm:secret@5.6.7.8:443");
    const node = parseNodeUri(`ss://${inner}#Node`);
    expect(node.type).toBe("ss");
    expect(node.server).toBe("5.6.7.8");
    expect(node.port).toBe(443);
    expect(node.cipher).toBe("aes-128-gcm");
    expect(node.password).toBe("secret");
  });

  it("密码含冒号时不被截断", () => {
    const node = parseNodeUri("ss://aes-256-gcm:pa:ss:word@9.9.9.9:1080#T");
    expect(node.password).toBe("pa:ss:word");
  });

  it("明文形态的密码做 percent-decode（含 @ : / %）", () => {
    // 修复前不做解码，密码会带着 %40 去鉴权 —— 节点永远连不上且没有任何报错
    expect(parseNodeUri("ss://aes-256-gcm:p%40ss@1.2.3.4:8388#T").password).toBe("p@ss");
    expect(parseNodeUri("ss://aes-256-gcm:a%2Fb%3Ac@1.2.3.4:8388#T").password).toBe("a/b:c");
    expect(parseNodeUri("ss://aes-256-gcm:100%25@1.2.3.4:8388#T").password).toBe("100%");
  });

  it("base64 形态的密码保持原样（不能被二次解码）", () => {
    // base64 里装的是原始字节，密码中的 % 是字面量，解码会破坏它
    const inner = b64("aes-128-gcm:raw%pw@5.6.7.8:443");
    expect(parseNodeUri(`ss://${inner}#Node`).password).toBe("raw%pw");
  });

  it("非法百分号转义不应抛错，按原样保留", () => {
    expect(parseNodeUri("ss://aes-256-gcm:ab%ZZcd@1.2.3.4:8388#T").password).toBe("ab%ZZcd");
  });

  it("拒绝超出 TCP 端口范围的端口", () => {
    expect(() => parseNodeUri("ss://aes-256-gcm:pw@9.9.9.9:65536#T")).toThrow(/port 非法/);
  });
});

describe("parseNodeUri - VMess", () => {
  it("解析 vmess base64 JSON", () => {
    const cfg = {
      v: "2",
      ps: "测试节点",
      add: "example.com",
      port: "443",
      id: "11111111-2222-3333-4444-555555555555",
      aid: "0",
      net: "ws",
      host: "example.com",
      path: "/ws",
      tls: "tls",
    };
    const node = parseNodeUri(`vmess://${b64(JSON.stringify(cfg))}`);
    expect(node.type).toBe("vmess");
    expect(node.server).toBe("example.com");
    expect(node.port).toBe(443);
    expect(node.uuid).toBe(cfg.id);
    expect(node.network).toBe("ws");
    expect(node.tls).toBe(true);
  });

  it("拒绝非数字 vmess 端口而不是静默回退到 443", () => {
    const cfg = {
      ps: "bad-port",
      add: "example.com",
      port: "not-a-port",
      id: "11111111-2222-3333-4444-555555555555",
    };
    expect(() => parseNodeUri(`vmess://${b64(JSON.stringify(cfg))}`)).toThrow(/port 非法/);
  });
});

describe("parseNodeUri - VLESS / Trojan", () => {
  it("解析 vless 并读取 type/security 参数", () => {
    const node = parseNodeUri(
      "vless://11111111-2222-3333-4444-555555555555@a.example.com:443?encryption=none&type=ws&security=tls&path=%2Fv#VLESS%E8%8A%82%E7%82%B9"
    );
    expect(node.type).toBe("vless");
    expect(node.server).toBe("a.example.com");
    expect(node.port).toBe(443);
    expect(node.uuid).toBe("11111111-2222-3333-4444-555555555555");
    expect(node.network).toBe("ws");
  });

  it("解析 trojan", () => {
    const node = parseNodeUri("trojan://mypassword@b.example.com:8443?sni=b.example.com#TJ");
    expect(node.type).toBe("trojan");
    expect(node.server).toBe("b.example.com");
    expect(node.port).toBe(8443);
    expect(node.password).toBe("mypassword");
  });
});

describe("parseNodeUri - 非法输入（契约：抛异常，由调用方捕获）", () => {
  // 注意：parseNodeUri 对非法输入是抛错而非返回 null。
  // 调用方（urisToYamlDoc / 主进程 IPC handler）负责 try-catch。
  // 这里把该契约固化下来，避免后人误以为它返回 null 而写出漏捕获的代码。
  it("未知协议抛错", () => {
    expect(() => parseNodeUri("http://example.com")).toThrow(/不支持的节点 URI 协议/);
  });

  it("空串/非字符串抛错", () => {
    expect(() => parseNodeUri("")).toThrow(/空 URI/);
    expect(() => parseNodeUri(null)).toThrow(/空 URI/);
    expect(() => parseNodeUri(undefined)).toThrow(/空 URI/);
  });

  it("vmess 载荷损坏时抛错（JSON 解析失败）", () => {
    expect(() => parseNodeUri("vmess://!!!not-base64!!!")).toThrow();
  });
});

describe("YAML 生成", () => {
  it("proxyToYamlDoc 接收单个 proxy，返回 {name,type,content,proxy}", () => {
    const res = proxyToYamlDoc({
      name: "N1",
      type: "ss",
      server: "1.1.1.1",
      port: 443,
      cipher: "aes-256-gcm",
      password: "p",
    });
    expect(res.name).toBe("N1");
    expect(res.type).toBe("ss");
    expect(res.proxy.server).toBe("1.1.1.1");

    // content 是可直接落盘的 YAML 文本
    expect(typeof res.content).toBe("string");
    expect(res.content).toContain("N1");
    expect(res.content).toContain("proxies:");
    expect(res.content).toContain("MATCH,PROXY");
  });

  it("urisToYamlDoc 混合有效/无效 URI 时只保留有效节点", () => {
    const yaml = urisToYamlDoc([
      "ss://aes-256-gcm:pw@1.1.1.1:443#OK",
      "http://invalid.example.com",
    ]);
    expect(yaml).toContain("OK");
    expect(yaml).not.toContain("invalid.example.com");
  });

  it("全部无效时抛错（调用方据此提示用户）", () => {
    expect(() => urisToYamlDoc(["http://a.com", "ftp://b.com"])).toThrow(/无法解析/);
  });

  it("重名节点自动去重（追加序号）", () => {
    const yaml = urisToYamlDoc([
      "ss://aes-256-gcm:pw@1.1.1.1:443#SameName",
      "ss://aes-256-gcm:pw@2.2.2.2:443#SameName",
    ]);
    expect(yaml).toContain("SameName");
    expect(yaml).toContain("SameName 2");
  });

  it("机场信息节点被过滤，不进入代理列表", () => {
    const yaml = urisToYamlDoc([
      "ss://aes-256-gcm:pw@1.1.1.1:443#%E5%89%A9%E4%BD%99%E6%B5%81%E9%87%8F%EF%BC%9A79GB",
      "ss://aes-256-gcm:pw@2.2.2.2:443#RealNode",
    ]);
    expect(yaml).toContain("RealNode");
    expect(yaml).not.toContain("剩余流量");
  });
});
