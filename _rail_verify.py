"""验证：极限速率字符串截断 / 3x 放大 / 其他 Tab / 暗色"""
import asyncio
from playwright.async_api import async_playwright

OUT = "D:/项目文件夹/代理工具/veyra-latest/_shots/railcheck"

RUN = r"""
(vals) => {
  const dot = document.querySelector('.rail-status-dot');
  if (dot) dot.classList.add('on');
  const b = document.querySelector('.rail-state b');
  if (b) b.textContent = '运行中';
  const sm = document.querySelector('.rail-state small');
  if (sm) sm.textContent = '12h34';
  const idle = document.querySelector('.rail-chart-idle');
  if (idle) idle.remove();
  const chart = document.querySelector('.rail-chart');
  if (chart && !chart.querySelector('svg')) {
    const mk = (gid, color, pts) => `<svg class="sparkline" width="140" height="42" viewBox="0 0 140 42" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.26"/><stop offset="100%" stop-color="${color}" stop-opacity="0.02"/></linearGradient></defs><polygon points="0,42 ${pts} 140,42" fill="url(#${gid})"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
    const down = "0,38 12,35 24,33 36,36 48,28 60,20 72,24 84,14 96,18 108,10 120,16 132,22 140,26";
    const up = "0,40 12,39 24,38 36,40 48,36 60,34 72,37 84,33 96,35 108,31 120,34 132,36 140,38";
    chart.insertAdjacentHTML('beforeend', mk('injdown', 'var(--accent-strong)', down));
    chart.insertAdjacentHTML('beforeend', mk('injup', 'var(--amber-500)', up));
  }
  const s = document.querySelectorAll('.rail-ratecard strong');
  if (s[0]) { s[0].textContent = vals[0]; s[0].classList.remove('idle'); }
  if (s[1]) { s[1].textContent = vals[1]; s[1].classList.remove('idle'); }
  const f = document.querySelectorAll('.rail-fact strong');
  if (f[0]) { f[0].textContent = '开启'; f[0].classList.add('on'); }
  if (f[2]) { f[2].textContent = '23'; f[2].classList.add('on'); }
  if (f[3]) f[3].textContent = '82 MB';
}
"""

MEASURE = r"""
() => {
  const c = document.createElement('canvas').getContext('2d');
  const out = [];
  document.querySelectorAll('.rail-ratecard strong').forEach(el => {
    const cs = getComputedStyle(el);
    c.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    const tw = c.measureText(el.textContent).width;
    out.push({ t: el.textContent, box: el.clientWidth, textW: Math.round(tw * 10) / 10,
               fits: tw <= el.clientWidth + 0.5 });
  });
  // 状态行整体是否溢出
  const st = document.querySelector('.rail-state');
  out.push({ row: 'rail-state', sw: st.scrollWidth, cw: st.clientWidth });
  // 两端语言的状态字宽度（用 .rail-state b 的真实 font 测量）
  const b = document.querySelector('.rail-state b');
  const bcs = getComputedStyle(b);
  c.font = bcs.fontWeight + ' ' + bcs.fontSize + ' ' + bcs.fontFamily;
  [['运行中', 'Running'], ['已停止', 'Stopped']].forEach(([zh, en]) => {
    out.push({ state: zh, w: Math.round(c.measureText(zh).width * 10) / 10,
               en, enW: Math.round(c.measureText(en).width * 10) / 10 });
  });
  return out;
}
"""

async def shot(page, name, pad=8):
    panel = await page.query_selector(".rail-status-panel")
    box = await panel.bounding_box()
    await page.screenshot(path=f"{OUT}/{name}.png", clip={
        "x": box["x"] - pad, "y": box["y"] - pad,
        "width": box["width"] + pad * 2, "height": box["height"] + pad * 2})

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1600, "height": 1000}, device_scale_factor=3)
        page = await ctx.new_page()
        await page.goto("http://127.0.0.1:5173/", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2600)
        await page.evaluate("document.querySelector('.boot-splash')?.remove()")
        # 停止态 3x
        await shot(page, "verify_stopped_3x")
        # 运行态 + 极限值
        await page.evaluate(RUN, ["1023B", "99.9K"])
        await page.wait_for_timeout(200)
        print("MEASURE(1023B/99.9K):", await page.evaluate(MEASURE))
        # 英文状态字宽度实测（Running/Stopped 是最长语言变体）
        en = await page.evaluate("""() => {
          const st = document.querySelector('.rail-state');
          const b = st.querySelector('b');
          const out = {};
          b.textContent = 'Running'; out.run = [st.scrollWidth, st.clientWidth];
          b.textContent = 'Stopped'; out.stop = [st.scrollWidth, st.clientWidth];
          b.textContent = '运行中';
          return out;
        }""")
        print("EN row:", en)
        await shot(page, "verify_running_3x")
        # 更长状态字符串（英文/最长 uptime）
        await page.evaluate(RUN, ["1023B", "1023B"])
        print("MEASURE(1023B both):", await page.evaluate(MEASURE))
        # 暗色
        await page.evaluate("document.documentElement.setAttribute('data-theme','dark')")
        await page.evaluate(RUN, ["1.2M", "356K"])
        await page.wait_for_timeout(250)
        await shot(page, "verify_dark_3x")
        await page.evaluate("document.documentElement.setAttribute('data-theme','light')")
        # 其他 Tab（208px 侧栏）
        await page.click('.nav-item:has-text("代理")')
        await page.wait_for_timeout(600)
        await shot(page, "verify_tab_proxies")
        print("MEASURE(proxies tab):", await page.evaluate(MEASURE))
        # 全窗观感
        await page.click('.nav-item:has-text("首页")')
        await page.wait_for_timeout(400)
        await page.screenshot(path=f"{OUT}/verify_fullwin.png")
        await browser.close()

asyncio.run(main())
