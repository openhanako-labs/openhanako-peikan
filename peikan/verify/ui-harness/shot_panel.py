import asyncio

async def main():
    from patchright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 420, "height": 800}, device_scale_factor=2)
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await page.goto("http://127.0.0.1:7798/panel.html")
        await page.wait_for_timeout(2500)
        await page.screenshot(path="shots/_panel-final.png")
        q = await page.text_content("#quota")
        print("配额格:", (q or "").replace("\n", " ").strip())
        w = await page.text_content("#v-wake")
        cls = await page.evaluate("document.getElementById('v-wake').className")
        print("醒过:", w, "| class:", cls)
        print("JS 错误:", errs if errs else "无")
        await b.close()

asyncio.run(main())
