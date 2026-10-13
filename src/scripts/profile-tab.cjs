const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');

const OUT = path.resolve(__dirname, '../outputs');

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('5173')) || ctx.pages()[0];
  await page.waitForTimeout(1500);

  const client = await ctx.newCDPSession(page);
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 200 });

  const results = {};
  for (const target of ['代理', '规则', '订阅', '设置']) {
    // 先回到首页
    await page.evaluate(async () => {
      const b = [...document.querySelectorAll('.menu button')].find((x) => x.dataset.tip === '首页');
      b?.click();
      await new Promise((r) => setTimeout(r, 400));
    });
    await page.waitForTimeout(600);

    await client.send('Profiler.start');
    const elapsed = await page.evaluate(async (label) => {
      const btn = [...document.querySelectorAll('.menu button')].find((b) => b.dataset.tip === label);
      const t0 = performance.now();
      btn.click();
      await new Promise((r) => requestAnimationFrame(r));
      await new Promise((r) => requestAnimationFrame(r));
      return Math.round(performance.now() - t0);
    }, target);
    const { profile } = await client.send('Profiler.stop');

    // 按函数聚合自身耗时
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map();
    const interval = (profile.endTime - profile.startTime) / (profile.samples?.length || 1);
    for (const id of profile.samples || []) {
      const node = byId.get(id);
      if (!node) continue;
      const cf = node.callFrame;
      const key = `${cf.functionName || '(anonymous)'} @ ${(cf.url || '').split('/').slice(-1)[0]}:${cf.lineNumber + 1}`;
      self.set(key, (self.get(key) || 0) + interval);
    }
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
      .map(([k, v]) => ({ fn: k, ms: Math.round(v) }));
    results[target] = { elapsedMs: elapsed, totalMs: Math.round(profile.endTime - profile.startTime), top };
  }

  fs.writeFileSync(path.join(OUT, 'tab-switch-profile.json'), JSON.stringify(results, null, 2));
  for (const [tab, r] of Object.entries(results)) {
    console.log(`\n=== ${tab}  click->paint ${r.elapsedMs}ms  (profile ${r.totalMs}ms) ===`);
    for (const t of r.top) console.log(`  ${String(t.ms).padStart(5)}ms  ${t.fn}`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exitCode = 1; });
