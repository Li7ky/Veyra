// 复验本轮显示修复：规则页应用进程工具条 / 禁用态添加按钮 / 代理页空态 / 策略组空槽 / 订阅页页签
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";

const PORT = process.env.CDP_PORT || 9222;
const OUT = "_audit/shots";
fs.mkdirSync(OUT, { recursive: true });

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
    pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
};

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1080, height: 680, deviceScaleFactor: 1, mobile: false });

const theme = process.env.AUDIT_THEME || "light";
await send("Page.navigate", { url: `http://127.0.0.1:5173/?theme=${theme}&v=${Date.now()}` });
// 等启动动画结束
for (let i = 0; i < 60; i++) {
  await sleep(250);
  const ok = await evaluate(
    `!!document.querySelectorAll('.nav-item').length >= 8 && !document.querySelector('.boot-splash')`
  );
  if (ok) break;
}
await sleep(400);

const navs = ["首页", "代理", "订阅", "连接", "规则", "日志", "测试", "设置"];
const goTab = async (name) => {
  await evaluate(`document.querySelectorAll('.nav-item')[${navs.indexOf(name)}].click()`);
  await sleep(600);
};
// 点击可见的、文本匹配的元素
const clickText = async (sel, text) => {
  return evaluate(`(() => {
    const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.offsetParent !== null && (e.textContent||'').trim() === ${JSON.stringify(text)});
    if (!el) return false; el.click(); return true;
  })()`);
};

const result = { theme, rulesProcess: null, rulesDomain: null, proxies: null, profiles: null };

// ── 1. 规则页：应用进程模式 ────────────────────────────────────────────────
await goTab("规则");
result.rulesDomain = await evaluate(`(() => {
  const btn = document.querySelector('.rl-toolbar .btn.primary');
  const cs = getComputedStyle(btn);
  const r = btn.getBoundingClientRect();
  return { text: (btn.textContent||'').trim(), disabled: btn.disabled,
    color: cs.color, background: cs.backgroundColor, borderColor: cs.borderColor, opacity: cs.opacity,
    w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x) };
})()`);
await shot(`fix-${theme}-rules-domain`);

await clickText('.rl-mode [role=tab]', "应用进程");
await sleep(500);
result.rulesProcess = await evaluate(`(() => {
  const bar = document.querySelector('.rl-toolbar');
  const br = bar.getBoundingClientRect();
  const stage = document.querySelector('main.stage') || document.querySelector('.stage');
  const sr = stage ? stage.getBoundingClientRect() : null;
  const kids = [...bar.children].map(e => { const b = e.getBoundingClientRect();
    return { tag: e.tagName, cls: String(e.className).slice(0,36), x: Math.round(b.x), right: Math.round(b.right), w: Math.round(b.width), top: Math.round(b.top) }; });
  return {
    bar: { x: Math.round(br.x), w: Math.round(br.width), sw: bar.scrollWidth, cw: bar.clientWidth, h: Math.round(br.height) },
    stage: sr ? { x: Math.round(sr.x), w: Math.round(sr.width), right: Math.round(sr.right) } : null,
    overflowX: bar.scrollWidth - bar.clientWidth,
    kids,
    clipped: kids.filter(k => sr && (k.right > sr.right + 1 || k.x < sr.x - 1)).map(k => k.cls || k.tag),
    viewportMax: Math.max(...kids.map(k => k.right))
  };
})()`);
await shot(`fix-${theme}-rules-process`);

// ── 2. 代理页：空态卡片 + 暂无策略组 ────────────────────────────────────────
await goTab("代理");
result.proxies = await evaluate(`(() => {
  const e = document.querySelector('.px-empty');
  const chip = document.querySelector('.px-bar-empty');
  const ccs = chip ? getComputedStyle(chip) : null;
  const cr = chip ? chip.getBoundingClientRect() : null;
  const er = e ? e.getBoundingClientRect() : null;
  return {
    empty: er ? { h: Math.round(er.height), w: Math.round(er.width) } : null,
    chip: cr ? { text: (chip.textContent||'').trim(), h: Math.round(cr.height), w: Math.round(cr.width), x: Math.round(cr.x),
      border: ccs.borderTopStyle + ' ' + ccs.borderTopColor, radius: ccs.borderRadius, color: ccs.color, display: ccs.display } : null
  };
})()`);
await shot(`fix-${theme}-proxies`);

// ── 3. 订阅页：页签轨道宽度 ────────────────────────────────────────────────
await goTab("订阅");
result.profiles = await evaluate(`(() => {
  const t = document.querySelector('.pf-tabs');
  const tr = t.getBoundingClientRect();
  const pane = t.closest('.pane');
  const pr = pane.getBoundingClientRect();
  const first = t.querySelector('button').getBoundingClientRect();
  return { tabs: { x: Math.round(tr.x), w: Math.round(tr.width), right: Math.round(tr.right) },
    pane: { x: Math.round(pr.x), w: Math.round(pr.width) },
    firstBtnX: Math.round(first.x), alignSelf: getComputedStyle(t).alignSelf };
})()`);
await shot(`fix-${theme}-profiles`);

console.log(JSON.stringify(result, null, 2));
ws.close();
