"""Take a screenshot of the latest rail-monitor layout."""
import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1600, "height": 900})
        await page.goto("http://127.0.0.1:5173/", wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)
        
        # Screenshot the sidebar to see rail-monitor
        sidebar = await page.query_selector(".col-sidebar")
        if sidebar:
            await sidebar.screenshot(path=r"D:\veyra-latest\_shots\check-rail-monitor.png")
            print("Sidebar saved")
        
        # Also screenshot full home
        await page.screenshot(path=r"D:\veyra-latest\_shots\check-home-latest.png", full_page=False)
        print("Full home saved")
        
        await browser.close()

asyncio.run(main())
