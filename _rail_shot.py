"""截图脚本：侧栏「系统状态」面板 — 800/1150 两档窗口高度 + 运行态 DOM 注入 + 暗色。
用法： python _rail_shot.py before|after [tag]
输出： _shots/railcheck/{tag}_{state}_{h}.png  + {tag}_sidebar_{h}.png / {tag}_full_{h}.png
"""
import asyncio, sys
from playwright.async_api import async_playwright

TAG = sys.argv[1] if len(sys.argv) > 1 else "shot"
OUT = "D:/项目文件夹/代理工具/veyra-latest/_shots/railcheck"

RUNNING_JS = r"""
() => {
  // 模拟运行态：状态行/胶囊/明细行 + 两条真实形态的 sparkline
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
  // 速率值：模拟真实流量数值
  const vals = document.querySelectorAll('.rail-ratecard strong');
  if (vals[0]) { vals[0].textContent = __DOWN__; vals[0].classList.remove('idle'); }
  if (vals[1]) { vals[1].textContent = __UP__; vals[1].classList.remove('idle'); }
  // 明细行注入运行态数值
  const facts = document.querySelectorAll('.rail-fact strong');
  if (facts[0]) { facts[0].textContent = '开启'; facts[0].classList.add('on'); }
  if (facts[2]) { facts[2].textContent = '23'; facts[2].classList.add('on'); }
  if (facts[3]) facts[3].textContent = '82 MB';
}
"""

async def main():
    down = "'12.4 MB/s'" if TAG == "before" else "'1.2M'"
    up = "'1.0 KB/s'" if TAG == "before" else "'356K'"
    js = RUNNING_JS.replace("__DOWN__", down).replace("__UP__", up)
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        for h in (800, 1150):
            ctx = await browser.new_context(viewport={"width": 1600, "height": h}, device_scale_factor=1)
            page = await ctx.new_page()
            await page.goto("http://127.0.0.1:5173/", wait_until="networkidle", timeout=30000)
            await page.wait_for_timeout(2600)
            # 关闭启动骨架
            await page.evaluate("document.querySelector('.boot-splash')?.remove()")
            # 停止态
            await page.screenshot(path=f"{OUT}/{TAG}_stopped_{h}.png")
            side = await page.query_selector(".col-sidebar")
            if side:
                box = await side.bounding_box()
                pad = 14
                clip = {"x": max(0, box["x"] - pad), "y": max(0, box["y"] - pad),
                        "width": min(box["width"] + pad * 2, 1600 - box["x"] + pad),
                        "height": min(box["height"] + pad * 2, h - box["y"] + pad)}
                await page.screenshot(path=f"{OUT}/{TAG}_sidebar_{h}.png", clip=clip)
            # 运行态注入
            await page.evaluate(js)
            await page.wait_for_timeout(300)
            await page.screenshot(path=f"{OUT}/{TAG}_running_{h}.png")
            if side:
                await page.screenshot(path=f"{OUT}/{TAG}_sidebar_run_{h}.png", clip=clip)
            # 面板测量
            m = await page.evaluate("""() => {
              const panel = document.querySelector('.rail-status-panel');
              const r = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
              const kids = [...panel.children].map(el => [el.className, ...r(el)]);
              const vals = [...panel.querySelectorAll('.rail-ratecard strong')].map(el => ({
                t: el.textContent, sw: el.scrollWidth, cw: el.clientWidth, clip: el.scrollWidth > el.clientWidth + 1 }));
              const band = document.querySelector('.rail-chart');
              const pb = panel.getBoundingClientRect(), bb = band.getBoundingClientRect();
              return { panel: r(panel), kids, vals,
                bandBleed: { left: Math.round(bb.x - pb.x), right: Math.round(pb.right - bb.right), bottom: Math.round(pb.bottom - bb.bottom) },
                bodyOverflow: document.querySelector('.col-sidebar .card-body').scrollHeight >
                              document.querySelector('.col-sidebar .card-body').clientHeight + 1 };
            }""")
            print(f"--- h={h} ---")
            print(m)
            # 暗色
            await page.evaluate("document.documentElement.setAttribute('data-theme','dark')")
            await page.wait_for_timeout(300)
            await page.screenshot(path=f"{OUT}/{TAG}_dark_run_{h}.png")
            await ctx.close()
        await browser.close()

asyncio.run(main())
