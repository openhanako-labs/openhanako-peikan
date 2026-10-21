import asyncio

async def main():
    from patchright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1180, "height": 1200}, device_scale_factor=2)
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)

        await page.goto("http://127.0.0.1:7803/studio.html")
        await page.wait_for_timeout(2000)
        await page.click('a[data-tab="settings"]')
        await page.wait_for_timeout(2000)

        before = await page.evaluate("(document.querySelector('#persona-box')||{}).value || ''")
        print("原始长度:", len(before))

        # 在框里打字（模拟用户编辑）
        await page.click("#persona-box")
        await page.keyboard.press("End")
        await page.keyboard.type("【我加的测试尾巴】")
        await page.wait_for_timeout(400)
        typed = await page.evaluate("(document.querySelector('#persona-box')||{}).value || ''")
        print("打字后长度:", len(typed), "| 含测试串:", "【我加的测试尾巴】" in typed)

        st1 = await page.evaluate("(document.querySelector('#persona-status')||{}).textContent || ''")
        print("状态:", st1.strip())

        # 切走再切回（这是用户说的「来回点击」）
        await page.click('a[data-tab="notes"]')
        await page.wait_for_timeout(800)
        await page.click('a[data-tab="settings"]')
        await page.wait_for_timeout(1500)

        after = await page.evaluate("(document.querySelector('#persona-box')||{}).value || ''")
        print("切回后长度:", len(after), "| 测试串还在:", "【我加的测试尾巴】" in after)

        # 再等一个自动刷新周期（60s 太久，手动触发 loadAll）
        await page.evaluate("document.getElementById('refresh')?.click()")
        await page.wait_for_timeout(1500)
        after2 = await page.evaluate("(document.querySelector('#persona-box')||{}).value || ''")
        print("手动刷新后:", len(after2), "| 测试串还在:", "【我加的测试尾巴】" in after2)

        print("JS 错误:", errs if errs else "无")
        await b.close()

asyncio.run(main())
