import asyncio
import sys

sys.path.insert(0, r"C:\Users\Administrator\.hanako\app-data\bilibili-intake-v2\.runtime\venv-win\Lib\site-packages")
from patchright.async_api import async_playwright

PORT = 7800


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(channel="chrome")
        page = await b.new_page(viewport={"width": 1180, "height": 1100}, device_scale_factor=2)
        errs = []
        page.on("console", lambda m: errs.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append(f"[pageerror] {e}"))

        await page.goto(f"http://127.0.0.1:{PORT}/studio.html")
        await page.wait_for_timeout(2500)

        for tab in ["inbox", "learned", "ledger"]:
            await page.click(f'a[data-tab="{tab}"]')
            await page.wait_for_timeout(1600)
            await page.screenshot(path=f"shots/_r-{tab}.png")

            info = await page.evaluate("""(tid) => {
              const p = document.querySelector(`[data-panel="${tid}"]`);
              if (!p) return {missing: true};
              const rows = p.querySelectorAll('.rows > li').length;
              const scopes = p.querySelectorAll('.scope-list .row').length;
              const kv = p.querySelectorAll('.kv > div').length;
              const voidEl = p.querySelector('.void');
              const voidHidden = voidEl ? voidEl.hidden : null;
              // 内容是否占满可用宽度
              const inner = p.querySelector('.rows') || p.querySelector('.scope-list') || p.querySelector('.kv');
              const w = inner ? Math.round(inner.getBoundingClientRect().width) : 0;
              return {rows, scopes, kv, voidHidden, contentWidth: w, height: Math.round(p.getBoundingClientRect().height)};
            }""", tab)
            print(f"{tab:8s} {info}")

        print("\n错误:", errs if errs else "无")
        await b.close()


asyncio.run(main())
