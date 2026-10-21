import asyncio

PORT = 7792

async def main():
    import sys
    sys.path.insert(0, r"C:\Users\Administrator\.hanako\app-data\bilibili-intake-v2\.runtime\venv-win\Lib\site-packages")
    from patchright.async_api import async_playwright

    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1280, "height": 1100})
        failed = []
        page.on("requestfailed", lambda r: failed.append(f"FAILED {r.url}"))
        page.on("response", lambda r: failed.append(f"{r.status} {r.url}") if r.status >= 400 else None)

        await page.goto(f"http://127.0.0.1:{PORT}/studio.html")
        await page.wait_for_timeout(3000)
        await page.click('a[data-tab="inbox"]')
        await page.wait_for_timeout(1500)
        await page.click('a[data-tab="learned"]')
        await page.wait_for_timeout(1500)
        await page.click('a[data-tab="ledger"]')
        await page.wait_for_timeout(1500)

        print("=== 失败请求 ===")
        for x in failed:
            print(" ", x)
        if not failed:
            print("  无")
        await b.close()

asyncio.run(main())
