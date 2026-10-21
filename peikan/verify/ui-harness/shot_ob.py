import asyncio

async def main():
    from patchright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        errs = []

        # 1) Studio：引导条 + 标签
        page = await b.new_page(viewport={"width": 1400, "height": 1000}, device_scale_factor=2)
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await page.goto("http://127.0.0.1:7799/studio.html")
        await page.wait_for_timeout(2200)
        await page.screenshot(path="shots/_ob-studio.png")
        ob = await page.evaluate("!!document.querySelector('#onboarding') && !document.querySelector('#onboarding').hidden")
        sec = await page.text_content(".sec")
        print("引导条可见:", ob, "| 第一个 sec:", (sec or "").strip())

        # 2) 窄栏：字号
        p2 = await b.new_page(viewport={"width": 400, "height": 900}, device_scale_factor=2)
        await p2.goto("http://127.0.0.1:7799/panel.html")
        await p2.wait_for_timeout(2000)
        await p2.screenshot(path="shots/_ob-panel.png")
        fs = await p2.evaluate("getComputedStyle(document.body).fontSize")
        print("窄栏基础字号:", fs)

        print("JS 错误:", errs if errs else "无")
        await b.close()

asyncio.run(main())
