/**
 * 通过 CDP 覆盖视口尺寸并截图，用于验证响应式断点下的布局。
 * 依赖应用以 --remote-debugging-port=9222 启动。
 *
 * 用法：node scripts/cdp-shot.mjs <width> <height> <out.png>
 */

import { writeFileSync } from "node:fs";

const PORT = Number(process.env.CDP_PORT || 9222);
const [wArg, hArg, out] = process.argv.slice(2);
const W = Number(wArg || 1600);
const H = Number(hArg || 1000);

async function pickPage() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page" && !String(t.url).startsWith("devtools://"));
  if (!page) throw new Error("未找到可调试页面");
  return page;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let id = 0;
    ws.addEventListener("open", () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const msgId = ++id;
            pending.set(msgId, { res, rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        close: () => ws.close(),
      })
    );
    ws.addEventListener("error", (e) => reject(new Error("WS 失败: " + (e.message || "?"))));
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    });
  });
}

async function main() {
  const page = await pickPage();
  const c = await connect(page.webSocketDebuggerUrl);

  await c.send("Emulation.setDeviceMetricsOverride", {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // 等重排完成
  await new Promise((r) => setTimeout(r, 700));

  // 顺带回报布局关键数值，便于判断断点是否按预期生效
  const r = await c.send("Runtime.evaluate", {
    expression: `(() => {
      const rail = document.querySelector('.col-right');
      const grid = document.querySelector('.grid-12');
      const main = document.querySelector('.col-main');
      const side = document.querySelector('.col-sidebar');
      const g = grid ? getComputedStyle(grid).gridTemplateColumns : '';
      return {
        viewport: window.innerWidth + 'x' + window.innerHeight,
        gridCols: g,
        sidebarW: side ? Math.round(side.getBoundingClientRect().width) : 0,
        mainW: main ? Math.round(main.getBoundingClientRect().width) : 0,
        railW: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
        railDisplay: rail ? getComputedStyle(rail).display : 'n/a',
      };
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify(r.result?.value, null, 2));

  const shot = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("saved ->", out);

  await c.send("Emulation.clearDeviceMetricsOverride");
  c.close();
}

main().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
