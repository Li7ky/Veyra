import asyncio, json
from playwright.async_api import async_playwright

OUT = "D:/项目文件夹/代理工具/veyra-latest/_shots/audit2"

def log(name, val):
    print("##", name, "=>", json.dumps(val, ensure_ascii=False)[:450], flush=True)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.connect_over_cdp('http://127.0.0.1:9223')
        pg = b.contexts[0].pages[0]
        await pg.wait_for_timeout(800)

        # 规则草稿保留（限定可见 pane 内定位）
        await pg.click('.nav-item:has-text("规则")')
        await pg.wait_for_timeout(1800)
        n0 = await pg.evaluate("document.querySelector('.pane:not([hidden]) .pf-list') ? document.querySelectorAll('.pane:not([hidden]) .pf-item').length : -1")
        first0 = await pg.evaluate("document.querySelector('.pane:not([hidden]) .pf-item .pf-item-name')?.innerText || ''")
        inp = pg.locator('.pane:not([hidden]) .import-bar input').first
        await inp.fill("DOMAIN-SUFFIX,ui-draft-check.com,PROXY")
        await pg.locator('.pane:not([hidden]) button:text-is("添加")').first.click()
        await pg.wait_for_timeout(600)
        n1 = await pg.evaluate("document.querySelectorAll('.pane:not([hidden]) .pf-item').length")
        first1 = await pg.evaluate("document.querySelector('.pane:not([hidden]) .pf-item .pf-item-name')?.innerText || ''")
        await pg.click('.nav-item:has-text("首页")'); await pg.wait_for_timeout(600)
        await pg.click('.nav-item:has-text("规则")'); await pg.wait_for_timeout(1000)
        n2 = await pg.evaluate("document.querySelectorAll('.pane:not([hidden]) .pf-item').length")
        first2 = await pg.evaluate("document.querySelector('.pane:not([hidden]) .pf-item .pf-item-name')?.innerText || ''")
        log("rules-draft", {"before": n0, "after_add": n1, "after_roundtrip": n2,
                            "first_add": first1, "first_roundtrip": first2,
                            "retained": n1 == n2 and first1 == first2 == "DOMAIN-SUFFIX,ui-draft-check.com,PROXY"})

        # 节点编辑草稿保留（子标签切换）
        await pg.click('.nav-item:has-text("订阅")'); await pg.wait_for_timeout(700)
        await pg.click('.pf-tabs button:has-text("节点编辑")'); await pg.wait_for_timeout(1200)
        inp2 = pg.locator('.pf-pane:not([hidden]) input').first
        await inp2.fill("AUDIT-DRAFT-123")
        await pg.click('.pf-tabs button:has-text("增强")'); await pg.wait_for_timeout(800)
        await pg.click('.pf-tabs button:has-text("节点编辑")'); await pg.wait_for_timeout(1100)
        v = await pg.evaluate("document.querySelector('.pf-pane:not([hidden]) input')?.value ?? '(no-input)'")
        log("nodes-draft-retained", v)

        await b.close()

asyncio.run(main())
