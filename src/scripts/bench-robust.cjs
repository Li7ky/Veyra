const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');

const OUT = path.resolve(__dirname, '../outputs');
const TABS = [
  ['home', '首页'], ['proxies', '代理'], ['profiles', '订阅'], ['connections', '连接'],
  ['rules', '规则'], ['logs', '日志'], ['tests', '测试'], ['settings', '设置'],
];

// 用 setTimeout 轮询代替 rAF：rAF 在无 GPU 的 Electron 里可能被节流
const CLICK_AND_WAIT = async (navLabel) => {
  const findActive = () => [...document.querySelectorAll('.menu button')].find((b) => b.classList.contains('active'));
  const findPane = () => document.querySelector('.stage > .pane:not([hidden])');
  const btn = [...document.querySelectorAll('.menu button')].find((b) => b.dataset.tip === navLabel);
  if (!btn) return { error: 'nav not found: ' + navLabel };

  const t0 = performance.now();
  btn.click();
  const blockMs = performance.now() - t0; // 同步阻塞时间

  const deadline = t0 + 5000;
  let polls = 0;
  while (performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4));
    polls += 1;
    const active = findActive();
    const pane = findPane();
    if (active?.dataset.tip === navLabel && pane) break;
  }
  const settledMs = performance.now() - t0;
  // 再给一帧时间让异步数据落地
  await new Promise((r) => setTimeout(r, 120));
  const pane = findPane();
  return {
    blockMs: Math.round(blockMs),
    settledMs: Math.round(settledMs),
    polls,
    nodes: pane ? pane.getElementsByTagName('*').length : 0,
    cls: pane?.className || null,
  };
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('5173')) || ctx.pages()[0];
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(2500);

  const rounds = [];
  for (let round = 0; round < 2; round += 1) {
    const out = {};
    for (const [id, label] of TABS) {
      if (id !== 'home') {
        await page.evaluate(CLICK_AND_WAIT, '首页');
        await page.waitForTimeout(150);
      }
      out[id] = await page.evaluate(CLICK_AND_WAIT, label);
      await page.waitForTimeout(120);
    }
    rounds.push(out);
  }

  const summary = TABS.map(([id, label]) => ({
    tab: id, label,
    coldBlock: rounds[0][id].blockMs, coldSettled: rounds[0][id].settledMs, nodes: rounds[0][id].nodes,
    warmBlock: rounds[1][id].blockMs, warmSettled: rounds[1][id].settledMs,
  }));

  const label = process.env.BENCH_LABEL || 'run';
  fs.writeFileSync(path.join(OUT, `tab-robust-${label}.json`), JSON.stringify({ summary, rounds }, null, 2));

  console.log(`tab     冷阻塞  冷完成  热阻塞  热完成  节点`);
  for (const r of summary) {
    console.log(`${r.label.padEnd(6)} ${String(r.coldBlock).padStart(6)} ${String(r.coldSettled).padStart(7)} ${String(r.warmBlock).padStart(7)} ${String(r.warmSettled).padStart(7)} ${String(r.nodes).padStart(6)}`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exitCode = 1; });
