/**
 * Verge 对齐解锁测试：经混合端口 CONNECT 探测各平台
 */
const http = require("http");
const tls = require("tls");

function parseHttpResponse(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
  const idx = text.indexOf("\r\n\r\n");
  const head = idx >= 0 ? text.slice(0, idx) : text;
  const body = idx >= 0 ? text.slice(idx + 4) : "";
  const m = head.match(/^HTTP\/\d\.\d\s+(\d+)/);
  const status = m ? Number(m[1]) : 0;
  const loc = (head.match(/location:\s*(.+)/i) || [])[1];
  return { status, body, location: loc ? loc.trim() : "", headers: head };
}

function httpThroughMixed(url, mixedPort, { method = "GET", headers = {}, body = null, timeout = 14000 } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: mixedPort,
        method,
        path: url,
        headers: { Host: u.host, "User-Agent": UA, Accept: "*/*", Connection: "close", ...headers },
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
            location: res.headers.location || "",
          })
        );
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (body) {
      // 显式带长度：无 Content-Length 的 body 会走 chunked 编码，
      // 部分严格服务器（老 nginx / CF 部分端点）会 400 或挂起，造成解锁误判
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) {
        req.setHeader("Content-Length", Buffer.byteLength(body));
      }
      req.write(body);
    }
    req.end();
  });
}

function connectTls(url, mixedPort, { method = "GET", headers = {}, body = null, timeout = 14000 } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const connect = http.request({
      host: "127.0.0.1",
      port: mixedPort,
      method: "CONNECT",
      path: `${u.hostname}:${u.port || 443}`,
      timeout,
      headers: { Host: `${u.hostname}:${u.port || 443}`, "Proxy-Connection": "keep-alive" },
    });
    connect.on("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`CONNECT ${res.statusCode}`));
        return;
      }
      const tlsSock = tls.connect(
        {
          socket,
          servername: u.hostname,
          rejectUnauthorized: false,
          minVersion: "TLSv1.2",
          ALPNProtocols: ["http/1.1"],
        },
        () => {
          const hdrs = {
            Host: u.host,
            "User-Agent": UA,
            Accept: "*/*",
            Connection: "close",
            ...headers,
          };
          if (body) hdrs["Content-Length"] = Buffer.byteLength(body);
          const lines = [`${method} ${u.pathname}${u.search} HTTP/1.1`];
          for (const [k, v] of Object.entries(hdrs)) lines.push(`${k}: ${v}`);
          tlsSock.write(lines.join("\r\n") + "\r\n\r\n" + (body || ""));
        }
      );
      if (head && head.length) tlsSock.unshift(head);
      const chunks = [];
      const timer = setTimeout(() => {
        tlsSock.destroy();
        reject(new Error("timeout"));
      }, timeout);
      tlsSock.on("data", (c) => chunks.push(c));
      const finish = () => {
        clearTimeout(timer);
        resolve(parseHttpResponse(Buffer.concat(chunks)));
      };
      tlsSock.on("end", finish);
      // close 兜底：部分服务器响应后保持连接不回 end（即使发了 Connection: close），
      // 只能等满超时后误报「网络连接问题」；close 时按已收到的数据解析（幂等，end 先到则无影响）
      tlsSock.on("close", () => {
        if (chunks.length) finish();
      });
      tlsSock.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    connect.on("error", reject);
    connect.on("timeout", () => {
      connect.destroy();
      reject(new Error("timeout"));
    });
    connect.end();
  });
}

async function viaProxy(url, mixedPort, opts = {}) {
  try {
    return await httpThroughMixed(url, mixedPort, opts);
  } catch {
    return connectTls(url, mixedPort, opts);
  }
}

function friendlyFail(e) {
  const s = String((e && e.message) || e || "");
  if (/BAD_DECRYPT|OPENSSL|EPROTO|wrong version number|ssl|tls/i.test(s)) {
    return "测试失败 (站点 TLS 握手失败)";
  }
  if (/timeout|ECONN|ENOTFOUND|CONNECT|EPIPE|socket/i.test(s)) {
    return "测试失败 (网络连接问题)";
  }
  if (s.length > 40 || /error:\d/i.test(s)) return "测试失败 (探测未完成)";
  return s;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function traceLoc(body) {
  const m = String(body || "").match(/loc=([A-Z]{2,3})/i);
  return m ? m[1].toUpperCase() : null;
}

async function cfTrace(port) {
  try {
    const r = await viaProxy("https://www.cloudflare.com/cdn-cgi/trace", port);
    return traceLoc(r.body);
  } catch {
    return null;
  }
}

function pack(ok, { region = null, fail = false, note = "" } = {}) {
  return { ok: !!ok && !fail, fail: !!fail, region, note };
}

const CHECKS = [
  {
    id: "bilibili-cn",
    title: "哔哩哔哩大陆",
    run: async (port) => {
      const r = await viaProxy("https://api.bilibili.com/x/web-interface/nav", port);
      if (!r.status) return pack(false, { fail: true, note: "网络连接问题" });
      if (r.status >= 200 && r.status < 400) return pack(true, { region: "CN", note: "支持" });
      return pack(false, { note: "不支持" });
    },
  },
  {
    id: "bilibili-hk",
    title: "哔哩哔哩港澳台",
    run: async (port) => {
      const r = await viaProxy(
        "https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=285145&qn=1&fnval=16&fourk=1",
        port
      );
      if (!r.status) return pack(false, { fail: true, note: "网络连接问题" });
      if (/area_limit|10403|-10403/i.test(r.body)) return pack(false, { note: "不支持" });
      if (r.status >= 200 && r.status < 400) return pack(true, { note: "支持" });
      return pack(false, { note: "不支持" });
    },
  },
  {
    id: "bahamut",
    title: "Bahamut Anime",
    run: async (port) => {
      const r = await viaProxy("https://ani.gamer.com.tw/ajax/getdeviceid.php", port);
      if (!r.status) return pack(false, { fail: true, note: "网络连接问题" });
      if (r.status >= 200 && r.status < 400 && /deviceid/i.test(r.body)) {
        return pack(true, { region: "TW", note: "支持" });
      }
      return pack(false, { fail: r.status >= 500, note: r.status >= 500 ? "测试失败" : "不支持" });
    },
  },
  {
    id: "chatgpt",
    title: "ChatGPT Web",
    run: async (port) => {
      const r = await viaProxy("https://chatgpt.com/cdn-cgi/trace", port);
      if (!r.status) return pack(false, { fail: true, note: "网络连接问题" });
      const loc = traceLoc(r.body);
      const blocked = /CN|HK|MO|RU|IR|KP|CU|SY/i.test(loc || "");
      if (r.status >= 200 && r.status < 400) {
        return pack(!blocked, { region: loc, note: blocked ? "不支持" : "支持" });
      }
      return pack(false, { fail: true, note: "测试失败" });
    },
  },
  {
    id: "claude",
    title: "Claude",
    run: async (port) => {
      const r = await viaProxy("https://claude.ai/cdn-cgi/trace", port);
      if (!r.status) return pack(false, { fail: true, note: "网络连接问题" });
      const loc = traceLoc(r.body);
      if (r.status === 403 || r.status === 451) return pack(false, { region: loc, note: "不支持" });
      if (r.status >= 200 && r.status < 400) return pack(true, { region: loc, note: "支持" });
      return pack(false, { fail: true, note: "测试失败" });
    },
  },
  {
    id: "disney",
    title: "Disney+",
    run: async (port) => {
      const r = await viaProxy("https://www.disneyplus.com", port);
      if (!r.status) return pack(false, { fail: true, note: "网络连接问题" });
      if (r.status === 403 || r.status === 451 || /not available/i.test(r.body)) {
        return pack(false, { note: "不支持" });
      }
      if (r.status >= 200 && r.status < 400) {
        const loc = await cfTrace(port);
        return pack(true, { region: loc, note: "支持" });
      }
      return pack(false, { fail: true, note: "测试失败" });
    },
  },
  {
    id: "gemini",
    title: "Gemini",
    run: async (port) => {
      const r = await viaProxy("https://gemini.google.com", port);
      if (!r.status) return pack(false, { fail: true, note: "网络连接问题" });
      if (r.status === 403 || /not available in your country/i.test(r.body)) return pack(false, { note: "不支持" });
      if (r.status >= 200 && r.status < 400) {
        const loc = await cfTrace(port);
        return pack(true, { region: loc, note: "支持" });
      }
      return pack(false, { fail: true, note: "测试失败" });
    },
  },
  {
    id: "netflix",
    title: "Netflix",
    run: async (port) => {
      const r = await viaProxy("https://www.netflix.com/title/81280792", port);
      if (!r.status) return pack(false, { fail: true, note: "网络连接问题" });
      if (r.status === 404) return pack(false, { note: "仅自制剧" });
      if (r.status === 403 || r.status === 451) return pack(false, { note: "不支持" });
      if (r.status >= 200 && r.status < 400) {
        const loc = await cfTrace(port);
        return pack(true, { region: loc, note: "支持" });
      }
      return pack(false, { fail: true, note: "测试失败" });
    },
  },
  {
    id: "prime",
    title: "Prime Video",
    run: async (port) => {
      const r = await viaProxy("https://www.primevideo.com", port);
      if (!r.status) return pack(false, { fail: true, note: "网络连接问题" });
      if (r.status === 403 || /not available/i.test(r.body)) return pack(false, { note: "不支持" });
      if (r.status >= 200 && r.status < 400) {
        const loc = await cfTrace(port);
        return pack(true, { region: loc, note: "支持" });
      }
      return pack(false, { fail: true, note: "测试失败" });
    },
  },
  {
    id: "spotify",
    title: "Spotify",
    run: async (port) => {
      const r = await viaProxy("https://spclient.wg.spotify.com/signup/public/v1/account", port, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "birth_year=1999&birth_month=1&birth_day=1&country=US&key=142b583541b7b624c10c6ae3aefd2c00",
      });
      if (!r.status) return pack(false, { fail: true, note: "网络连接问题" });
      if (/status"?\s*:\s*20\b/.test(r.body) || r.status === 200) {
        const loc = await cfTrace(port);
        return pack(true, { region: loc, note: "支持" });
      }
      if (/restricted|not available|status"?\s*:\s*3[12]/.test(r.body)) return pack(false, { note: "不支持" });
      return pack(false, { fail: r.status >= 500, note: r.status >= 500 ? "测试失败" : "不支持" });
    },
  },
  {
    id: "tiktok",
    title: "TikTok",
    run: async (port) => {
      const r = await viaProxy("https://www.tiktok.com/api/v1/web-cookie-privacy/config?appId=1988", port);
      if (!r.status) return pack(false, { fail: true, note: "网络连接问题" });
      const loc = (r.body.match(/"region"\s*:\s*"(\w+)"/i) || [])[1] || (await cfTrace(port));
      if (r.status >= 200 && r.status < 400) return pack(true, { region: loc, note: "支持" });
      return pack(false, { fail: true, note: "测试失败" });
    },
  },
  {
    id: "youtube",
    title: "YouTube Premium",
    run: async (port) => {
      const r = await viaProxy("https://www.youtube.com/premium", port);
      if (!r.status) return pack(false, { fail: true, note: "网络连接问题" });
      if (/not available in your country/i.test(r.body)) return pack(false, { note: "不支持" });
      if (r.status >= 200 && r.status < 400) {
        const loc = await cfTrace(port);
        return pack(true, { region: loc, note: "支持" });
      }
      return pack(false, { fail: true, note: "测试失败" });
    },
  },
];

function catalog() {
  return CHECKS.map((c) => ({
    id: c.id,
    title: c.title,
    ok: false,
    fail: false,
    region: null,
    note: "",
    status: 0,
    testedAt: 0,
  }));
}

async function runOne(mixedPort, id) {
  const c = CHECKS.find((x) => x.id === id);
  if (!c) throw new Error("未知测试项");
  try {
    const r = await c.run(mixedPort);
    return {
      id: c.id,
      title: c.title,
      ok: !!r.ok,
      fail: !!r.fail,
      region: r.region || null,
      note: r.note || (r.ok ? "支持" : "不支持"),
      status: r.ok ? 200 : r.fail ? 0 : 403,
      testedAt: Date.now(),
    };
  } catch (e) {
    return {
      id: c.id,
      title: c.title,
      ok: false,
      fail: true,
      region: null,
      note: friendlyFail(e),
      status: 0,
      testedAt: Date.now(),
    };
  }
}

async function runUnlockChecks(mixedPort) {
  const out = [];
  for (const c of CHECKS) {
    out.push(await runOne(mixedPort, c.id));
  }
  return out;
}

module.exports = { catalog, runOne, runUnlockChecks };
