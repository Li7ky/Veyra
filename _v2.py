import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1600, "height": 900})
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        try:
            await page.goto("http://127.0.0.1:5173/", wait_until="networkidle", timeout=30000)
            await page.wait_for_timeout(2000)
            sidebar = await page.query_selector(".col-sidebar")
            if sidebar:
                await sidebar.screenshot(path=r"D:\veyra-latest\_shots\v2-rate.png")
                print("Sidebar saved")
            if errors:
                print("ERRORS:")
                for e in errors[:5]:
                    print(f"  - {e}")
            else:
                print("No console errors")
        except Exception as e:
            print(f"Navigation failed: {e}")
        await browser.close()

asyncio.run(main())
