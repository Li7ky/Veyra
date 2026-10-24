// 全页裁剪扫描 + 规则页「应用进程」模式（本轮改动重点）
import { setTimeout as sleep } from "node:timers/promises";

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

const SCAN = `(() => {
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const p = el.parentElement; if (!p) continue;
    const pr = p.getBoundingClientRect();
    if (pr.width < 2) continue;
    const pcs = getComputedStyle(p);
    if (cs.position === 'absolute' || cs.position === 'fixed') continue;
    const clippedParent = pcs.overflowX !== 'visible' || pcs.overflow === 'hidden';
    if (clippedParent && (r.right > pr.right + 2 || r.left < pr.left - 2)) {
      bad.push({ kind: 'out-of-clip', tag: el.tagName, cls: String(el.className).slice(0,44), l: Math.round(r.left - pr.left), r: Math.round(r.right - pr.right), pcls: String(p.className).slice(0,40), text: (el.textContent||'').trim().slice(0,26) });
    }
    if ((cs.overflow === 'hidden' || cs.overflowX === 'hidden') && el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && !el.children.length) {
      bad.push({ kind: 'text-clip', tag: el.tagName, cls: String(el.className).slice(0,44), sw: el.scrollWidth, cw: el.clientWidth, text: (el.textContent||'').trim().slice(0,26) });
    }
  }
  // 是否被 main.stage 右边界切掉
  const stage = document.querySelector('main.stage') || document.querySelector('.stage');
  if (stage) {
    const sr = stage.getBoundingClientRect();
    for (const el of document.querySelectorAll('main.stage *, .stage *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (cs.position === 'absolute' || cs.position === 'fixed') continue;
      if (r.right > sr.right + 1 || r.left < sr.left - 1) {
        bad.push({ kind: 'out-of-stage', tag: el.tagName, cls: String(el.className).slice(0,44), right: Math.round(r.right), stageRight: Math.round(sr.right), text: (el.textContent||'').trim().slice(0,26) });
      }
    }
  }
  return bad.slice(0, 25);
})()`;

const out = {};
await send("Emulation.setDeviceMetricsOverride", { width: 1080, height: 680, deviceScaleFactor: 1, mobile: false });
await sleep(400);
const navs = ["首页", "代理", "订阅", "连接", "规则", "日志", "测试", "设置"];
for (let i = 0; i < navs.length; i++) {
  await evaluate(`document.querySelectorAll('.nav-item')[${i}].click()`);
  await sleep(700);
  out["page:" + navs[i]] = await evaluate(SCAN);
}
// 规则页两种模式
await evaluate(`document.querySelectorAll('.nav-item')[4].click()`);
await sleep(500);
for (const mode of ["域名 / IP", "应用进程"]) {
  await evaluate(`(() => { const b=[...document.querySelectorAll('.rl-mode [role=tab]')].find(e=>(e.textContent||'').trim()===${JSON.stringify(mode)}); b && b.click(); })()`);
  await sleep(500);
  out["rules:" + mode] = await evaluate(SCAN);
}
const tabs = ["自检", "内核", "网络", "TUN", "DNS", "系统", "热键", "外观", "备份", "关于"];
await evaluate(`document.querySelectorAll('.nav-item')[7].click()`);
await sleep(500);
for (const t of tabs) {
  await evaluate(`(() => { const b=[...document.querySelectorAll('.s-nav button')].find(e=>(e.textContent||'').trim()===${JSON.stringify(t)}); b && b.click(); })()`);
  await sleep(650);
  out["set:" + t] = await evaluate(SCAN);
}
await evaluate(`document.querySelectorAll('.nav-item')[2].click()`);
await sleep(500);
for (const t of ["订阅", "增强", "节点编辑", "YAML"]) {
  await evaluate(`(() => { const b=[...document.querySelectorAll('[role=tab]')].find(e=>(e.textContent||'').trim()===${JSON.stringify(t)}); b && b.click(); })()`);
  await sleep(650);
  out["prof:" + t] = await evaluate(SCAN);
}
let dirty = 0;
for (const [k, v] of Object.entries(out)) {
  if (v.length) dirty++;
  console.log(k.padEnd(18), v.length ? `FOUND ${v.length}` : "clean");
  for (const it of v) console.log("   ", JSON.stringify(it));
}
console.log("STATES", Object.keys(out).length, "DIRTY", dirty);
ws.close();
