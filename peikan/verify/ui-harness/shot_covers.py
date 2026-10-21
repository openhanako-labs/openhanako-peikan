import asyncio

async def main():
    from patchright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1400, "height": 1200}, device_scale_factor=2)
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await page.goto("http://127.0.0.1:7804/studio.html")
        await page.wait_for_timeout(3000)
        await page.screenshot(path="shots/_covers.png")

        covers = await page.evaluate("""() => {
          const imgs = [...document.querySelectorAll('.list .cover img')];
          return imgs.slice(0, 6).map(i => ({
            src: i.getAttribute('src'),
            ok: i.naturalWidth > 0,
            w: i.naturalWidth
          }));
        }""")
        print("前 6 张封面:", covers)
        loaded = sum(1 for c in covers if c['ok'])
        print(f"加载成功: {loaded}/{len(covers)}")
        print("JS 错误:", errs[:3] if errs else "无")
        await b.close()

asyncio.run(main())
