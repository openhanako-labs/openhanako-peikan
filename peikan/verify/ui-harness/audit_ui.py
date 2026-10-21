import asyncio

PORT = 7794

async def main():
    import sys
    sys.path.insert(0, r"C:\Users\Administrator\.hanako\app-data\bilibili-intake-v2\.runtime\venv-win\Lib\site-packages")
    from patchright.async_api import async_playwright

    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1280, "height": 1400}, device_scale_factor=2)
        errs = []
        page.on("console", lambda m: errs.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append(f"[pageerror] {e}"))

        await page.goto(f"http://127.0.0.1:{PORT}/studio.html")
        await page.wait_for_timeout(2500)

        # 导航上到底有几个页签
        tabs = await page.evaluate("() => [...document.querySelectorAll('#nav a')].map(a => ({t: a.dataset.tab, txt: a.textContent.trim()}))")
        print("=== 导航页签 ===")
        for x in tabs:
            print(f"  {x['t']:10s} {x['txt']}")

        # 逐个点，看哪个是空的
        print("\n=== 逐页检查 ===")
        for x in tabs:
            tid = x["t"]
            await page.click(f'a[data-tab="{tid}"]')
            await page.wait_for_timeout(1200)
            info = await page.evaluate("""(tid) => {
              const panel = document.querySelector(`[data-panel="${tid}"]`);
              if (!panel) return {missing: true};
              const visible = panel.offsetParent !== null;
              const lis = panel.querySelectorAll('li').length;
              const btns = panel.querySelectorAll('button').length;
              const inputs = panel.querySelectorAll('input,select').length;
              const text = (panel.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
              const h = Math.round(panel.getBoundingClientRect().height);
              return {visible, lis, btns, inputs, h, text};
            }""", tid)
            print(f"  {tid:10s} 可见={info.get('visible')} li={info.get('lis')} 按钮={info.get('btns')} 输入={info.get('inputs')} 高={info.get('h')}")
            print(f"             「{info.get('text','')}」")

        # 新页签截图
        await page.click('a[data-tab="inbox"]')
        await page.wait_for_timeout(1500)
        await page.screenshot(path="shots/_ui-inbox2.png", full_page=True)
        await page.click('a[data-tab="learned"]')
        await page.wait_for_timeout(1500)
        await page.screenshot(path="shots/_ui-learned2.png", full_page=True)

        print("\n错误:", errs if errs else "无")
        await b.close()

asyncio.run(main())
