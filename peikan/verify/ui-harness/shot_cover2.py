import asyncio

async def main():
    from patchright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1400, "height": 1200}, device_scale_factor=2)
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        await page.goto("http://127.0.0.1:7810/studio.html")
        await page.wait_for_timeout(4000)
        await page.screenshot(path="shots/_cover-fix.png")

        r = await page.evaluate("""() => {
          const imgs = [...document.querySelectorAll('#notes-list img[data-cover]')];
          const loaded = imgs.filter(i => i.dataset.loaded === '1');
          const visible = imgs.filter(i => i.dataset.loaded === '1' && i.offsetParent !== null);
          return {
            total: imgs.length,
            loaded: loaded.length,
            visible: visible.length,
            sample: imgs.slice(0, 3).map(i => ({ loaded: i.dataset.loaded, src: (i.src||'').slice(0, 40) }))
          };
        }""")
        print("封面:", r)
        print("JS 错误:", errs[:3] if errs else "无")
        await b.close()

asyncio.run(main())
