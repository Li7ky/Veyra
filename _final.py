import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1600, "height": 900})
        await page.goto("http://127.0.0.1:5173/", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)
        await page.screenshot(path=r"D:\veyra-latest\_shots\final-v1.1.2.png", full_page=False)
        print("Done")
        await browser.close()

asyncio.run(main())
