const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener("message", ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
await new Promise(r => ws.addEventListener("open", r));
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, m => m.error ? rej(new Error(m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.value;
await evaluate(`document.querySelectorAll('.nav-item')[6].click()`);
await new Promise(r => setTimeout(r, 900));
console.log(await evaluate(`(() => {
  for (const el of document.querySelectorAll('body *')) {
    if (el.tagName.toLowerCase() !== 'g') continue;
    const p = el.parentElement; const pc = getComputedStyle(p);
    const r = el.getBoundingClientRect(), pr = p.getBoundingClientRect();
    if ((pc.overflowX !== 'visible' || pc.overflow === 'hidden') && r.width > 1 && (r.right > pr.right + 2 || r.left < pr.left - 2)) {
      const svg = p.closest('svg');
      return { parent: p.tagName, overflow: pc.overflow, rect: [Math.round(r.left), Math.round(r.right), Math.round(r.width)],
        parentRect: [Math.round(pr.left), Math.round(pr.right), Math.round(pr.width)],
        svgClass: String(svg && svg.getAttribute('class')), svgW: svg && Math.round(svg.getBoundingClientRect().width),
        host: svg && String(svg.closest('div,button') && svg.closest('div,button').className),
        html: el.outerHTML.slice(0, 160) };
    }
  }
  return 'none';
})()`));
ws.close();
