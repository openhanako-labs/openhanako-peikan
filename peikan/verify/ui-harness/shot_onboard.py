import asyncio

async def main():
    from patchright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1180, "height": 1100}, device_scale_factor=2)
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)

        # 连开三次，看引导是否每次闪
        for i in range(3):
            await page.goto("http://127.0.0.1:7802/studio.html")
            # 早期（300ms）就看一眼，捕捉「闪」
            await page.wait_for_timeout(300)
            early = await page.evaluate("!!document.querySelector('#onboarding') && !document.querySelector('#onboarding').hidden")
            await page.wait_for_timeout(2500)
            late = await page.evaluate("!!document.querySelector('#onboarding') && !document.querySelector('#onboarding').hidden")
            print(f"第 {i+1} 次打开：300ms时可见={early} | 2.8s后可见={late}")

        print("JS 错误:", errs if errs else "无")
        await b.close()

asyncio.run(main())
