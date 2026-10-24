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

const probe = (tab) => `(() => {
  const b=[...document.querySelectorAll('.s-nav button')].find(e=>(e.textContent||'').trim()===${JSON.stringify(tab)}); b.click();
  return new Promise(res => setTimeout(() => {
    const card = [...document.querySelectorAll('.s-card')].find(c => c.offsetParent !== null);
    const row = card && card.querySelector('.s-row-title, .s-row-label, strong, .s-lbl');
    const cs = row ? getComputedStyle(row) : null;
    const btn = card && card.querySelector('.btn');
    res({ tab: ${JSON.stringify(tab)}, rowColor: cs && cs.color, rowCls: row && String(row.className).slice(0,40), cardCls: card && String(card.className), disabled: card ? !!card.closest('fieldset[disabled]') : null,
      fieldset: card ? !!card.closest('fieldset') : null, btnCls: btn && String(btn.className), btnColor: btn && getComputedStyle(btn).color, btnBg: btn && getComputedStyle(btn).backgroundColor, cardOp: card && getComputedStyle(card).opacity });
  }, 900));
})()`;

console.log(JSON.stringify(await evaluate(probe("外观")), null, 2));
console.log(JSON.stringify(await evaluate(probe("系统")), null, 2));
ws.close();
