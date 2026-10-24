// Interaction scenarios against the dev:web preview (CDP 9222).
// Captures screenshots + overflow/dialog probes for interactive states.
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.CDP_PORT || 9222;
const URL_BASE = process.env.AUDIT_URL || "http://127.0.0.1:5173/";
const OUT = path.resolve(process.env.AUDIT_OUT || "_audit/shots");
fs.mkdirSync(OUT, { recursive: true });

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("no page target on port " + PORT);
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
  fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.data, "base64"));
};

const PROBE = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const out = { vw, vh, docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight, problems: [] };
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
    if (r.right > vw + 1.5 || r.left < -1.5) {
      out.problems.push({ kind: 'outside', tag: el.tagName, cls: String(el.className).slice(0, 60), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), text: (el.textContent || '').trim().slice(0, 40) });
    }
    if (cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== 'ellipsis') {
      out.problems.push({ kind: 'clipped', tag: el.tagName, cls: String(el.className).slice(0, 60), scrollW: el.scrollWidth, clientW: el.clientWidth, text: (el.textContent || '').trim().slice(0, 40) });
    }
    if (cs.overflowY !== 'visible' && el.scrollHeight > el.clientHeight + 2 && (cs.overflowY === 'auto' || cs.overflowY === 'scroll')) {
      out.problems.push({ kind: 'scrollY', tag: el.tagName, cls: String(el.className).slice(0, 60), scrollH: el.scrollHeight, clientH: el.clientHeight });
    }
  }
  out.problems = out.problems.slice(0, 40);
  return out;
})()`;

/** click first visible element whose trimmed text equals `label` (or matches selector) */
const clickText = async (label, sel = "button, [role=tab], a, .nav-item, label") => {
  const expr = `(() => {
    const want = ${JSON.stringify(label)};
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent !== null && (e.textContent||'').trim() === want);
    if (!els.length) return 'MISSING:' + want;
    els[0].click();
    return 'ok';
  })()`;
  return evaluate(expr);
};

const clickSel = async (sel, n = 0) => {
  const expr = `(() => { const els=[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>e.offsetParent!==null); if(!els[${n}]) return 'MISSING:'+${JSON.stringify(sel)}; els[${n}].click(); return 'ok'; })()`;
  return evaluate(expr);
};

const results = {};
const step = async (name, fn) => {
  try {
    const r = await fn();
    await sleep(700);
    const p = await evaluate(PROBE);
    await shot(name);
    results[name] = { ret: r, docW: p.docW, docH: p.docH, problems: p.problems };
  } catch (e) {
    results[name] = { error: e.message };
  }
  const r = results[name];
  const bad = (r.problems || []).length;
  console.log(`${name.padEnd(34)} ret=${JSON.stringify(r.ret ?? r.error)} doc=${r.docW}x${r.docH} issues=${bad}`);
  if (bad) for (const it of r.problems.slice(0, 8)) console.log(`    ${it.kind} ${it.tag}.${it.cls} ${it.left ?? ""}${it.right ?? ""} ${it.scrollW ?? ""}${it.clientW ?? ""} '${it.text ?? ""}'`);
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1080, height: 680, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: URL_BASE + "?theme=light" });
for (let i = 0; i < 90; i++) {
  await sleep(300);
  const ok = await evaluate(`document.querySelectorAll('.nav-item').length >= 8 && !document.querySelector('.boot-splash')`).catch(() => false);
  if (ok) break;
}
await sleep(900);

const nav = async (idx) => {
  await evaluate(`document.querySelectorAll('.nav-item')[${idx}].click()`);
  await sleep(600);
};

// ── settings tabs (10) ─────────────────────────────────────────────
await nav(7);
const settingsTabs = ["自检", "内核", "网络", "TUN", "DNS", "系统", "热键", "外观", "备份", "关于"];
for (let i = 0; i < settingsTabs.length; i++) {
  await step(`set-${String(i + 1).padStart(2, "0")}-${settingsTabs[i]}`, async () => {
    const r = await clickText(settingsTabs[i], ".s-nav button");
    return r;
  });
}

// ── profiles sub tabs ──────────────────────────────────────────────
await nav(2);
for (const label of ["增强", "节点编辑", "YAML"]) {
  await step(`prof-${label}`, () => clickText(label, "[role=tab]"));
}

// ── rules: switch to app-process mode, type an input ───────────────
await nav(4);
await step("rules-app-proc", () => clickText("应用进程", "[role=tab]"));
await step("rules-input-typed", async () => {
  const r = await evaluate(`(() => {
    const inp = [...document.querySelectorAll('input')].filter(e => e.offsetParent !== null).find(e => (e.placeholder||'').includes('DOMAIN-SUFFIX'));
    if (!inp) return 'NO_INPUT';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, 'DOMAIN,very-long-example-domain-for-overflow-testing.example.com,PROXY');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  return r;
});

// ── tests: filter chips ────────────────────────────────────────────
await nav(6);
await step("tests-filter-ok", () => clickText("可用0", ".tp-filter"));

// ── connections: empty state ─────────────────────────
await nav(3);
await step("conn-empty", () => clickText("刷新"));

// ── home: collapse right rail, open health sheet ───────────────────
await nav(0);
await step("home-rail-collapsed", () => clickSel('.header-icons .icon-btn', 0));
await step("home-rail-restored", () => clickSel('.header-icons .icon-btn', 0));
await step("home-health-open", () => clickSel(".hs-health", 0));
await step("home-health-closed", () => evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return 'esc'; })()`));

// ── proxies: density switch + list view ────────────────────────────
await nav(1);
await step("proxies-density-compact", () => clickText("紧凑"));
await step("proxies-density-list", () => clickText("列表"));

fs.writeFileSync(path.resolve(`_audit/scenarios.json`), JSON.stringify(results, null, 2));
ws.close();
