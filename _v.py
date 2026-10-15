import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1600, "height": 900})
        await page.goto("http://127.0.0.1:5173/", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)
        sidebar = await page.query_selector(".col-sidebar")
        if sidebar:
            await sidebar.screenshot(path=r"D:\veyra-latest\_shots\v-rate-bands.png")
            print("Saved")
        await browser.close()

asyncio.run(main())
