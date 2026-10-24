// 找出各页面长期处于「主按钮禁用态」的控件，逐个截局部图确认观感
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";

const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.value;

await send("Emulation.setDeviceMetricsOverride", { width: 1080, height: 680, deviceScaleFactor: 1, mobile: false });
await sleep(300);

const PROBE = `(() => [...document.querySelectorAll('.btn.primary:disabled, .btn-primary:disabled')]
  .filter(e => e.offsetParent !== null)
  .map(e => { const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    return { text: (e.textContent||'').trim().slice(0,20), cls: String(e.className).slice(0,40),
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      color: cs.color, bg: cs.backgroundColor, border: cs.borderTopColor, opacity: cs.opacity }; }))()`;

const navs = ["首页", "代理", "订阅", "连接", "规则", "日志", "测试", "设置"];
const out = {};
for (let i = 0; i < navs.length; i++) {
  await evaluate(`document.querySelectorAll('.nav-item')[${i}].click()`);
  await sleep(650);
  const hits = await evaluate(PROBE);
  if (hits.length) out[navs[i]] = hits;
}
// 设置各子页
await evaluate(`document.querySelectorAll('.nav-item')[7].click()`);
await sleep(400);
for (const t of ["自检", "内核", "网络", "TUN", "DNS", "系统", "热键", "外观", "备份", "关于"]) {
  await evaluate(`(() => { const b=[...document.querySelectorAll('.s-nav button')].find(e=>(e.textContent||'').trim()===${JSON.stringify(t)}); b && b.click(); })()`);
  await sleep(600);
  const hits = await evaluate(PROBE);
  if (hits.length) out["设置/" + t] = hits;
}
console.log(JSON.stringify(out, null, 2));
ws.close();
