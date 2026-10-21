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

        # 头像是否真的加载出来（naturalWidth > 0）
        avatars = await page.evaluate("""() => {
          const imgs = [...document.querySelectorAll('.agent-card .av img')];
          return imgs.map(i => ({ src: i.getAttribute('src'), ok: i.naturalWidth > 0, w: i.naturalWidth }));
        }""")
        print("头像加载:", avatars)

        before = await page.evaluate("(document.querySelector('#persona-box')||{}).value?.slice(0,40) || ''")
        print("切换前人格开头:", repr(before))

        await page.screenshot(path="shots/_id-before.png")

        # 点第二个助手
        cards = await page.query_selector_all(".agent-card")
        if len(cards) >= 2:
            await cards[1].click()
            await page.wait_for_timeout(1500)
            after = await page.evaluate("(document.querySelector('#persona-box')||{}).value?.slice(0,40) || ''")
            st = await page.evaluate("(document.querySelector('#persona-status')||{}).textContent || ''")
            print("切换后人格开头:", repr(after))
            print("变化:", before != after)
            print("状态提示:", st.strip())
            await page.screenshot(path="shots/_id-after.png")

        print("JS 错误:", errs if errs else "无")
        await b.close()

asyncio.run(main())
