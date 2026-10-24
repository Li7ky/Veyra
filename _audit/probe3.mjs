import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";

const PORT = process.env.CDP_PORT || 9222;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

// 1) rules process mode: measure toolbar children
await evaluate(`document.querySelectorAll('.nav-item')[4].click()`);
await sleep(600);
await evaluate(`(() => { const b=[...document.querySelectorAll('.rl-mode [role=tab]')].find(e=>(e.textContent||'').trim()==='应用进程'); b && b.click(); })()`);
await sleep(500);
const rows = await evaluate(`(() => {
  const bar = document.querySelector('.rl-toolbar');
  const r = bar.getBoundingClientRect();
  return { bar: { x: Math.round(r.x), w: Math.round(r.width), sw: bar.scrollWidth, cw: bar.clientWidth },
    kids: [...bar.children].map(e => { const b=e.getBoundingClientRect(); return { tag: e.tagName, cls: String(e.className).slice(0,40), x: Math.round(b.x), w: Math.round(b.width), cssW: getComputedStyle(e).width, flex: getComputedStyle(e).flex }; }) };
})()`);
console.log("RULES PROCESS TOOLBAR", JSON.stringify(rows, null, 2));

// 2) global child-overflow scan across every page
const navs = ["首页", "代理", "订阅", "连接", "规则", "日志", "测试", "设置"];
const scan = {};
for (let i = 0; i < navs.length; i++) {
  await evaluate(`document.querySelectorAll('.nav-item')[${i}].click()`);
  await sleep(700);
  scan[navs[i]] = await evaluate(`(() => {
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2) continue;
      const p = el.parentElement; if (!p) continue;
      const pr = p.getBoundingClientRect();
      if (pr.width < 2) continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'absolute' || cs.position === 'fixed') continue;
      if (r.width > pr.width + 2 && cs.overflowX === 'visible' && getComputedStyle(p).overflowX === 'visible') {
        bad.push({ cls: String(el.className).slice(0, 50), tag: el.tagName, w: Math.round(r.width), parentW: Math.round(pr.width), parentCls: String(p.className).slice(0,40), text: (el.textContent||'').trim().slice(0,24) });
      }
    }
    return bad.slice(0, 12);
  })()`);
}
console.log("CHILD OVERFLOW SCAN", JSON.stringify(scan, null, 2));
ws.close();
