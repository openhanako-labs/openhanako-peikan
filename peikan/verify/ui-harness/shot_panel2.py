import asyncio

async def main():
    from patchright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 400, "height": 900}, device_scale_factor=2)
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await page.goto("http://127.0.0.1:7799/panel.html")
        await page.wait_for_timeout(2500)
        await page.screenshot(path="shots/_panel-7799.png")
        post = await page.text_content("#v-post")
        live = await page.text_content("#v-live")
        print("自主发布:", (post or "").strip(), "| 真发:", (live or "").strip())
        print("JS 错误:", errs if errs else "无")
        await b.close()

asyncio.run(main())
