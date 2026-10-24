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
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(`_audit/shots/${name}.png`, Buffer.from(r.data, "base64"));
};

await send("Emulation.setDeviceMetricsOverride", { width: 1080, height: 680, deviceScaleFactor: 1, mobile: false });
await evaluate(`document.querySelectorAll('.nav-item')[7].click()`);
await sleep(500);
await evaluate(`(() => { const b=[...document.querySelectorAll('.s-nav button')].find(e=>(e.textContent||'').trim()==='外观'); b.click(); })()`);
await sleep(1500);
console.log(
  JSON.stringify(
    await evaluate(`(() => {
  const h = [...document.querySelectorAll('h3,h2,.s-sec-title,.sec-title')].find(e => (e.textContent||'').trim().startsWith('外观'));
  const out = [];
  let n = h;
  while (n && n !== document.body) {
    const cs = getComputedStyle(n);
    out.push({ tag: n.tagName, cls: String(n.className).slice(0,50), opacity: cs.opacity, filter: cs.filter, pe: cs.pointerEvents, anim: cs.animationName, trans: cs.transitionProperty });
    n = n.parentElement;
  }
  return out;
})()`),
    null,
    2
  )
);
// compare with 系统 panel
await evaluate(`(() => { const b=[...document.querySelectorAll('.s-nav button')].find(e=>(e.textContent||'').trim()==='系统'); b.click(); })()`);
await sleep(1200);
console.log(
  "系统 ancestors:",
  JSON.stringify(
    await evaluate(`(() => {
  const h = [...document.querySelectorAll('h3,h2,.s-sec-title')].find(e => (e.textContent||'').trim().startsWith('系统'));
  let n = h; const out = [];
  while (n && n !== document.body) { const cs = getComputedStyle(n); out.push({ cls: String(n.className).slice(0,50), opacity: cs.opacity, pe: cs.pointerEvents }); n = n.parentElement; }
  return out;
})()`)
  )
);
await sleep(300);
await shot("check-appearance-again");
ws.close();
