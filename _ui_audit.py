import asyncio, json, sys
from playwright.async_api import async_playwright

OUT = "D:/项目文件夹/代理工具/veyra-latest/_shots/audit2"
NAVS = [("home","首页"),("proxies","代理"),("profiles","订阅"),("connections","连接"),("rules","规则"),("logs","日志"),("tests","测试"),("settings","设置")]

async def main():
    results = {"pages": [], "console": [], "checks": []}
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width":1600,"height":900}, device_scale_factor=1)
        page = await ctx.new_page()
        page.on("console", lambda m: results["console"].append({"type":m.type,"text":m.text[:300]}) if m.type in ("error","warning") else None)
        page.on("pageerror", lambda e: results["console"].append({"type":"pageerror","text":str(e)[:300]}))
        await page.goto("http://127.0.0.1:5173/", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2600)

        # boot state
        splash = await page.query_selector(".boot-splash")
        results["checks"].append({"name":"boot-splash-visible","value": bool(splash)})

        for pid, label in NAVS:
            try:
                el = await page.query_selector(f'.nav-item:has-text("{label}"), [data-nav="{pid}"], button:has-text("{label}")')
                if not el:
                    # try sidebar text
                    el = await page.query_selector(f'text="{label}"')
                if el:
                    await el.click(timeout=3000)
                    await page.wait_for_timeout(900)
                await page.screenshot(path=f"{OUT}/{pid}.png")
                # capture body text metrics
                txt = await page.evaluate("document.body.innerText.slice(0,600)")
                results["pages"].append({"id":pid,"ok":bool(el),"text":txt})
            except Exception as e:
                results["pages"].append({"id":pid,"ok":False,"err":str(e)[:200]})

        # horizontal overflow check per nav
        await page.evaluate("window.scrollTo(0,0)")
        for pid, label in NAVS:
            try:
                await page.click(f'text="{label}"', timeout=2000)
                await page.wait_for_timeout(500)
                ow = await page.evaluate("({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth, sh:document.documentElement.scrollHeight, ch:document.documentElement.clientHeight})")
                results["checks"].append({"name":f"overflow-{pid}","value":ow})
            except Exception as e:
                results["checks"].append({"name":f"overflow-{pid}","value":str(e)[:120]})

        await browser.close()
    with open("D:/项目文件夹/代理工具/veyra-latest/_shots/audit2/report.json","w",encoding="utf-8") as f:
        json.dump(results,f,ensure_ascii=False,indent=1)
    errs = [c for c in results["console"] if c["type"] in ("error","pageerror")]
    print("console errors:", len(errs))
    for c in errs[:12]: print(" -", c["type"], c["text"][:160])
    print("warnings:", sum(1 for c in results["console"] if c["type"]=="warning"))
    print("pages ok:", sum(1 for p in results["pages"] if p.get("ok")), "/", len(NAVS))

asyncio.run(main())
