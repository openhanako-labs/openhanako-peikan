import asyncio

async def main():
    from patchright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1400, "height": 1400}, device_scale_factor=2)
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await page.goto("http://127.0.0.1:7800/studio.html")
        await page.wait_for_timeout(2000)
        await page.click('a[data-tab="settings"]')
        await page.wait_for_timeout(2500)
        await page.screenshot(path="shots/_identity.png")

        has_pick = await page.evaluate("!!document.querySelector('#agent-pick')")
        has_avatar = await page.evaluate("!!document.querySelector('#avatar-preview')")
        has_persona = await page.evaluate("!!document.querySelector('#persona-box')")
        cards = await page.evaluate("document.querySelectorAll('.agent-card').length")
        plen = await page.evaluate("(document.querySelector('#persona-box')||{}).value?.length || 0")
        print(f"助手选择:{has_pick} 头像:{has_avatar} 人格:{has_persona}")
        print(f"助手卡片数:{cards} 人格长度:{plen}")
        print("JS 错误:", errs if errs else "无")
        await b.close()

asyncio.run(main())
