// CDP audit: screenshots + layout overflow + console errors for each tab.
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.CDP_PORT || 9222);
const URL_BASE = process.env.AUDIT_URL || "http://127.0.0.1:5173/";
const OUT = process.env.AUDIT_OUT || path.resolve("_audit/shots");
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

let ws, nextId = 1;
const pending = new Map();
const consoleLog = [];
const errors = [];

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result?.value;
}

async function waitFor(expr, timeout = 25000, iv = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await evaluate(expr)) return true;
    } catch {
      /* page may be navigating */
    }
    await sleep(iv);
  }
  return false;
}

async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, "base64"));
}

const LAYOUT_PROBE = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const out = { vw, vh, docScrollW: document.documentElement.scrollWidth, docScrollH: document.documentElement.scrollHeight };
  const bad = [];
  const clipped = [];
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    if (el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1.5 || r.left < -1.5) {
      bad.push({ tag: el.tagName, cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : String(el.className||'')).slice(0,80), left: Math.round(r.left), right: Math.round(r.right), text: (el.textContent||'').trim().slice(0,40) });
    }
    const cs2 = getComputedStyle(el);
    if ((cs2.overflow === 'hidden' || cs2.overflowX === 'hidden') && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      const t = (el.textContent||'').trim();
      if (t) clipped.push({ cls: String(el.className||'').slice(0,60), scrollW: el.scrollWidth, clientW: el.clientWidth, text: t.slice(0,50) });
    }
  }
  out.overflowX = bad.slice(0, 12);
  out.overflowXCount = bad.length;
  out.clipped = clipped.slice(0, 12);
  out.clippedCount = clipped.length;
  out.navActive = document.querySelector('.nav-item.active .nav-label')?.textContent || null;
  return out;
})()`;

async function main() {
  const list = await targets();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const t = msg.params.type;
      if (t === "error" || t === "warning") {
        consoleLog.push({ type: t, text: msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 300) });
      }
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      errors.push((d.exception?.description || d.text || "").slice(0, 400));
    } else if (msg.method === "Log.entryAdded") {
      const e = msg.params.entry;
      if (e.level === "error" || e.level === "warning") consoleLog.push({ type: "log:" + e.level, text: (e.text || "").slice(0, 300) });
    }
  });

  const VW = Number(process.env.AUDIT_W || 1280);
  const VH = Number(process.env.AUDIT_H || 860);
  const THEMES = (process.env.AUDIT_THEMES || "light,dark").split(",");
  const TAG = process.env.AUDIT_TAG || `${VW}x${VH}`;
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

  const tabs = ["home", "proxies", "profiles", "connections", "rules", "logs", "tests", "settings"];
  const report = { light: {}, dark: {}, consoleLog, errors };

  for (const theme of THEMES) {
    await send("Page.navigate", { url: `${URL_BASE}?theme=${theme}` });
    const booted = await waitFor(`document.querySelectorAll('.nav-item').length >= 8 && !document.querySelector('.boot-splash')`);
    await sleep(800);
    await evaluate(`localStorage.setItem('veyra-theme', ${JSON.stringify(theme)})`);
    report[theme].__booted = booted;

    for (let i = 0; i < tabs.length; i++) {
      const clicked = await evaluate(`(() => { const b = document.querySelectorAll('.nav-item')[${i}]; if (!b) return false; b.click(); return true; })()`);
      await waitFor(`!!document.querySelector('.nav-item.active') && document.querySelectorAll('.nav-item')[${i}]?.classList.contains('active')`, 4000);
      await sleep(900);
      const layout = await evaluate(LAYOUT_PROBE);
      report[theme][tabs[i]] = layout;
      await shot(`${TAG}-${theme}-${String(i + 1).padStart(2, "0")}-${tabs[i]}.png`);
      if (!clicked) report[theme][tabs[i]].clickFailed = true;
    }
  }

  fs.writeFileSync(path.resolve(`_audit/report-${TAG}.json`), JSON.stringify(report, null, 2));
  const summary = Object.fromEntries(
    Object.entries(report).filter(([k]) => k === "light" || k === "dark").map(([k, v]) => [
      k,
      Object.fromEntries(Object.entries(v).map(([t, m]) => [t, { ovf: m.overflowXCount, clip: m.clippedCount, docW: m.docScrollW, docH: m.docScrollH }])),
    ])
  );
  console.log(JSON.stringify({ summary, consoleLog: consoleLog.slice(0, 30), errors: errors.slice(0, 10) }, null, 2));
  ws.close();
}

main().catch((e) => {
  console.error("AUDIT_FAILED", e.message);
  process.exit(1);
});
