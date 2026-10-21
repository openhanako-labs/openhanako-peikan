import asyncio

async def main():
    from patchright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1180, "height": 1500}, device_scale_factor=2)
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await page.goto("http://127.0.0.1:7801/studio.html")
        await page.wait_for_timeout(2500)

        # 引导条：不该出现在有数据的页面上
        ob = await page.evaluate("!!document.querySelector('#onboarding') && !document.querySelector('#onboarding').hidden")
        print("引导条可见（应为 False）:", ob)

        await page.click('a[data-tab="settings"]')
        await page.wait_for_timeout(2500)
        await page.screenshot(path="shots/_ui-final.png", full_page=True)

        cards = await page.evaluate("document.querySelectorAll('.agent-card').length")
        prev = await page.evaluate("document.querySelector('#avatar-preview')?.innerHTML || ''")
        plen = await page.evaluate("(document.querySelector('#persona-box')||{}).value?.length || 0")
        print(f"助手卡:{cards} | 人格:{plen} 字")
        print("JS 错误:", errs if errs else "无")
        await b.close()

asyncio.run(main())
