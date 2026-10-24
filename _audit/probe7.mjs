import { setTimeout as sleep } from "node:timers/promises";

const PORT = 9222;
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
const ev = async (e) => {
  const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
await send("Emulation.setDeviceMetricsOverride", { width: 1080, height: 680, deviceScaleFactor: 1, mobile: false });
await ev(`document.querySelectorAll('.nav-item')[7].click()`);
await sleep(400);
await ev(`(() => { const b=[...document.querySelectorAll('.s-nav button')].find(e=>(e.textContent||'').trim()==='外观'); b.click(); })()`);
await sleep(1500);
console.log(
  JSON.stringify(
    await ev(`(() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    if (el.offsetParent === null) continue;
    const cs = getComputedStyle(el);
    if (parseFloat(cs.opacity) < 0.99 || (cs.filter && cs.filter !== 'none')) {
      out.push({ tag: el.tagName, cls: String(el.className).slice(0,60), opacity: cs.opacity, filter: cs.filter, text: (el.textContent||'').trim().slice(0,20) });
    }
  }
  return out.slice(0, 25);
})()`),
    null,
    2
  )
);
ws.close();
