import { describe, expect, it } from "vitest";
import proxyState from "./proxy-state.cjs";

describe("Windows proxy state parsing", () => {
  it("does not read the next registry key as an empty PAC value", () => {
    const settings = proxyState.parseWindowsProxySettings(
      "ProxyEnable    REG_DWORD    0x0\r\nAutoConfigURL    REG_SZ\r\nHKEY_CURRENT_USER\\Software\\Internet Settings\\5.0\r\n"
    );
    expect(settings).toEqual({ enabled: false, server: "", pacUrl: "" });
  });

  it("parses enabled manual proxy and PAC values independently", () => {
    const settings = proxyState.parseWindowsProxySettings(
      "ProxyEnable    REG_DWORD    0x1\r\nProxyServer    REG_SZ    127.0.0.1:17897\r\nAutoConfigURL    REG_SZ    http://127.0.0.1:43210/proxy.pac\r\n"
    );
    expect(settings).toEqual({
      enabled: true,
      server: "127.0.0.1:17897",
      pacUrl: "http://127.0.0.1:43210/proxy.pac",
    });
  });
});

describe("Veyra PAC ownership", () => {
  it("recognizes the active PAC server and the last persisted URL", () => {
    expect(proxyState.isVeyraPacUrl("http://127.0.0.1:43210/proxy.pac", 43210, "")).toBe(true);
    expect(proxyState.isVeyraPacUrl("http://127.0.0.1:43210/proxy.pac", 0, "http://127.0.0.1:43210/proxy.pac")).toBe(true);
  });

  it("does not claim an unrelated PAC server", () => {
    expect(proxyState.isVeyraPacUrl("http://127.0.0.1:9000/proxy.pac", 43210, "http://127.0.0.1:43210/proxy.pac")).toBe(false);
    expect(proxyState.isVeyraPacUrl("https://proxy.example/pac", 0, "")).toBe(false);
  });
});
