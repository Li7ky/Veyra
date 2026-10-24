// One-off DOM probe against the running dev:web page (CDP 9222).
import { setTimeout as sleep } from "node:timers/promises";

const PORT = process.env.CDP_PORT || 9222;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
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

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1080, height: 680, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "http://127.0.0.1:5173/?theme=light" });
for (let i = 0; i < 80; i++) {
  await sleep(300);
  const ok = await evaluate(`document.querySelectorAll('.nav-item').length >= 8 && !document.querySelector('.boot-splash')`).catch(() => false);
  if (ok) break;
}
await sleep(700);

const out = await evaluate(`(() => {
  const info = (el) => ({ tag: el.tagName, cls: el.className, title: el.title || el.getAttribute('aria-label') || '', text: (el.textContent || '').trim().slice(0, 24), rect: (r => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)])(el.getBoundingClientRect()) });
  const headerBtns = [...document.querySelectorAll('.header button, .header-icons button')].map(info);
  const collect = (sel) => [...document.querySelectorAll(sel)].map(info);
  return { headerBtns };
})()`);
console.log(JSON.stringify(out, null, 2));

// dump tab structures per page by clicking nav
const tabs = ["home", "profiles", "settings", "rules", "tests", "connections"];
const dump = {};
for (let i = 0; i < tabs.length; i++) {
  const idx = { home: 0, profiles: 2, settings: 7, rules: 4, tests: 6, connections: 3 }[tabs[i]];
  await evaluate(`document.querySelectorAll('.nav-item')[${idx}].click()`);
  await sleep(600);
  dump[tabs[i]] = await evaluate(`(() => {
    const pick = (sel) => [...document.querySelectorAll(sel)].map(e => ({ cls: e.className, text: (e.textContent||'').trim().slice(0,20), role: e.getAttribute('role')||'' }));
    return {
      segs: pick('.seg button, .segment button, .tabs button, .tab, [role=tab]'),
      dropdowns: pick('[aria-haspopup], .select, select'),
      buttons: [...document.querySelectorAll('button')].map(e => ({ cls: e.className, text: (e.textContent||'').trim().slice(0,18), disabled: e.disabled })).slice(0, 40),
    };
  })()`);
}
console.log(JSON.stringify(dump, null, 2));
ws.close();
