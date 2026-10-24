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
await send("Runtime.enable");
// find element whose exact text is 自检
console.log(
  JSON.stringify(
    await evaluate(`(() => {
  const all = [...document.querySelectorAll('*')].filter(e => (e.textContent||'').trim() === '自检');
  return all.map(e => {
    const path = []; let n = e;
    while (n && n !== document.body) { path.push(n.tagName + '.' + String(n.className)); n = n.parentElement; }
    const r = e.getBoundingClientRect();
    return { path: path.slice(0, 6), rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], parentCls: e.parentElement && e.parentElement.className, sibs: e.parentElement ? [...e.parentElement.children].map(c => (c.textContent||'').trim().slice(0,8)) : [] };
  });
})()`),
    null,
    2
  )
);
console.log(
  "connections buttons:",
  JSON.stringify(
    await evaluate(`(() => {
  const nav = document.querySelectorAll('.nav-item');
  nav[3].click();
  return new Promise(r => setTimeout(() => {
    r([...document.querySelectorAll('button, select, input')].filter(e => e.offsetParent !== null).map(e => ({ tag: e.tagName, cls: e.className, text: (e.textContent||'').trim().slice(0,16), ph: e.placeholder || '' })));
  }, 700));
})()`),
    null,
    2
  )
);
ws.close();
