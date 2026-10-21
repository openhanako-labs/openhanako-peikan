import asyncio
import sys

sys.path.insert(0, r"C:\Users\Administrator\.hanako\app-data\bilibili-intake-v2\.runtime\venv-win\Lib\site-packages")
from patchright.async_api import async_playwright

PORT = 7794


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1280, "height": 1400}, device_scale_factor=2)
        failed = []
        page.on("response", lambda r: failed.append(r.url) if r.status >= 400 else None)

        await page.goto(f"http://127.0.0.1:{PORT}/studio.html")
        await page.wait_for_timeout(2500)

        await page.click('a[data-tab="diary"]')
        await page.wait_for_timeout(1800)

        txt = await page.evaluate("() => (document.querySelector('#diary-list')||{}).textContent || ''")
        print("Invalid Date 还在吗:", "Invalid Date" in txt)
        print("前 240 字:", txt[:240].replace("\n", " "))
        print("失败请求:", [u.replace(f"http://127.0.0.1:{PORT}", "") for u in failed][:8] or "无")

        await page.screenshot(path="shots/_diary-fixed.png")

        # 顺便验证学到页的条状图
        await page.click('a[data-tab="learned"]')
        await page.wait_for_timeout(1500)
        learned = await page.evaluate("() => (document.querySelector('[data-panel=\"learned\"]')||{}).textContent || ''")
        print("\n学到页:", learned.replace("\n", " ")[:220])

        await b.close()


asyncio.run(main())
